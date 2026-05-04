// Thin orchestrator — wires together terminal-bridge, settings-ui, pane-manager,
// and layout-renderer. Owns terminal creation, bridge I/O, search, context menus,
// and keyboard dispatch. Everything else lives in the imported modules.

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { ImageAddon } from '@xterm/addon-image';
import {
  openCommandPalette,
  closeCommandPalette,
  isCommandPaletteOpen,
} from './command-palette.js';
import { createPaneActivityWatcher } from './pane-activity-watcher.js';
import { createBreathingMaskAlert } from './pane-alert-breathing-mask.js';
import '@xterm/xterm/css/xterm.css';

import * as ShortcutsRegistry from './shortcuts-registry.js';
import * as ShortcutsUI from './shortcuts-ui.js';
import * as ColorsRegistry from './colors-registry.js';
import { createActions } from './input/actions.js';
import { createDispatcher } from './input/dispatcher.js';
import { showContextMenu, hideContextMenu } from './context-menu.js';
import { t } from './i18n.js';
import {
  collectPanelIds,
  deserializeLayout,
  MIN_RATIO,
  MAX_RATIO,
} from './split-layout.js';

import {
  createTauriBridge,
  createUnavailableBridge,
  getDefaultFontFamily,
} from './terminal-bridge.js';
import {
  settings,
  createTerminalTheme,
  fixXtermViewportBg,
  createSettingsUI,
} from './settings-ui.js';
import {
  getTabLayout,
  getPreviewWidth,
  getPaneLeft,
  createPaneManager,
} from './pane-manager.js';
import { createLayoutRenderer } from './layout-renderer.js';

// ── Bridge ────────────────────────────────────────────────────────────────────
const bridge = window.__TAURI__
  ? createTauriBridge(window.__TAURI__)
  : window.vibe99 ?? createUnavailableBridge();

// ── Initial panes ─────────────────────────────────────────────────────────────
const _initialPanes = [
  { id: 'p1', title: null, terminalTitle: bridge.defaultTabTitle, cwd: bridge.defaultCwd, accent: ColorsRegistry.ACCENT_PALETTE[0], shellProfileId: null, layout: null, focusedPanelId: 'p1' },
  { id: 'p2', title: null, terminalTitle: bridge.defaultTabTitle, cwd: bridge.defaultCwd, accent: ColorsRegistry.ACCENT_PALETTE[1], shellProfileId: null, layout: null, focusedPanelId: 'p2' },
  { id: 'p3', title: null, terminalTitle: bridge.defaultTabTitle, cwd: bridge.defaultCwd, accent: ColorsRegistry.ACCENT_PALETTE[2], shellProfileId: null, layout: null, focusedPanelId: 'p3' },
];

// ── Shared mutable state ──────────────────────────────────────────────────────
// All modules receive a reference so mutations propagate across boundaries.
const st = {
  panes: _initialPanes.map((p) => ({ ...p })),
  focusedPaneId: 'p1',
  nextPaneNumber: 4,
  nextPanelSeq: 1,
  renamingPaneId: null,
  isRenderingTabs: false,
  dragState: null,
  currentMode: 'terminal',
  enterNavSourcePaneId: null,
  pendingTabFocus: null,
  sessionRestoreComplete: false,
  paneMruOrder: ['p1', 'p2', 'p3'],
  paneCycleState: null,
  pendingClosePaneId: null,
};

// ── Shared data structures ────────────────────────────────────────────────────
const paneNodeMap = new Map();
const panelDataMap = new Map();
const activeCwdMap = new Map();
const splitDividerElMap = new Map();
const splitDividerDataMap = new WeakMap();

// ── DOM references ────────────────────────────────────────────────────────────
const stageEl = document.getElementById('stage');
const tabsListEl = document.getElementById('tabs-list');
const statusLabelEl = document.getElementById('status-label');
const statusHintEl = document.getElementById('status-hint');
const broadcastIndicatorEl = document.getElementById('broadcast-indicator');
const addPaneButtonEl = document.getElementById('tabs-add');

const MAX_DIVIDERS = 10;
const dividerEls = Array.from({ length: MAX_DIVIDERS }, () => {
  const el = document.createElement('div');
  el.className = 'pane-divider';
  el.style.display = 'none';
  stageEl.appendChild(el);
  return el;
});

// ── Search bar ────────────────────────────────────────────────────────────────
const searchBarEl = document.getElementById('search-bar');
const searchInputEl = document.getElementById('search-input');
const searchCountEl = document.getElementById('search-count');
const searchPrevEl = document.getElementById('search-prev');
const searchNextEl = document.getElementById('search-next');
const searchCloseEl = document.getElementById('search-close');

// ── Activity monitoring ───────────────────────────────────────────────────────
const paneAlert = createBreathingMaskAlert();
const paneActivityWatcher = createPaneActivityWatcher({
  onAlert: (paneId) => {
    const node = paneNodeMap.get(paneId);
    if (node) paneAlert.setAlerted(node.root, true);
  },
  onClear: (paneId) => {
    const node = paneNodeMap.get(paneId);
    if (node) paneAlert.setAlerted(node.root, false);
  },
});

// ── Broadcast ─────────────────────────────────────────────────────────────────
let broadcastEnabled = false;

