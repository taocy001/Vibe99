// Browser render-debug harness (loaded ONLY by harness.html, never by the app).
//
// Provides a mock `window.vibe99` bridge so renderer.js boots the real render
// pipeline (xterm + WebglAddon + GraphemeUnicodeAddon) in a plain Chrome tab
// with no Tauri backend and no PTY. Everything the app draws is real; only the
// process I/O is faked. window.__h drives it and inspects the WebGL atlas.
//
// This runs BEFORE renderer.js because both are ordered module scripts and this
// tag comes first in harness.html.

// renderer.js calls getCurrentWebviewWindow() at module top level (for the
// window label). That reads __TAURI_INTERNALS__.metadata and throws without it.
// Stub the metadata only — do NOT set window.__TAURI__, or the bridge selection
// would switch to the real Tauri bridge instead of our mock.
window.__TAURI_INTERNALS__ = {
  metadata: {
    currentWindow: { label: 'main' },
    currentWebview: { label: 'main', windowLabel: 'main' },
  },
};

// Force preserveDrawingBuffer so screenshots and the pixel oracle can read the
// WebGL back buffer (xterm's WebglAddon otherwise leaves it swap-cleared, which
// reads back as all-black). Harness-only; the real app never loads this file.
const _origGetContext = HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.getContext = function (type, attrs) {
  if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') {
    attrs = Object.assign({}, attrs, { preserveDrawingBuffer: true });
  }
  return _origGetContext.call(this, type, attrs);
};

const noop = () => {};
const okp = (v) => Promise.resolve(v);

const H = (window.__h = {
  paneIds: [],
  dataHandler: null,
  exitHandler: null,
  nodes: null, // Map<paneId, node> — populated by renderer's guarded debug hook.

  // Feed raw terminal output (as the PTY would) into a pane.
  feed(data, paneId) {
    if (!H.dataHandler) throw new Error('harness: no terminal-data handler registered yet');
    H.dataHandler({ paneId: paneId || H.paneIds[0], data });
  },

  node(paneId) {
    return H.nodes?.get(paneId || H.paneIds[0]) || null;
  },

  // WebGL atlas introspection for the currently focused pane. Returns page
  // versions so we can assert the merge/version invariants that the garble bug
  // violates (see renderer.js atlas-eviction comment).
  atlas(paneId) {
    const addon = H.node(paneId)?.webglAddon;
    const pages = addon?._renderer?._charAtlas?.pages;
    if (!pages) return null;
    return {
      pageCount: pages.length,
      versions: pages.map((p) => p.version),
    };
  },

  // Pixel self-consistency oracle. Precondition: the screen was filled with a
  // pattern where a large set of cells are meant to be pixel-identical (same
  // glyph, fg, bg). We sample each such cell's rendered pixel block from the
  // WebGL canvas and flag any that diverge from the modal block — a divergence
  // is exactly the "garbled cell" failure mode (GPU texture desync), detectable
  // with no human eyes.
  //
  // Returns { cols, rows, sampled, mismatches:[{row,col,diff}], ok }.
  checkUniform(paneId) {
    const node = H.node(paneId);
    if (!node) throw new Error('harness: no node');
    const term = node.terminal;
    const cols = term.cols, rows = term.rows;
    const canvas = node.terminalHost.querySelector('.xterm-screen canvas');
    if (!canvas) throw new Error('harness: no webgl canvas');

    // Snapshot the WebGL canvas into a 2D canvas we can read pixels from.
    const w = canvas.width, h = canvas.height;
    const snap = document.createElement('canvas');
    snap.width = w; snap.height = h;
    const ctx = snap.getContext('2d');
    ctx.drawImage(canvas, 0, 0);
    const img = ctx.getImageData(0, 0, w, h).data;

    const cw = w / cols, chh = h / rows;
    // Sample a small grid of points inside each cell and hash them.
    const sampleCell = (r, c) => {
      const x0 = Math.floor(c * cw), y0 = Math.floor(r * chh);
      let key = '';
      for (let sy = 2; sy < chh - 2; sy += 3) {
        for (let sx = 2; sx < cw - 2; sx += 3) {
          const px = ((y0 + sy | 0) * w + (x0 + sx | 0)) * 4;
          // Quantize to reduce AA noise.
          key += String.fromCharCode(
            (img[px] >> 4), (img[px + 1] >> 4), (img[px + 2] >> 4));
        }
      }
      return key;
    };

    // Only compare cells that share the same buffer content+attrs. Build groups.
    const buf = term.buffer.active;
    const groups = new Map(); // signature -> [{r,c,key}]
    for (let r = 0; r < rows; r++) {
      const line = buf.getLine(r);
      if (!line) continue;
      for (let c = 0; c < cols; c++) {
        const cell = line.getCell(c);
        if (!cell) continue;
        const chars = cell.getChars();
        if (chars === '' || chars === ' ') continue; // skip blanks
        const sig = chars + '|' + cell.getFgColor() + '|' + cell.getBgColor()
          + '|' + cell.isBold() + '|' + cell.getWidth();
        (groups.get(sig) || groups.set(sig, []).get(sig)).push({ r, c });
      }
    }

    const mismatches = [];
    let sampled = 0;
    for (const [sig, cells] of groups) {
      if (cells.length < 2) continue;
      const keys = cells.map(({ r, c }) => ({ r, c, key: sampleCell(r, c) }));
      sampled += keys.length;
      // Modal key = the rendering the majority agree on.
      const counts = new Map();
      for (const k of keys) counts.set(k.key, (counts.get(k.key) || 0) + 1);
      let modal = null, best = -1;
      for (const [k, n] of counts) if (n > best) { best = n; modal = k; }
      for (const k of keys) {
        if (k.key !== modal) mismatches.push({ row: k.r, col: k.c, sig });
      }
    }
    return { cols, rows, groups: groups.size, sampled, mismatches, ok: mismatches.length === 0 };
  },
});

window.vibe99 = {
  platform: 'darwin',
  defaultCwd: '/harness',
  defaultTabTitle: 'harness',
  createTerminal: (p) => { if (!H.paneIds.includes(p.paneId)) H.paneIds.push(p.paneId); return okp(); },
  writeTerminal: noop,
  resizeTerminal: () => okp(),
  setTerminalPaused: () => okp(),
  destroyTerminal: () => okp(),
  closeWindow: noop,
  newWindow: noop,
  exitApp: noop,
  readClipboardText: () => okp(''),
  writeClipboardText: noop,
  getClipboardSnapshot: () => ({ text: '', hasImage: false }),
  openExternalUrl: noop,
  showContextMenu: noop,
  loadSettings: () => okp({}),
  saveSettings: () => okp({}),
  listShellProfiles: () => okp({ profiles: [], defaultProfile: '' }),
  addShellProfile: noop,
  removeShellProfile: noop,
  setDefaultShellProfile: noop,
  detectShellProfiles: () => okp([]),
  readSshConfig: () => okp([]),
  installShellIntegration: () => okp(),
  setWindowTheme: () => okp(),
  setWindowTitle: () => okp(),
  getSystemInfo: () => okp({ username: 'demo', hostname: 'harness' }),
  sendNotification: () => okp(),
  onTerminalData: (h) => { H.dataHandler = h; return noop; },
  onTerminalExit: (h) => { H.exitHandler = h; return noop; },
  onMenuAction: () => noop,
  onOpenSettings: () => noop,
  cwdReady: okp(),
  listenersReady: okp(),
};