function setBroadcastEnabled(enabled) {
  broadcastEnabled = enabled;
  broadcastIndicatorEl?.classList.toggle('is-active', enabled);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function reportError(error) {
  const message = error instanceof Error ? error.message : String(error);
  statusLabelEl.textContent = `Error: ${message}`;
  statusHintEl.textContent = '';
  console.error(error);
}

function abbreviatePath(path) {
  if (!path) return '';
  const home = bridge.defaultCwd;
  if (!home) return path;
  if (path === home) return '~';
  if (path.startsWith(home + '/') || path.startsWith(home + '\\')) return '~' + path.slice(home.length);
  return path;
}

function validCwd(cwd) {
  if (typeof cwd !== 'string' || !cwd || cwd === '/' || cwd === '.') return bridge.defaultCwd;
  return cwd;
}

function isWindowsCtrlVPasteHotkey(event) {
  return bridge.platform === 'win32' && event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'v';
}

function isLinkOpenModifierPressed(event) {
  return event.ctrlKey || (bridge.platform === 'darwin' && event.metaKey);
}

function handleTerminalLinkActivation(event, uri) {
  if (!isLinkOpenModifierPressed(event)) return;
  event.preventDefault();
  event.stopPropagation();
  void bridge.openExternalUrl(uri).catch(reportError);
}

// ── Terminal lifecycle ────────────────────────────────────────────────────────

function destroyPanelNode(panelId, node, { destroyTerminal = true } = {}) {
  if (!searchBarEl?.classList.contains('is-hidden') && st.focusedPaneId === panelId) {
    node.searchAddon?.clearDecorations();
  }
  node.abortCtrl.abort();
  paneActivityWatcher.forget(panelId);
  if (destroyTerminal) bridge.destroyTerminal({ paneId: panelId });
  node.terminal.dispose();
  node.root.remove();
  paneNodeMap.delete(panelId);
  panelDataMap.delete(panelId);
  activeCwdMap.delete(panelId);
}

function entryNeedsTabRefresh(paneId) {
  const pane = st.panes.find((entry) => entry.id === paneId);
  return Boolean(pane && pane.title === null);
}

function fitTerminal(node, force = false) {
  node.terminal.options.fontSize = settings.fontSize;
  node.terminal.options.fontFamily = settings.fontFamily || getDefaultFontFamily(bridge.platform);
  node.fitAddon.fit();
  const cols = Math.max(20, node.terminal.cols || 80);
  const rows = Math.max(8, node.terminal.rows || 24);
  const nextSizeKey = `${cols}x${rows}`;
  if (node.sessionReady && (force || nextSizeKey !== node.sizeKey)) {
    bridge.resizeTerminal({ paneId: node.paneId, cols, rows });
    paneActivityWatcher.noteResize(node.paneId);
  }
  node.sizeKey = nextSizeKey;
  node.needsFit = false;
}

async function initializePaneTerminal(node) {
  if (!paneNodeMap.has(node.paneId)) return;
  fitTerminal(node, true);
  const pane = st.panes.find((p) => p.id === node.paneId);
  const panelData = panelDataMap.get(node.paneId);
  const profileId = pane?.shellProfileId ?? panelData?.shellProfileId ?? null;
  try {
    await bridge.createTerminal({
      paneId: node.paneId,
      cols: node.terminal.cols,
      rows: node.terminal.rows,
      cwd: node.cwd,
      shellProfileId: profileId,
    });
    node.sessionReady = true;
    fitTerminal(node, true);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    node.terminal.writeln(`\x1b[38;5;204mFailed to start shell${profileId ? ` "${profileId}"` : ''}: ${message}\x1b[0m`);
  }
}

function ensurePaneNodes() {
  const activeIds = new Set();
  for (const pane of st.panes) {
    for (const panelId of collectPanelIds(getTabLayout(pane))) activeIds.add(panelId);
  }
  for (const [panelId, node] of paneNodeMap.entries()) {
    if (!activeIds.has(panelId)) destroyPanelNode(panelId, node);
  }
  for (const pane of st.panes) {
    const panelIds = collectPanelIds(getTabLayout(pane));
    for (const panelId of panelIds) {
      if (paneNodeMap.has(panelId)) continue;
      const isPrimary = panelId === pane.id;
      let node;
      if (isPrimary) {
        node = createPane(pane);
      } else {
        const pd = panelDataMap.get(panelId) ?? {
          cwd: pane.cwd,
          shellProfileId: pane.shellProfileId ?? null,
          accent: pane.accent,
          breathingMonitor: pane.breathingMonitor !== false,
        };
        node = createPane(
          { id: panelId, cwd: pd.cwd, accent: pd.accent ?? pane.accent, customColor: undefined, breathingMonitor: pd.breathingMonitor !== false },
          { tabId: pane.id },
        );
      }
      paneNodeMap.set(panelId, node);
      stageEl.append(node.root);
      paneActivityWatcher.setPaneEnabled(
        panelId,
        isPrimary ? (pane.breathingMonitor !== false) : (panelDataMap.get(panelId)?.breathingMonitor !== false),
      );
      requestAnimationFrame(() => { initializePaneTerminal(node); });
    }
  }
}

// ── Module forward references (needed for circular wiring) ────────────────────
// createPane references paneManager and layoutRenderer which are created after it.
// JS closures capture by reference, so the forward refs are valid as long as the
// functions aren't called until after module initialization completes.
let paneManager;
let settingsUI;
let layoutRenderer;

// ── createPane ────────────────────────────────────────────────────────────────

function createPane(pane, { tabId = null } = {}) {
  const owningTabId = tabId ?? pane.id;
  const isSplitPanel = tabId !== null;
  if (pane.cwd) activeCwdMap.set(pane.id, pane.cwd);

  const abortCtrl = new AbortController();
  const { signal } = abortCtrl;

  const paneEl = document.createElement('article');
  paneEl.className = 'pane';
  const accentColor = pane.customColor || pane.accent;
  paneEl.style.setProperty('--pane-accent', accentColor);
  paneEl.addEventListener('transitionend', (e) => {
    if (e.propertyName === 'transform') paneEl.style.willChange = '';
  }, { signal });
  paneEl.addEventListener('click', () => {
    paneManager.focusSplitPanel(pane.id);
  }, { signal });

  const panelHeader = document.createElement('div');
  panelHeader.className = 'panel-header';
  const panelDragHandle = document.createElement('div');
  panelDragHandle.className = 'panel-title';
  panelDragHandle.dataset.panelId = pane.id;
  const panelTitleText = document.createElement('span');
  panelTitleText.className = 'panel-title-text';
  panelDragHandle.append(panelTitleText);
  const panelCloseBtn = document.createElement('button');
  panelCloseBtn.type = 'button';
  panelCloseBtn.className = 'panel-close';
  panelCloseBtn.textContent = '×';
  panelCloseBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    paneManager.focusSplitPanel(pane.id, { focusTerminal: false });
    paneManager.closeActivePanel();
  });
  panelHeader.append(panelDragHandle, panelCloseBtn);

  const shell = document.createElement('div');
  shell.className = 'pane-shell';
  const body = document.createElement('div');
  body.className = 'pane-body';
  const surface = document.createElement('div');
  surface.className = 'pane-surface';
  const terminalHost = document.createElement('div');
  terminalHost.className = 'terminal-host';
  surface.append(terminalHost);
  body.append(surface);
  paneAlert.attach(paneEl, body);
  shell.append(body);
  paneEl.append(panelHeader, shell);

  const terminal = new Terminal({
    allowProposedApi: true,
    allowTransparency: true,
    convertEol: false,
    customGlyphs: true,
    cursorBlink: true,
    disableStdin: false,
    drawBoldTextInBrightColors: false,
    fontFamily: settings.fontFamily || getDefaultFontFamily(bridge.platform),
    fontSize: settings.fontSize,
    lineHeight: 1.2,
    scrollback: settings.scrollback,
    theme: createTerminalTheme(accentColor),
  });
  const fitAddon = new FitAddon();
  const searchAddon = new SearchAddon();
  const webLinksAddon = new WebLinksAddon(handleTerminalLinkActivation);
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(searchAddon);
  searchAddon.onDidChangeResults(({ resultIndex, resultCount }) => {
    if (searchBarEl.classList.contains('is-hidden')) return;
    if (st.focusedPaneId !== pane.id) return;
    const term = searchInputEl.value;
    if (!term) return;
    if (resultCount === 0) {
      searchCountEl.textContent = 'No results';
    } else if (resultIndex === -1) {
      searchCountEl.textContent = `${resultCount}+`;
    } else {
      searchCountEl.textContent = `${resultIndex + 1} / ${resultCount}`;
    }
    searchInputEl.classList.toggle('no-match', resultCount === 0);
  });
  terminal.loadAddon(webLinksAddon);
  // Unicode 11 width tables align xterm.js's wcwidth with what modern CLI
  // apps (Node.js / Ink-based UIs like Claude Code) assume, so CJK
  // characters reliably consume two cells instead of drifting between one
  // and two when an app redraws after IME input.
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = '11';
  terminal.open(terminalHost);
  fixXtermViewportBg(terminalHost, settings.colorMode);
  terminal.loadAddon(new ImageAddon());
  try { terminal.loadAddon(new WebglAddon()); } catch {}

  // xterm.js 6.x multiplies trackpad scroll delta by 0.3 (heuristic for small
  // per-event deltas), which makes scrolling unusably slow on ProMotion displays
  // that fire events at 120 Hz with proportionally smaller deltas.  We intercept
  // wheel events in the capture phase — before xterm's bubble-phase listener on
  // the inner canvas — and implement a clean delta→lines conversion that skips
  // the 0.3 penalty while still accumulating fractional lines correctly.
  let _scrollAccum = 0;
  terminalHost.addEventListener('wheel', (ev) => {
    if (ev.deltaY === 0) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    const fastMult = (ev.altKey || ev.ctrlKey || ev.shiftKey)
      ? (terminal.options.fastScrollSensitivity ?? 5) : 1;
    let lines;
    if (ev.deltaMode === WheelEvent.DOM_DELTA_LINE) {
      lines = ev.deltaY * fastMult;
    } else if (ev.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
      lines = Math.round(ev.deltaY * terminal.rows * fastMult);
    } else {
      const pixelsPerLine = terminal.options.fontSize * terminal.options.lineHeight;
      _scrollAccum += (ev.deltaY / pixelsPerLine) * fastMult;
      lines = Math.trunc(_scrollAccum);
      _scrollAccum -= lines;
    }
    if (lines !== 0) terminal.scrollLines(lines);
  }, { capture: true, passive: false, signal });

  terminal.attachCustomKeyEventHandler((event) => {
    if (event.type === 'keydown' && event.ctrlKey && !event.metaKey && !event.altKey && event.code === 'Tab') return false;
    if (event.type === 'keydown' && event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey &&
        (event.key === 'C' || event.key === 'c' || event.key === 'V' || event.key === 'v')) return false;
    if (!isWindowsCtrlVPasteHotkey(event)) return true;
    return false;
  });

  const node = {
    paneId: pane.id,
    cwd: pane.cwd,
    root: paneEl,
    terminalHost,
    terminal,
    fitAddon,
    searchAddon,
    titleEl: panelTitleText,
    sessionReady: false,
    sizeKey: '',
    needsFit: true,
    accent: pane.accent,
    shellCmdMarker: null,
    abortCtrl,
  };

  terminalHost.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    paneManager.focusSplitPanel(node.paneId, { focusTerminal: false });
    void showTerminalContextMenu(node, event);
  }, { signal });

  terminal.onData((data) => {
    if (!node.sessionReady) return;
    if (broadcastEnabled) {
      for (const pnode of paneNodeMap.values()) {
        if (pnode.sessionReady) bridge.writeTerminal({ paneId: pnode.paneId, data });
      }
    } else {
      bridge.writeTerminal({ paneId: node.paneId, data });
    }
  });

  terminal.onTitleChange((nextTitle) => {
    const trimmedTitle = nextTitle.trim();
    if (!trimmedTitle) return;
    st.panes = st.panes.map((entry) =>
      entry.id === owningTabId ? { ...entry, terminalTitle: trimmedTitle } : entry
    );
    if (entryNeedsTabRefresh(owningTabId)) layoutRenderer.renderTabs();
  });

  terminal.onSelectionChange(() => {
    const selection = terminal.getSelection();
    if (selection) bridge.writeClipboardText(selection);
  });

  // OSC 7 — shell reports current working directory.
  terminal.parser.registerOscHandler(7, (data) => {
    let path = data;
    try {
      const url = new URL(data);
      if (url.protocol === 'file:') path = decodeURIComponent(url.pathname);
    } catch {}
    path = path.trim();
    if (!path || path === '/') return true;
    activeCwdMap.set(pane.id, path);
    if (isSplitPanel) {
      const pd = panelDataMap.get(pane.id);
      if (pd) pd.cwd = path;
    } else {
      st.panes = st.panes.map(p => p.id === owningTabId ? { ...p, cwd: path } : p);
    }
    const titleNode = paneNodeMap.get(pane.id);
    if (titleNode?.titleEl) titleNode.titleEl.textContent = abbreviatePath(path) || '~';
    const focusedPane = st.panes[paneManager.getFocusedIndex()];
    const activePanelId = focusedPane?.focusedPanelId ?? focusedPane?.id;
    if (activePanelId === pane.id) layoutRenderer.updateStatus();
    return true;
  });

  // OSC 52 — set clipboard from terminal
  terminal.parser.registerOscHandler(52, (data) => {
    const semicolon = data.indexOf(';');
    if (semicolon === -1) return true;
    const base64Text = data.slice(semicolon + 1);
    if (!base64Text || base64Text === '?') return true;
    try {
      const bytes = atob(base64Text);
      const text = new TextDecoder().decode(Uint8Array.from(bytes, (c) => c.charCodeAt(0)));
      bridge.writeClipboardText(text);
    } catch {}
    return true;
  });

  // OSC 133 — shell integration: command start/end markers
  terminal.parser.registerOscHandler(133, (data) => {
    if (data === 'C') {
      node.shellCmdMarker = terminal.registerMarker(0);
    } else if (data === 'D' || data.startsWith('D;')) {
      const exitCode = data.length > 2 ? parseInt(data.slice(2), 10) : 0;
      const marker = node.shellCmdMarker;
      if (marker) {
        terminal.registerDecoration({
          marker,
          overviewRulerOptions: { color: exitCode === 0 ? '#30D158' : '#FF453A', position: 'right' },
        });
        node.shellCmdMarker = null;
      }
    }
    return true;
  });

  return node;
}

// ── Module initialization ─────────────────────────────────────────────────────

paneManager = createPaneManager(st, {
  bridge,
  settings,
  paneNodeMap,
  panelDataMap,
  activeCwdMap,
  tabsListEl,
  onRender: (refit = false) => layoutRenderer?.render(refit),
  onDestroyPanel: destroyPanelNode,
  onInitializePaneTerminal: initializePaneTerminal,
  reportError,
});

settingsUI = createSettingsUI({
  bridge,
  st,
  paneNodeMap,
  panelDataMap,
  paneActivityWatcher,
  onRender: (refit = false) => layoutRenderer?.render(refit),
  onUpdateStatus: () => layoutRenderer?.updateStatus(),
  initializePaneTerminal,
  reportError,
});

const {
  applyPersistedSettings,
  applySettings,
  applyColorMode,
  applyColorModeUI,
  applyTranslations,
  scheduleSettingsSave,
  flushSettingsSave,
  buildSessionData,
  openSettingsToTab,
  openSubPageModal,
  loadShellProfiles,
  restartPane,
  changePaneShell,
} = settingsUI;

layoutRenderer = createLayoutRenderer(st, {
  bridge,
  settings,
  paneNodeMap,
  panelDataMap,
  activeCwdMap,
  splitDividerElMap,
  splitDividerDataMap,
  stageEl,
  tabsListEl,
  dividerEls,
  statusLabelEl,
  statusHintEl,
  searchBarEl,
  paneActivityWatcher,
  createTerminalTheme,
  abbreviatePath,
  fitTerminal,
  scheduleSettingsSave,
  applySettings,
  getFocusedIndex: () => paneManager.getFocusedIndex(),
  getTabLayout,
  getTabsSig: () => paneManager.getTabsSig(),
  getPaneLabel: (pane) => paneManager.getPaneLabel(pane),
  getPreviewWidth,
  getPaneLeft,
  beginTabDrag: (index, event) => paneManager.beginTabDrag(index, event),
  showTabContextMenu,
  handleMenuAction,
  beginRenamePane: (index) => paneManager.beginRenamePane(index),
  commitRenamePane: (paneId, value) => paneManager.commitRenamePane(paneId, value),
  cancelRenamePane: () => paneManager.cancelRenamePane(),
  ensurePaneNodes,
});

// Wire the renderTabs callback back into pane-manager so tab dragging can
// trigger a fast DOM update without going through the full render cycle.
paneManager.setRenderTabsCallback(() => layoutRenderer.renderTabs());

// Wire panel drag-to-rearrange into stageEl (owned by layout-renderer)
paneManager.attachPanelDragToStage(stageEl);

// ── Bridge I/O ────────────────────────────────────────────────────────────────

const removeTerminalDataListener = bridge.onTerminalData(({ paneId, data }) => {
  const node = paneNodeMap.get(paneId);
  if (!node) return;
  node.terminal.write(data);
  paneActivityWatcher.noteData(paneId);
});

const removeTerminalExitListener = bridge.onTerminalExit(({ paneId, exitCode }) => {
  const node = paneNodeMap.get(paneId);
  if (!node) return;
  const graceMs = 3000;
  const recentShellChange = node._shellChangeTime && (Date.now() - node._shellChangeTime < graceMs);
  if (node._shellChanging || recentShellChange) {
    node.sessionReady = false;
    node.terminal.writeln('');
    node.terminal.writeln(`\x1b[38;5;204m[shell exited with code ${exitCode}]\x1b[0m`);
    return;
  }
  node.sessionReady = false;
  node.terminal.writeln('');
  node.terminal.writeln(`\x1b[38;5;244m[process exited with code ${exitCode}]\x1b[0m`);
  const paneIndex = paneManager.getPaneIndex(paneId);
  if (paneIndex === -1) return;
  if (st.panes.length === 1) { void bridge.exitApp().catch(reportError); return; }
  paneManager.closePane(paneIndex, { destroyTerminal: false });
});

const removeMenuActionListener = bridge.onMenuAction(({ action, paneId }) => {
  try { handleMenuAction(action, paneId); } catch (error) { reportError(error); }
});

// ── Search bar ────────────────────────────────────────────────────────────────

function getActiveSearchAddon() {
  return st.focusedPaneId ? paneNodeMap.get(st.focusedPaneId)?.searchAddon : null;
}

const SEARCH_DECORATION_OPTS = {
  matchBackground: '#ffdd5540',
  matchBorder: '#ffdd5580',
  matchOverviewRuler: '#ffdd55',
  activeMatchBackground: '#ff990080',
  activeMatchBorder: '#ff9900',
  activeMatchColorOverviewRuler: '#ff9900',
};

function runSearch(direction = 'next', { incremental = false } = {}) {
  const addon = getActiveSearchAddon();
  if (!addon) return;
  const term = searchInputEl.value;
  if (!term) {
    addon.clearDecorations();
    searchCountEl.textContent = '';
    searchInputEl.classList.remove('no-match');
    return;
  }
  const opts = { decorations: SEARCH_DECORATION_OPTS, incremental };
  if (direction === 'next') { addon.findNext(term, opts); } else { addon.findPrevious(term, opts); }
}

function openSearch() {
  searchBarEl.classList.remove('is-hidden');
  searchInputEl.focus();
  searchInputEl.select();
  runSearch('next');
}

function closeSearch() {
  searchBarEl.classList.add('is-hidden');
  getActiveSearchAddon()?.clearDecorations();
  searchInputEl.value = '';
  searchCountEl.textContent = '';
  searchInputEl.classList.remove('no-match');
  paneNodeMap.get(st.focusedPaneId)?.terminal.focus();
}

function toggleSearch() {
  if (searchBarEl.classList.contains('is-hidden')) { openSearch(); } else { closeSearch(); }
}

searchInputEl.addEventListener('input', () => runSearch('next', { incremental: true }));
searchInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); runSearch(e.shiftKey ? 'prev' : 'next'); }
  else if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
});
searchPrevEl.addEventListener('click', () => runSearch('prev'));
searchNextEl.addEventListener('click', () => runSearch('next'));
searchCloseEl.addEventListener('click', closeSearch);

// ── Clipboard / terminal I/O ──────────────────────────────────────────────────

async function getClipboardSnapshot() {
  try { return await bridge.getClipboardSnapshot?.() ?? { text: '', hasImage: false }; }
  catch { return { text: '', hasImage: false }; }
}

function copyTerminalSelection(paneId = st.focusedPaneId) {
  const node = paneManager.getPaneNode(paneId);
  if (!node) return false;
  const selection = node.terminal.getSelection();
  if (!selection) return false;
  bridge.writeClipboardText(selection);
  return true;
}

async function pasteIntoTerminal(paneId = st.focusedPaneId, options = {}) {
  const node = paneManager.getPaneNode(paneId);
  if (!node?.sessionReady) return false;
  const text = options.clipboardSnapshot?.text ?? (await bridge.readClipboardText());
  if (!text) return false;
  if (bridge.platform === 'win32') { node.terminal.paste(text); }
  else { bridge.writeTerminal({ paneId: node.paneId, data: text }); }
  return true;
}

function selectAllInTerminal(paneId = st.focusedPaneId) {
  const node = paneManager.getPaneNode(paneId);
  if (!node) return false;
  node.terminal.selectAll();
  return true;
}

async function pasteImageIntoTerminal(paneId = st.focusedPaneId, options = {}) {
  const node = paneManager.getPaneNode(paneId);
  if (!node?.sessionReady) return false;
  const snap = options.clipboardSnapshot ?? (await getClipboardSnapshot());
  if (!snap.hasImage) return false;
  bridge.writeTerminal({ paneId: node.paneId, data: '' });
  return true;
}

// ── Context menus ─────────────────────────────────────────────────────────────

async function showTerminalContextMenu(node, event) {
  const clipboardSnapshot = await getClipboardSnapshot();
  const tabId = paneManager.getOwningTabId(node.paneId);
  const tabPane = tabId ? st.panes[paneManager.getPaneIndex(tabId)] : null;
  const breathingOn = tabPane && tabPane.breathingMonitor !== false;
  const hasSplit = !!(tabPane?.layout);
  const isOnlyTab = st.panes.length <= 1;
  const shellProfiles = settingsUI.getShellProfiles();
  const defaultShellProfileId = settingsUI.getDefaultShellProfileId();

  const shellChildren = shellProfiles.map((p) => ({
    label: p.name || p.id,
    action: `terminal-change-shell:${p.id}`,
    isDefault: p.id === defaultShellProfileId,
  }));

  const items = [
    { label: t('menu.copy'),       action: 'terminal-copy',        disabled: !node.terminal.hasSelection(), shortcut: '⇧⌘C' },
    { label: t('menu.paste'),      action: 'terminal-paste',       disabled: !clipboardSnapshot.text, shortcut: '⇧⌘V' },
    { label: t('menu.pasteImage'), action: 'terminal-paste-image', disabled: !clipboardSnapshot.hasImage },
    { label: t('menu.selectAll'),  action: 'terminal-select-all',  shortcut: '⌘A' },
    { type: 'separator' },
    { label: t('menu.find'),        action: 'terminal-find',       shortcut: '⌘F' },
    { type: 'separator' },
    { label: t('menu.splitRight'), action: 'split-right',  shortcut: '⌘D' },
    { label: t('menu.splitDown'),  action: 'split-down',   shortcut: '⌘⇧D' },
    ...(hasSplit ? [{ label: t('menu.closePanel'), action: 'close-pane', shortcut: '⌘W' }] : []),
    { type: 'separator' },
    { label: t('menu.newTab'),   action: 'new-pane',  shortcut: '⌘T' },
    { label: t('menu.closeTab'), action: 'terminal-close-tab', disabled: isOnlyTab },
    { type: 'separator' },
    { label: t('menu.clearBuffer'), action: 'clear-scrollback' },
    { label: t('menu.restart'),     action: 'terminal-restart' },
    { type: 'separator' },
    { label: t('menu.backgroundActivityAlert'), action: 'pane-toggle-breathing', shortcut: breathingOn ? '✓' : '' },
    { label: t('menu.changeColor'), action: 'terminal-change-color' },
  ];
  if (shellChildren.length > 0) {
    items.push({ type: 'separator' }, { label: t('menu.changeProfile'), children: shellChildren });
  }
  showContextMenu(items, event.clientX, event.clientY, (action) => handleMenuAction(action, node.paneId));
}

function showTabContextMenu(paneId, event) {
  const paneIndex = paneManager.getPaneIndex(paneId);
  if (paneIndex === -1) return;
  st.paneCycleState = null;
  st.focusedPaneId = paneId;
  paneManager.recordPaneVisit(paneId);
  layoutRenderer.render();

  const pane = st.panes[paneIndex];
  const breathingOn = pane && pane.breathingMonitor !== false;
  const isOnlyTab = st.panes.length <= 1;
  const canMoveLeft  = paneIndex > 0;
  const canMoveRight = paneIndex < st.panes.length - 1;

  const items = [
    { label: t('menu.newTab'),   action: 'new-pane', shortcut: '⌘T' },
    { type: 'separator' },
    { label: t('menu.renameTab'), action: 'tab-rename' },
    { label: t('menu.closeTab'),  action: 'tab-close', disabled: isOnlyTab },
    { type: 'separator' },
    { label: t('menu.splitRight'), action: 'split-right', shortcut: '⌘D' },
    { label: t('menu.splitDown'),  action: 'split-down',  shortcut: '⌘⇧D' },
    { type: 'separator' },
    { label: t('menu.moveTabLeft'),  action: 'move-tab-left',  disabled: !canMoveLeft },
    { label: t('menu.moveTabRight'), action: 'move-tab-right', disabled: !canMoveRight },
    { type: 'separator' },
    { label: t('menu.changeColor'),            action: 'tab-change-color' },
    { label: t('menu.backgroundActivityAlert'), action: 'pane-toggle-breathing', shortcut: breathingOn ? '✓' : '' },
    { type: 'separator' },
    { label: t('menu.clearBuffer'), action: 'clear-scrollback' },
    { label: t('menu.restart'),     action: 'terminal-restart' },
  ];
  showContextMenu(items, event.clientX, event.clientY, (action) => handleMenuAction(action, paneId));
}

// ── Color picker ──────────────────────────────────────────────────────────────

function showColorPicker(paneId) {
  hideContextMenu();
  const paneIndex = paneManager.getPaneIndex(paneId);
  if (paneIndex === -1) return;
  const pane = st.panes[paneIndex];
  const currentColor = pane.customColor || pane.accent;

  const picker = document.createElement('div');
  picker.className = 'color-picker-overlay';
  picker.innerHTML = `
    <div class="color-picker-dialog">
      <div class="color-picker-header">
        <span>Pane Color</span>
        <button type="button" class="color-picker-close" aria-label="Close">×</button>
      </div>
      <div class="color-picker-presets">
        ${ColorsRegistry.PRESET_PANE_COLORS.map(color => `
          <button type="button" class="color-preset${color === currentColor ? ' is-selected' : ''}"
                  style="--color: ${color}" data-color="${color}" aria-label="Select ${color}"></button>
        `).join('')}
      </div>
      <div class="color-picker-custom">
        <label>Custom:</label>
        <input type="color" class="color-picker-input" value="${currentColor}" />
      </div>
      <div class="color-picker-footer">
        <button type="button" class="color-picker-clear">Clear Color</button>
      </div>
    </div>
  `;
  picker.addEventListener('click', (e) => { if (e.target === picker) picker.remove(); });
  picker.querySelector('.color-picker-close').addEventListener('click', () => picker.remove());
  picker.querySelectorAll('.color-preset').forEach(btn => {
    btn.addEventListener('click', () => { setPaneColor(paneId, btn.dataset.color); picker.remove(); });
  });
  const colorInput = picker.querySelector('.color-picker-input');
  colorInput.addEventListener('input', () => { setPaneColor(paneId, colorInput.value); });
  picker.querySelector('.color-picker-clear').addEventListener('click', () => { clearPaneColor(paneId); picker.remove(); });
  document.body.appendChild(picker);
  colorInput.focus();
}

function setPaneColor(paneId, color) {
  const paneIndex = paneManager.getPaneIndex(paneId);
  if (paneIndex === -1) return;
  st.panes[paneIndex] = { ...st.panes[paneIndex], customColor: color };
  scheduleSettingsSave();
  layoutRenderer.render();
}

function clearPaneColor(paneId) {
  const paneIndex = paneManager.getPaneIndex(paneId);
  if (paneIndex === -1) return;
  st.panes[paneIndex] = { ...st.panes[paneIndex], customColor: undefined };
  scheduleSettingsSave();
  layoutRenderer.render();
}

function togglePaneBreathingMonitor(paneId) {
  const paneIndex = paneManager.getPaneIndex(paneId);
  if (paneIndex === -1) return;
  const next = st.panes[paneIndex].breathingMonitor === false;
  st.panes[paneIndex] = { ...st.panes[paneIndex], breathingMonitor: next };
  paneActivityWatcher.setPaneEnabled(paneId, next);
  scheduleSettingsSave();
}

// ── Command palette / tab switcher ────────────────────────────────────────────

function openTabSwitcher() {
  hideContextMenu();
  if (st.renamingPaneId !== null) paneManager.cancelRenamePane();
  const { settingsPanelEl } = settingsUI;
  if (!settingsPanelEl.classList.contains('is-hidden')) settingsPanelEl.classList.add('is-hidden');

  const items = st.panes.map((pane) => ({
    id: pane.id,
    label: paneManager.getPaneLabel(pane) || pane.id,
    accent: pane.customColor || pane.accent,
  }));
  openCommandPalette(items, (paneId) => paneManager.focusPane(paneId), {
    placeholder: 'Switch tab by title…',
    emptyText: 'No matching tabs',
  });
}

function openKeymapHelpModal() {
  ShortcutsUI.openKeyboardShortcutsModal(bridge, scheduleSettingsSave);
}

// ── Menu action dispatcher ────────────────────────────────────────────────────

function handleMenuAction(action, paneId) {
  if (action === 'terminal-copy') { copyTerminalSelection(paneId); return; }
  if (action === 'terminal-paste') { void pasteIntoTerminal(paneId); return; }
  if (action === 'terminal-paste-image') { pasteImageIntoTerminal(paneId); return; }
  if (action === 'terminal-select-all') { selectAllInTerminal(paneId); return; }
  if (action === 'terminal-change-color') { showColorPicker(paneId); return; }
  if (action === 'terminal-find') { toggleSearch(); return; }
  if (action === 'terminal-restart') { restartPane(paneId); return; }

  if (action === 'terminal-close-tab') {
    const tabId = paneManager.getOwningTabId(paneId);
    if (tabId) { const idx = paneManager.getPaneIndex(tabId); if (idx !== -1) paneManager.closePane(idx); }
    return;
  }

  if (action === 'move-tab-left') {
    const idx = paneManager.getPaneIndex(paneId);
    if (idx > 0) { [st.panes[idx - 1], st.panes[idx]] = [st.panes[idx], st.panes[idx - 1]]; layoutRenderer.render(); scheduleSettingsSave(); }
    return;
  }
  if (action === 'move-tab-right') {
    const idx = paneManager.getPaneIndex(paneId);
    if (idx !== -1 && idx < st.panes.length - 1) { [st.panes[idx], st.panes[idx + 1]] = [st.panes[idx + 1], st.panes[idx]]; layoutRenderer.render(); scheduleSettingsSave(); }
    return;
  }

  if (action === 'tab-rename') {
    const paneIndex = paneManager.getPaneIndex(paneId);
    if (paneIndex !== -1) paneManager.beginRenamePane(paneIndex);
    return;
  }
  if (action === 'tab-close') {
    const paneIndex = paneManager.getPaneIndex(paneId);
    if (paneIndex !== -1) paneManager.closePane(paneIndex);
    return;
  }
  if (action === 'tab-change-color') { showColorPicker(paneId); return; }
  if (action.startsWith('tab-set-color:')) { setPaneColor(paneId, action.slice('tab-set-color:'.length)); return; }
  if (action === 'tab-clear-color') { clearPaneColor(paneId); return; }
  if (action === 'pane-toggle-breathing') { togglePaneBreathingMonitor(paneId); return; }

  if (action.startsWith('terminal-change-shell:')) {
    changePaneShell(paneId, action.slice('terminal-change-shell:'.length));
    return;
  }

  if (action === 'new-pane') { paneManager.addPane(); return; }
  if (action === 'close-pane') { paneManager.closeActivePanel(); return; }
  if (action === 'split-right') { paneManager.splitPanel('v'); return; }
  if (action === 'split-down') { paneManager.splitPanel('h'); return; }

  if (action.startsWith('split-ratio:')) {
    const ratio = parseFloat(action.slice('split-ratio:'.length));
    const pendingNode = layoutRenderer.getPendingRatioNode();
    if (!Number.isNaN(ratio) && pendingNode) {
      pendingNode.ratio = Math.max(MIN_RATIO, Math.min(MAX_RATIO, ratio));
      layoutRenderer.clearPendingRatioNode();
      layoutRenderer.renderPanes(true);
      scheduleSettingsSave();
    }
    return;
  }

  if (action === 'broadcast-toggle') { setBroadcastEnabled(!broadcastEnabled); return; }

  if (action === 'font-size-increase') {
    settings.fontSize = Math.min(24, settings.fontSize + 1);
    applySettings(); layoutRenderer.render(true); scheduleSettingsSave();
    return;
  }
  if (action === 'font-size-decrease') {
    settings.fontSize = Math.max(10, settings.fontSize - 1);
    applySettings(); layoutRenderer.render(true); scheduleSettingsSave();
    return;
  }
  if (action === 'font-size-reset') {
    settings.fontSize = 13;
    applySettings(); layoutRenderer.render(true); scheduleSettingsSave();
    return;
  }

  if (action === 'close-window') { void bridge.closeWindow().catch(reportError); return; }

  if (action === 'rename-tab') {
    const paneIndex = paneManager.getFocusedIndex();
    if (paneIndex !== -1) {
      if (st.currentMode === 'nav') paneManager.setMode('terminal');
      paneManager.beginRenamePane(paneIndex);
    }
    return;
  }

  if (action === 'clear-scrollback') {
    const node = paneNodeMap.get(st.focusedPaneId);
    if (node) node.terminal.clear();
    return;
  }

  if (action === 'appearance-light' || action === 'appearance-dark' || action === 'appearance-auto') {
    const mode = action.slice('appearance-'.length);
    settings.colorMode = mode;
    applyColorModeUI(mode);
    applyColorMode(mode);
    scheduleSettingsSave();
    return;
  }

  if (action === 'toggle-status-bar') {
    settings.showStatusBar = !settings.showStatusBar;
    applySettings();
    scheduleSettingsSave();
    return;
  }

  if (action === 'toggle-navigation-mode') {
    if (st.currentMode === 'nav') {
      paneManager.setMode('terminal');
      if (st.focusedPaneId) paneManager.focusPane(st.focusedPaneId, { focusTerminal: true });
    } else {
      paneManager.enterNavigationMode();
    }
    return;
  }

  if (action === 'next-tab') {
    const idx = paneManager.getFocusedIndex();
    if (idx !== -1 && st.panes.length > 1) paneManager.focusPane(st.panes[(idx + 1) % st.panes.length].id, { focusTerminal: true });
    return;
  }
  if (action === 'prev-tab') {
    const idx = paneManager.getFocusedIndex();
    if (idx !== -1 && st.panes.length > 1) paneManager.focusPane(st.panes[(idx - 1 + st.panes.length) % st.panes.length].id, { focusTerminal: true });
    return;
  }

  if (action === 'move-tab-left' && !paneId) {
    const idx = paneManager.getFocusedIndex();
    if (idx > 0) { [st.panes[idx - 1], st.panes[idx]] = [st.panes[idx], st.panes[idx - 1]]; layoutRenderer.render(); scheduleSettingsSave(); }
    return;
  }
  if (action === 'move-tab-right' && !paneId) {
    const idx = paneManager.getFocusedIndex();
    if (idx !== -1 && idx < st.panes.length - 1) { [st.panes[idx], st.panes[idx + 1]] = [st.panes[idx + 1], st.panes[idx]]; layoutRenderer.render(); scheduleSettingsSave(); }
    return;
  }

  if (action === 'pane-color') { if (st.focusedPaneId) showColorPicker(st.focusedPaneId); return; }
  if (action === 'keyboard-shortcuts') { openKeymapHelpModal(); return; }
}

// ── Keyboard ──────────────────────────────────────────────────────────────────

const keyboardActions = createActions({
  addPane: () => paneManager.addPane(),
  enterNavigationMode: () => paneManager.enterNavigationMode(),
  cycleToRecentPane: (opts) => paneManager.cycleToRecentPane(opts),
  navigateLeft: () => paneManager.navigateLeft(),
  navigateRight: () => paneManager.navigateRight(),
  copyTerminalSelection,
  pasteIntoTerminal,
  moveFocus: (delta) => paneManager.moveFocus(delta),
  focusPane: (paneId, opts) => paneManager.focusPane(paneId, opts),
  cancelNavigationMode: () => paneManager.cancelNavigationMode(),
  getFocusedPaneId: () => st.focusedPaneId,
  isCommandPaletteOpen,
  closeCommandPalette,
  openTabSwitcher,
  focusPaneAt: (index) => paneManager.focusPaneAt(index),
  getPaneCount: () => paneManager.getPaneCount(),
  getPaneIdAt: (index) => paneManager.getPaneIdAt(index),
  requestClosePane: (paneId) => paneManager.requestClosePane(paneId),
  startInlineRename: (paneId) => paneManager.startInlineRename(paneId),
  openKeymapHelpModal,
  splitPanel: (dir) => paneManager.splitPanel(dir),
  closeActivePanel: () => paneManager.closeActivePanel(),
  focusPanelDelta: (delta) => paneManager.focusPanelDelta(delta),
  fontSizeIncrease: () => { settings.fontSize = Math.min(24, settings.fontSize + 1); applySettings(); layoutRenderer.render(true); scheduleSettingsSave(); },
  fontSizeDecrease: () => { settings.fontSize = Math.max(10, settings.fontSize - 1); applySettings(); layoutRenderer.render(true); scheduleSettingsSave(); },
  fontSizeReset: () => { settings.fontSize = 13; applySettings(); layoutRenderer.render(true); scheduleSettingsSave(); },
  toggleSearch,
});

const dispatchKeydown = createDispatcher({
  getKeymap: ShortcutsRegistry.getActiveKeymap,
  actions: keyboardActions,
  getMode: () => st.currentMode,
  isInputFocused: () => document.activeElement?.tagName === 'INPUT',
  isCommandPaletteOpen,
});

window.addEventListener('keydown', dispatchKeydown, true);

window.addEventListener('keyup', (event) => {
  if (paneManager && st.paneCycleState && (event.key === 'Control' || event.key === 'Meta')) {
    paneManager.commitPaneCycle();
  }
});

window.addEventListener('blur', () => {
  if (paneManager && st.paneCycleState) paneManager.commitPaneCycle();
});

addPaneButtonEl.addEventListener('click', () => {
  try { paneManager.addPane(); } catch (error) { reportError(error); }
});

// ── Session restore ───────────────────────────────────────────────────────────

function restoreSession(session) {
  const validPanes = (session.panes ?? [])
    .filter((p) => p && typeof p.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(p.accent))
    .map((p, index) => {
      const id = `p${index + 1}`;
      let layout = null;
      let focusedPanelId = id;
      if (p.layout && typeof p.layout === 'object') {
        try {
          layout = deserializeLayout(p.layout, (leafData) => {
            const panelId = leafData.isRoot ? id : `panel-${st.nextPanelSeq++}`;
            panelDataMap.set(panelId, {
              cwd: validCwd(leafData.cwd),
              shellProfileId: (typeof leafData.shellProfileId === 'string' && leafData.shellProfileId) || null,
              accent: (typeof p.accent === 'string' && p.accent) || '#888888',
              breathingMonitor: leafData.breathingMonitor !== false,
            });
            return panelId;
          });
          const ids = collectPanelIds(layout);
          focusedPanelId = p.focusedIsRoot ? id : (ids[0] ?? id);
        } catch {
          layout = null;
          focusedPanelId = id;
        }
      }
      return {
        id,
        title: (typeof p.title === 'string' && p.title) || null,
        terminalTitle: bridge.defaultTabTitle,
        cwd: validCwd(p.cwd),
        accent: p.accent,
        customColor: (typeof p.customColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(p.customColor) && p.customColor) || undefined,
        shellProfileId: (typeof p.shellProfileId === 'string' && p.shellProfileId) || null,
        breathingMonitor: p.breathingMonitor !== false,
        layout,
        focusedPanelId,
      };
    });

  if (validPanes.length === 0) {
    st.panes = _initialPanes.map((p) => ({ ...p, cwd: bridge.defaultCwd, terminalTitle: bridge.defaultTabTitle }));
    st.focusedPaneId = st.panes[0].id;
    st.nextPaneNumber = st.panes.length + 1;
    st.paneMruOrder = st.panes.map((p) => p.id);
    st.paneCycleState = null;
    return;
  }

  st.panes = validPanes;
  const focusedIndex = Math.min(
    Number.isFinite(session.focusedPaneIndex) ? session.focusedPaneIndex : 0,
    st.panes.length - 1,
  );
  st.focusedPaneId = st.panes[Math.max(0, focusedIndex)].id;
  st.nextPaneNumber = st.panes.length + 1;
  st.paneMruOrder = [st.focusedPaneId, ...st.panes.map((p) => p.id).filter((id) => id !== st.focusedPaneId)];
  st.paneCycleState = null;
}

// ── Window events ─────────────────────────────────────────────────────────────

let _resizeTimer = null;
window.addEventListener('resize', () => {
  try { layoutRenderer.renderPanes(false); } catch (error) { reportError(error); }
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => {
    try { layoutRenderer.render(true); } catch (error) { reportError(error); }
  }, 120);
});

window.addEventListener('DOMContentLoaded', async () => {
  try {
    await bridge.cwdReady;
    const savedSettings = await bridge.loadSettings();
    applyPersistedSettings(savedSettings);
    applySettings();

    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      if (settings.colorMode === 'auto') applyColorMode('auto');
    });
    applyTranslations();
    loadShellProfiles();

    if (savedSettings?.session?.panes?.length > 0) {
      restoreSession(savedSettings.session);
    } else {
      st.panes = st.panes.map((p) =>
        p.title === null ? { ...p, cwd: bridge.defaultCwd, terminalTitle: bridge.defaultTabTitle } : p
      );
    }

    layoutRenderer.render(true);
    st.sessionRestoreComplete = true;
  } catch (error) {
    reportError(error);
  }
});

window.addEventListener('beforeunload', () => {
  flushSettingsSave();
  removeTerminalDataListener();
  removeTerminalExitListener();
  removeMenuActionListener();
});

window.addEventListener('error', (event) => { reportError(event.error || event.message); });
window.addEventListener('unhandledrejection', (event) => { reportError(event.reason); });

// macOS fullscreen: shift content down when auto-hide menu bar appears.
{
  const html = document.documentElement;
  let menuBarTimer = null;
  let fsCheckTimer = null;
  const tauriWin = window.__TAURI__?.window?.getCurrentWindow?.();

  async function updateFullscreenClass() {
    let isFs = false;
    if (tauriWin) { try { isFs = await tauriWin.isFullscreen(); } catch {} }
    if (!isFs) {
      html.classList.remove('is-fullscreen', 'menu-bar-showing');
      clearTimeout(menuBarTimer);
    } else {
      const wasFs = html.classList.contains('is-fullscreen');
      html.classList.add('is-fullscreen');
      if (!wasFs) {
        bridge.setWindowTheme(settings.colorMode).catch(() => {});
        setTimeout(() => bridge.setWindowTheme(settings.colorMode).catch(() => {}), 600);
      }
    }
  }

  function scheduleFullscreenCheck() {
    clearTimeout(fsCheckTimer);
    fsCheckTimer = setTimeout(() => updateFullscreenClass(), 350);
  }

  if (tauriWin) tauriWin.onResized(() => scheduleFullscreenCheck());
  window.addEventListener('resize', () => scheduleFullscreenCheck());
  updateFullscreenClass();

  document.addEventListener('mousemove', (e) => {
    if (!html.classList.contains('is-fullscreen')) return;
    if (e.clientY <= 40) {
      if (!html.classList.contains('menu-bar-showing')) html.classList.add('menu-bar-showing');
      clearTimeout(menuBarTimer);
      menuBarTimer = setTimeout(() => { html.classList.remove('menu-bar-showing'); }, 4000);
    } else if (e.clientY > 60 && html.classList.contains('menu-bar-showing')) {
      clearTimeout(menuBarTimer);
      html.classList.remove('menu-bar-showing');
    }
  });
}
