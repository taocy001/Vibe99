// Thin orchestrator — wires together terminal-bridge, settings-ui, pane-manager,
// and layout-renderer. Owns terminal creation, bridge I/O, search, context menus,
// and keyboard dispatch. Everything else lives in the imported modules.

// Cmd+Option+I opens DevTools (devtools feature is already compiled in via Cargo.toml).
document.addEventListener('keydown', async (e) => {
  if (e.metaKey && e.altKey && e.key === 'i') {
    const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    getCurrentWebviewWindow().openDevtools();
  }
}, { capture: true });

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { GraphemeUnicodeAddon } from './grapheme-unicode.js';
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
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
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

// ── Window identity ───────────────────────────────────────────────────────────
// Each window gets a unique pane ID prefix so PTY sessions never collide in
// the Rust HashMap when multiple windows are open simultaneously.
const _appWindow = getCurrentWebviewWindow();
const _winLabel = _appWindow.label; // e.g. "main" or "window-2"
const _panePrefix = _winLabel === 'main' ? '' : `${_winLabel}-`;

// ── Initial panes ─────────────────────────────────────────────────────────────
const _initialPanes = [
  { id: `${_panePrefix}p1`, title: null, terminalTitle: bridge.defaultTabTitle, cwd: bridge.defaultCwd, accent: ColorsRegistry.ACCENT_PALETTE[0], shellProfileId: null, layout: null, focusedPanelId: `${_panePrefix}p1` },
  { id: `${_panePrefix}p2`, title: null, terminalTitle: bridge.defaultTabTitle, cwd: bridge.defaultCwd, accent: ColorsRegistry.ACCENT_PALETTE[1], shellProfileId: null, layout: null, focusedPanelId: `${_panePrefix}p2` },
  { id: `${_panePrefix}p3`, title: null, terminalTitle: bridge.defaultTabTitle, cwd: bridge.defaultCwd, accent: ColorsRegistry.ACCENT_PALETTE[2], shellProfileId: null, layout: null, focusedPanelId: `${_panePrefix}p3` },
];

// ── Shared mutable state ──────────────────────────────────────────────────────
// All modules receive a reference so mutations propagate across boundaries.
const st = {
  panes: _initialPanes.map((p) => ({ ...p })),
  focusedPaneId: `${_panePrefix}p1`,
  nextPaneNumber: 4,
  nextPanelSeq: 1,
  panePrefix: _panePrefix,
  renamingPaneId: null,
  isRenderingTabs: false,
  dragState: null,
  currentMode: 'terminal',
  enterNavSourcePaneId: null,
  sessionRestoreComplete: false,
  paneMruOrder: [`${_panePrefix}p1`, `${_panePrefix}p2`, `${_panePrefix}p3`],
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
const searchRegexEl = document.getElementById('search-regex');
const searchAllPanesEl = document.getElementById('search-all-panes');
const searchResultsPanelEl = document.getElementById('search-results-panel');

let _searchRegex = false;
let _searchAllPanes = false;
let _crossPaneDebounceTimer = null;

// ── Activity monitoring ───────────────────────────────────────────────────────
const paneAlert = createBreathingMaskAlert();

// Per-pane timers for silence notifications (separate from breathing alert).
// Keyed by paneId; cleared when the pane gets focus (onClear).
const _silenceNotifTimers = new Map();

const paneActivityWatcher = createPaneActivityWatcher({
  onAlert: (paneId) => {
    const node = paneNodeMap.get(paneId);
    if (node) paneAlert.setAlerted(node.root, true);

    // Schedule a silence notification after the user-configured timeout.
    // The watcher's own settleMs (1500ms) has already elapsed, so we wait
    // only the remaining time: notificationSilenceMs - DEFAULT_SETTLE_MS,
    // floored at 0 so fast settings values still work.
    if (settings.notificationsEnabled && !document.hasFocus()) {
      const delay = Math.max(0, settings.notificationSilenceMs - 1500);
      const timer = setTimeout(() => {
        _silenceNotifTimers.delete(paneId);
        if (settings.notificationsEnabled && !document.hasFocus()) {
          const pane  = st.panes.find(p => p.id === paneId);
          const label = pane?.title || pane?.terminalTitle || paneId;
          bridge.sendNotification(t('notification.paneSilent'), label);
        }
      }, delay);
      // Cancel any previous timer for this pane (shouldn't happen, but guard).
      const prev = _silenceNotifTimers.get(paneId);
      if (prev != null) clearTimeout(prev);
      _silenceNotifTimers.set(paneId, timer);
    }
  },
  onClear: (paneId) => {
    const node = paneNodeMap.get(paneId);
    if (node) paneAlert.setAlerted(node.root, false);

    // Cancel any pending silence notification when the pane is focused/cleared.
    const timer = _silenceNotifTimers.get(paneId);
    if (timer != null) {
      clearTimeout(timer);
      _silenceNotifTimers.delete(paneId);
    }
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
  let protocol;
  try { protocol = new URL(uri).protocol; } catch { return; }
  if (protocol !== 'https:' && protocol !== 'http:') {
    if (!window.confirm(`Open this link?\n\n${uri}`)) return;
  }
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
  // Ensure the vibe99:terminal-data listener is registered with the Rust event
  // plugin before spawning the PTY. Without this, the first burst of shell
  // output (prompt, PS1 init) can arrive before Rust knows to dispatch the
  // event to this webview and is silently dropped.
  await bridge.listenersReady;
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
    const focusedPanelId = st.panes.find((p) => p.id === st.focusedPaneId)?.focusedPanelId ?? st.focusedPaneId;
    if (node.paneId === focusedPanelId) node.terminal.focus();
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
  terminal.loadAddon(new GraphemeUnicodeAddon(() => settings.ambiguousDouble));
  terminal.open(terminalHost);
  fixXtermViewportBg(terminalHost, settings.colorMode);
  terminal.loadAddon(new ImageAddon());
  try { terminal.loadAddon(new WebglAddon()); } catch {}

  // WKWebView IME fix (diagnosed via event logging).
  //
  // For Chinese Shift+key punctuation (e.g. Shift+/ → ？), WKWebView fires NO composition
  // events. The character arrives via `input` (insertText) BEFORE keydown 229. Xterm
  // rejects this path because ev.composed=true && _keyDownSeen=true. We intercept in
  // the `input` capture handler (Path A) and call terminal.input() directly.
  //
  // xterm's _keyDown for keyCode 229 returns early (compositionHelper returns false),
  // leaving _keyDownHandled=false. The subsequent `keypress` event would then pass
  // xterm's _keyPress guard and double-send the character. We stop keypress propagation
  // for keyCode 229 before xterm's textarea capture fires.
  //
  // For composition-based input (regular pinyin), xterm's _keyDown fires before
  // compositionstart and sends the first letter. Our compositionstart handler cancels
  // that letter with a backspace (\x7f), and compositionend delivers the final character
  // via terminal.input() (bypassing xterm's deferred ta.value read, which WKWebView
  // clears before xterm's setTimeout fires).
  let _compositionData = '';
  let _compositionFailed = false;
  let _compositionActive = false;
  // WKWebView fires compositionend and keydown(Enter) in SEPARATE macrotasks, so
  // setTimeout(0) runs between them and clears any flag before keydown arrives.
  // Use the ProseMirror/Square pattern: set a 50ms window in compositionend so the
  // Enter keydown (which arrives microseconds later on WKWebView) is still caught.
  let _compositionJustEnded = false;
  let _compositionJustEndedTimer = null;
  // Tracks the last char xterm sent via _keyDown (when not composing).
  // Used to detect whether the following `input` event was already handled by xterm.
  let _xtermLastKeydownData = null;
  const _ta = () => terminalHost.querySelector('textarea.xterm-helper-textarea');

  terminalHost.addEventListener('keydown', (e) => {
    _xtermLastKeydownData = null;
    // For the Chinese Shift+key punctuation path (keyCode 229, no active composition),
    // xterm's _keyDown calls _handleAnyTextareaChanges() which defers a ta.value read.
    // Clear ta.value now (before that record) and again after (via setTimeout) so the
    // deferred read sees no diff and doesn't send an extra character.
    if (e.keyCode === 229 && !_compositionActive) {
      const ta = _ta();
      if (ta) {
        ta.value = '';
        setTimeout(() => { if (ta.isConnected) ta.value = ''; }, 0);
      }
    }
    // Safety reset: if _compositionActive is stuck (compositionend never fired — a
    // known WKWebView edge case when composition is cancelled via Escape or focus loss)
    // and the browser confirms we're not composing, unblock input now so vi/vim and
    // other programs that need raw keyboard access continue to work.
    if (_compositionActive && !e.isComposing && e.keyCode !== 229) {
      _compositionActive = false;
      _compositionData = '';
    }
    // During active composition, block all keydown events from reaching xterm.
    // The OS-level IME has already processed the key (candidate selection, backspace,
    // arrow navigation, etc.) before this event fires; xterm must not also process it
    // or digit/letter keys get sent raw to the PTY while the IME is open.
    if (_compositionActive) {
      e.stopImmediatePropagation();
      return;
    }
    // Suppress Enter that commits IME composition.
    // _compositionJustEnded catches the case where Enter fires within 50ms of compositionend
    // (standard IME where compositionend carries data, e.g. selecting a Chinese character).
    // _compositionFailed catches WKWebView Pinyin where compositionend always fires with
    // empty data (PATH-C already sent each letter), so _compositionJustEnded times out
    // before the user presses Enter — but _compositionFailed persists until compositionstart.
    if (e.key === 'Enter' && (_compositionJustEnded || _compositionFailed)) {
      _compositionFailed = false;
      _compositionJustEnded = false;
      clearTimeout(_compositionJustEndedTimer);
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
  }, { capture: true, signal });

  // xterm's _keyPress (capture on textarea) fires after keydown 229 with _keyDownHandled=false
  // (because _keyDown returned early for IME keys). Without this guard it would send charCode
  // as a character, duplicating our Path A send. Stop propagation before xterm sees it.
  terminalHost.addEventListener('keypress', (e) => {
    if (e.keyCode === 229) e.stopPropagation();
  }, { capture: true, signal });

  terminalHost.addEventListener('compositionstart', () => {
    _compositionData = '';
    _compositionFailed = false;
    _compositionActive = true;
    _compositionJustEnded = false;
    clearTimeout(_compositionJustEndedTimer);
    // If xterm's _keyDown sent a raw ASCII char (e.g. '?' for Shift+/) before
    // compositionstart fired, cancel it with a backspace so the shell only sees
    // the final composed character.
    const prevData = _xtermLastKeydownData;
    _xtermLastKeydownData = null;
    // Only cancel a letter (a-z): that's the pinyin initial that xterm sent before
    // compositionstart fired. Space/numbers/punctuation must not be cancelled — on
    // WKWebView, Space can fire a spurious compositionstart after a prior commit and
    // we must not erase the space the user typed.
    if (prevData !== null && /^[a-z]$/i.test(prevData) && node.sessionReady) {
      bridge.writeTerminal({ paneId: node.paneId, data: '\x7f' });
    }
  }, { capture: true, signal });

  terminalHost.addEventListener('compositionupdate', (e) => {
    if (e.data) _compositionData = e.data;
  }, { capture: true, signal });

  terminalHost.addEventListener('beforeinput', (e) => {
    if (e.data && (
      e.inputType === 'insertCompositionText' ||
      e.inputType === 'insertReplacementText' ||
      e.inputType === 'insertFromComposition'
    )) {
      _compositionData = e.data;
    }
  }, { capture: true, signal });

  terminalHost.addEventListener('compositionend', (e) => {
    _compositionActive = false;
    const data = e.data || _compositionData;
    _compositionData = '';
    const ta = _ta();

    // Set flag unconditionally — compositionend always signals that Enter (or another
    // commit key) was pressed; the 50ms window covers WKWebView's cross-task delay.
    _compositionJustEnded = true;
    clearTimeout(_compositionJustEndedTimer);
    _compositionJustEndedTimer = setTimeout(() => { _compositionJustEnded = false; }, 50);

    if (data) {
      _compositionFailed = false;
      terminal.input(data, true);
      if (ta) {
        ta.value = '';
        setTimeout(() => { if (ta.isConnected) ta.value = ''; }, 0);
      }
    } else {
      _compositionFailed = true;
      // Composition was cancelled (all chars deleted via Backspace). Clear ta.value so
      // xterm doesn't read the residual IME text and send it to the terminal.
      if (ta) {
        ta.value = '';
        setTimeout(() => { if (ta.isConnected) ta.value = ''; }, 0);
      }
    }
  }, { capture: true, signal });

  terminalHost.addEventListener('input', (e) => {
    // Path A: Chinese Shift+key punctuation (e.g. Shift+/ → ？) on WKWebView/macOS.
    // These arrive as insertText WITHOUT composition events. Xterm's _inputEvent
    // rejects them because (ev.composed=true && _keyDownSeen=true). We detect this
    // case by checking that xterm didn't already send this char via _keyDown
    // (_xtermLastKeydownData is null since only a Shift modifier preceded the input).
    if (e.inputType === 'insertText' && e.data && !_compositionActive && _xtermLastKeydownData !== e.data) {
      e.stopPropagation(); // prevent xterm's _inputEvent (textarea capture) from also seeing this
      const ta = _ta();
      if (ta) ta.value = '';
      terminal.input(e.data, true);
      return;
    }
    // Path B: WKWebView compositionend fired with empty data; input carries the text.
    if (_compositionFailed && e.data) {
      _compositionFailed = false;
      _compositionActive = false;
      const ta = _ta();
      if (ta) ta.value = '';
      terminal.input(e.data, true);
      return;
    }
    // Path C: beforeinput captured data during a direct substitution (composition complete).
    // Guard with !_compositionActive: beforeinput also fires for insertCompositionText
    // during in-progress composition updates; we must not send those intermediate strings
    // to the terminal — only fire once composition has actually ended.
    if (_compositionData && !_compositionActive) {
      _compositionFailed = false;
      const data = _compositionData;
      _compositionData = '';
      terminal.input(data, true);
    }
  }, { capture: true, signal });

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
    // Cmd+↑/↓ — navigate between command blocks
    if (event.type === 'keydown' && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey &&
        (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      // preventDefault stops WKWebView from firing its native Cmd+↑ scroll-to-top,
      // which would corrupt the terminal's viewport state.
      event.preventDefault();
      const dir = event.key === 'ArrowUp' ? -1 : 1;
      const buf = terminal.buffer.active;
      // Navigate relative to the active block; fall back to viewport edges when none.
      // Using _activeBlock (not viewportY) lets repeated Cmd+↑ step through all
      // blocks including those already visible in the current viewport.
      const refLine = _activeBlock && !_activeBlock.promptMk.isDisposed
        ? _activeBlock.promptMk.line
        : dir === -1 ? buf.baseY + terminal.rows : buf.viewportY - 1;
      const completedMarkers = _blocks.map(b => b.promptMk).filter(m => !m.isDisposed);
      const target = dir === -1
        ? completedMarkers.filter(m => m.line < refLine).at(-1)
        : completedMarkers.find(m => m.line > refLine);
      if (target) {
        terminal.scrollToLine(target.line);
        setActiveBlock(_blocks.find(b => b.promptMk === target));
      }
      return false;
    }
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

  terminalHost.addEventListener('contextmenu', async (event) => {
    event.preventDefault();
    paneManager.focusSplitPanel(node.paneId, { focusTerminal: false });
    if (settings.rightClickPaste) {
      const snap = await getClipboardSnapshot();
      if (snap.text) {
        void pasteIntoTerminal(node.paneId, { clipboardSnapshot: snap });
        return;
      }
    }
    void showTerminalContextMenu(node, event);
  }, { signal });

  // Block click-to-highlight: single click anywhere in a completed block activates it.
  let _mousedownPos = { x: 0, y: 0 };
  terminalHost.addEventListener('mousedown', (e) => { _mousedownPos = { x: e.clientX, y: e.clientY }; }, { signal });
  terminalHost.addEventListener('click', (e) => {
    if (e.button !== 0) return;
    if (Math.abs(e.clientX - _mousedownPos.x) > 5 || Math.abs(e.clientY - _mousedownPos.y) > 5) return;
    const cellH = terminalHost.offsetHeight / terminal.rows;
    if (cellH <= 0) return;
    const buf = terminal.buffer.active;
    const bufRow = buf.viewportY + Math.floor(e.offsetY / cellH);

    // Completed blocks
    const hit = _blocks.find(b => !b.promptMk.isDisposed &&
      bufRow >= b.promptMk.line &&
      bufRow <= (b.endMk && !b.endMk.isDisposed ? b.endMk.line : b.promptMk.line));
    if (hit) { setActiveBlock(hit); return; }

    // In-progress block: prompt fired (OSC A) but command not yet done (no OSC D).
    // Highlight from the prompt line to the current cursor as a point-in-time snapshot.
    if (_shellPromptMarker && !_shellPromptMarker.isDisposed) {
      const cursorLine = buf.baseY + buf.cursorY;
      if (bufRow >= _shellPromptMarker.line && bufRow <= cursorLine) {
        _activeBlock = null;
        _applyHighlight(_shellPromptMarker, Math.min(Math.max(1, cursorLine - _shellPromptMarker.line + 1), terminal.rows + 4));
        return;
      }
    }

    setActiveBlock(null);
  }, { signal });

  terminal.onData((data) => {
    if (!node.sessionReady) return;
    if (!_compositionActive) _xtermLastKeydownData = data;
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

  // Mouse selection: read the finalised selection at mouseup, before any
  // subsequent focus() call in a requestAnimationFrame could clear it.
  terminalHost.addEventListener('mouseup', (e) => {
    if (e.button !== 0 || !settings.copyOnSelect) return;
    const selection = terminal.getSelection();
    if (selection) bridge.writeClipboardText(selection).catch(() => {});
  }, { signal });

  // Keyboard selection (Shift+arrow, selectAll, etc.) has no mouseup;
  // use onSelectionChange as the fallback for those paths.
  terminal.onSelectionChange(() => {
    if (!settings.copyOnSelect) return;
    const selection = terminal.getSelection();
    if (selection) bridge.writeClipboardText(selection).catch(() => {});
  });

  // OSC 7 — shell reports current working directory.
  terminal.parser.registerOscHandler(7, (data) => {
    let path = data;
    try {
      const url = new URL(data);
      // Reject file://hostname/... to prevent CWD poisoning via rogue processes.
      // URL() normalises .. segments, so decodeURIComponent is safe afterwards.
      if (url.protocol === 'file:' && url.hostname === '') {
        path = decodeURIComponent(url.pathname);
      }
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

  // OSC 52 — set clipboard from terminal (write disabled for security)
  terminal.parser.registerOscHandler(52, (data) => {
    // OSC 52 clipboard write is disabled for security (clipboard hijacking).
    // Terminal programs cannot silently overwrite the system clipboard.
    const semicolon = data.indexOf(';');
    if (semicolon !== -1) {
      const base64Text = data.slice(semicolon + 1);
      if (base64Text && base64Text !== '?') {
        console.warn('[vibe99] OSC 52 clipboard write blocked (disabled for security)');
      }
    }
    return true;
  });

  // OSC 133 — shell integration: A=prompt-start C=output-start D=command-done
  // _promptMarkers: ordered list of all prompt markers for Cmd+↑/↓ block navigation
  // _blocks: completed command blocks { promptMk, outputMk, endMk, exitCode }
  const _promptMarkers = [];
  const _blocks = [];
  let _shellPromptMarker = null;
  let _shellOutputMarker = null;

  let _activeBlock = null;
  let _activeHighlightDecoration = null;

  function _applyHighlight(marker, height) {
    if (_activeHighlightDecoration) { _activeHighlightDecoration.dispose(); _activeHighlightDecoration = null; }
    const dec = terminal.registerDecoration({ marker, height, layer: 'bottom' });
    dec?.onRender((el) => {
      if (el.style.display === 'none') return;
      el.classList.add('cmd-block-active-bg');
      el.style.display = 'block';
      // width and left handled by CSS !important — no JS mutation needed
    });
    _activeHighlightDecoration = dec;
  }

  function setActiveBlock(block) {
    _activeBlock = block || null;
    if (!block || block.promptMk.isDisposed) {
      if (_activeHighlightDecoration) { _activeHighlightDecoration.dispose(); _activeHighlightDecoration = null; }
      return;
    }
    const endLine = block.endMk && !block.endMk.isDisposed ? block.endMk.line : block.promptMk.line + 1;
    const blockHeight = Math.max(1, endLine - block.promptMk.line);
    _applyHighlight(block.promptMk, Math.min(blockHeight, terminal.rows + 4));
  }
  terminal.parser.registerOscHandler(133, (data) => {
    if (data === 'A') {
      _shellPromptMarker = terminal.registerMarker(0);
      if (_shellPromptMarker) _promptMarkers.push(_shellPromptMarker);
    } else if (data === 'C') {
      _shellOutputMarker = terminal.registerMarker(0);
    } else if (data === 'D' || data.startsWith('D;')) {
      const exitCode = data.length > 2 ? parseInt(data.slice(2), 10) : 0;
      const promptMk = _shellPromptMarker;
      const outputMk = _shellOutputMarker;
      if (promptMk && outputMk) {
        const endMk = terminal.registerMarker(0);
        const block = { promptMk, outputMk, endMk, exitCode };
        _blocks.push(block);
        // Overview ruler indicator
        terminal.registerDecoration({
          marker: promptMk,
          overviewRulerOptions: { color: exitCode === 0 ? '#30D158' : '#FF453A', position: 'right' },
        });

        // Right-aligned badge on the prompt line.
        // anchor:'right' positions from the right edge; classList.add preserves xterm's
        // xterm-decoration class (position:absolute) — critical for correct placement.
        const badge = terminal.registerDecoration({ marker: promptMk, anchor: 'right', x: 0 });
        badge?.onRender((el) => {
          if (el.style.display === 'none') return;
          if (!el.dataset.init) {
            el.dataset.init = '1';
            el.classList.add('cmd-block-badge', exitCode === 0 ? 'cmd-ok' : 'cmd-fail');

            const statusEl = document.createElement('span');
            statusEl.className = 'cmd-block-status';
            statusEl.textContent = exitCode === 0 ? '✓' : `✗${exitCode || ''}`;

            const copyBtn = document.createElement('button');
            copyBtn.className = 'cmd-block-btn';
            copyBtn.title = 'Copy output';
            copyBtn.textContent = '⎘';
            copyBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              const buf = terminal.buffer.active;
              const lines = [];
              for (let i = outputMk.line; i < endMk.line; i++) {
                const ln = buf.getLine(i);
                if (ln) lines.push(ln.translateToString(true));
              }
              while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
              bridge.writeClipboardText(lines.join('\n'));
            });

            el.append(statusEl, copyBtn);
          }
          el.style.display = 'flex';
        });

        // System notification when window is not focused.
        // Also cancel any pending silence notification — the cmd-done notif already covers it.
        const pendingSilence = _silenceNotifTimers.get(node.paneId);
        if (pendingSilence != null) {
          clearTimeout(pendingSilence);
          _silenceNotifTimers.delete(node.paneId);
        }
        if (settings.notificationsEnabled && !document.hasFocus()) {
          const pane  = st.panes.find(p => p.id === node.paneId);
          const label = pane?.title || pane?.terminalTitle || node.paneId;
          const title = exitCode === 0
            ? t('notification.cmdDone')
            : `${t('notification.cmdFailed')} (${exitCode})`;
          bridge.sendNotification(title, label);
        }

        _shellPromptMarker = null;
        _shellOutputMarker = null;
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
  saveSession: _winLabel === 'main',
  onOpenSshConnection: (profileId) => { paneManager.addPane({ shellProfileId: profileId }); },
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
  openSshConnectionsSubPage,
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

function showSshReconnectOverlay(node, profile) {
  node.terminalHost.querySelector('.ssh-reconnect-overlay')?.remove();
  const sc = profile.sshConfig;
  const serverLabel = sc?.user ? `${sc.user}@${sc.host}` : (sc?.host ?? profile.id);

  const overlay = document.createElement('div');
  overlay.className = 'ssh-reconnect-overlay';
  const content = document.createElement('div');
  content.className = 'ssh-reconnect-content';

  const icon = document.createElement('div');
  icon.className = 'ssh-reconnect-icon';
  icon.textContent = '⚡';

  const labelEl = document.createElement('div');
  labelEl.className = 'ssh-reconnect-label';
  labelEl.textContent = 'Disconnected from ';
  const strong = document.createElement('strong');
  strong.textContent = serverLabel;
  labelEl.appendChild(strong);

  const actions = document.createElement('div');
  actions.className = 'ssh-reconnect-actions';
  const reconnectBtn = document.createElement('button');
  reconnectBtn.className = 'ssh-reconnect-btn is-primary';
  reconnectBtn.dataset.action = 'reconnect';
  reconnectBtn.textContent = 'Reconnect';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'ssh-reconnect-btn';
  closeBtn.dataset.action = 'close';
  closeBtn.textContent = 'Close Pane';
  actions.append(reconnectBtn, closeBtn);

  content.append(icon, labelEl, actions);
  overlay.appendChild(content);

  overlay.addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'reconnect') {
      overlay.remove();
      node.sessionReady = false;
      node.terminal.clear();
      reconnectBtn.disabled = true;
      initializePaneTerminal(node).finally(() => { reconnectBtn.disabled = false; });
    } else if (action === 'close') {
      const idx = paneManager.getPaneIndex(node.paneId);
      if (idx === -1) return;
      if (st.panes.length === 1) { void bridge.closeWindow().catch(reportError); return; }
      paneManager.closePane(idx, { destroyTerminal: false });
    }
  });
  node.terminalHost.appendChild(overlay);
}

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

  // For SSH panes/panels, show a reconnect overlay instead of auto-closing.
  // paneId may be a panel ID (split layout) — check panelDataMap first, then panes.
  const pane = st.panes.find((p) => p.id === paneId);
  const profileId = pane?.shellProfileId ?? panelDataMap.get(paneId)?.shellProfileId;
  const profile = profileId
    ? settingsUI.getShellProfiles().find((p) => p.id === profileId)
    : null;
  if (profile?.kind === 'ssh') {
    showSshReconnectOverlay(node, profile);
    return;
  }

  const paneIndex = paneManager.getPaneIndex(paneId);
  if (paneIndex === -1) return;
  if (st.panes.length === 1) { void bridge.closeWindow().catch(reportError); return; }
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
    searchInputEl.classList.remove('no-match', 'regex-error');
    return;
  }
  if (_searchRegex) {
    try { new RegExp(term); }
    catch {
      searchInputEl.classList.add('regex-error');
      searchCountEl.textContent = 'Invalid regex';
      return;
    }
  }
  searchInputEl.classList.remove('regex-error');
  const opts = { decorations: SEARCH_DECORATION_OPTS, incremental };
  if (_searchRegex) opts.regex = true;
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
  searchInputEl.classList.remove('no-match', 'regex-error');
  searchResultsPanelEl?.classList.add('is-hidden');
  if (searchResultsPanelEl) searchResultsPanelEl.innerHTML = '';
  clearTimeout(_crossPaneDebounceTimer);
  _searchAllPanes = false;
  searchAllPanesEl?.classList.remove('is-active');
  searchAllPanesEl?.setAttribute('aria-pressed', 'false');
  paneNodeMap.get(st.focusedPaneId)?.terminal.focus();
}

function toggleSearch() {
  if (searchBarEl.classList.contains('is-hidden')) { openSearch(); } else { closeSearch(); }
}

function runCrossPane() {
  if (!searchResultsPanelEl) return;
  const term = searchInputEl?.value ?? '';
  if (!term || !_searchAllPanes) {
    searchResultsPanelEl.classList.add('is-hidden');
    searchResultsPanelEl.innerHTML = '';
    return;
  }

  let matchFn;
  try {
    if (_searchRegex) {
      const re = new RegExp(term, 'gi');
      matchFn = (line) => { re.lastIndex = 0; return re.test(line); };
    } else {
      const lower = term.toLowerCase();
      matchFn = (line) => line.toLowerCase().includes(lower);
    }
  } catch { return; }

  const results = [];
  for (const pane of st.panes) {
    // Scan all split panels in this tab, not just the focused one.
    const panelIds = collectPanelIds(getTabLayout(pane));
    for (const panelId of panelIds) {
      const node = paneNodeMap.get(panelId);
      if (!node?.terminal) continue;
      const buf = node.terminal.buffer.active;
      const len = buf.length;
      const matches = [];
      // Cap at last 5000 lines for performance.
      for (let i = Math.max(0, len - 5000); i < len; i++) {
        const lineText = buf.getLine(i)?.translateToString(false) ?? '';
        if (matchFn(lineText)) {
          matches.push({ preview: lineText.trimEnd().slice(0, 80) });
          if (matches.length >= 20) break;
        }
      }
      if (matches.length > 0) {
        results.push({ pane, panelId, matches });
      }
    }
  }

  searchResultsPanelEl.innerHTML = '';
  if (results.length === 0) {
    searchResultsPanelEl.classList.remove('is-hidden');
    const empty = document.createElement('div');
    empty.className = 'search-results-empty';
    empty.textContent = 'No matches (last 5000 lines per panel)';
    searchResultsPanelEl.appendChild(empty);
    return;
  }

  searchResultsPanelEl.classList.remove('is-hidden');
  for (const { pane, panelId, matches } of results) {
    const paneLabel = pane.title || pane.terminalTitle || pane.id;
    const section = document.createElement('div');
    section.className = 'search-results-section';

    const header = document.createElement('div');
    header.className = 'search-results-header';
    header.textContent = `${paneLabel}  (${matches.length}${matches.length >= 20 ? '+' : ''})`;
    section.appendChild(header);

    for (const { preview } of matches.slice(0, 5)) {
      const item = document.createElement('div');
      item.className = 'search-results-item';
      item.textContent = preview;
      item.title = preview;
      item.addEventListener('click', () => {
        paneManager.focusSplitPanel(panelId);
        // Double-rAF: first frame finishes layout, second frame focus is settled.
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const node2 = paneNodeMap.get(panelId);
          if (!node2?.searchAddon) return;
          const opts2 = { decorations: SEARCH_DECORATION_OPTS };
          if (_searchRegex) opts2.regex = true;
          node2.searchAddon.findNext(term, opts2);
          searchResultsPanelEl.classList.add('is-hidden');
        }));
      });
      section.appendChild(item);
    }
    searchResultsPanelEl.appendChild(section);
  }
}

searchAllPanesEl?.addEventListener('click', () => {
  _searchAllPanes = !_searchAllPanes;
  searchAllPanesEl.classList.toggle('is-active', _searchAllPanes);
  searchAllPanesEl.setAttribute('aria-pressed', String(_searchAllPanes));
  if (_searchAllPanes) runCrossPane();
  else { searchResultsPanelEl.classList.add('is-hidden'); searchResultsPanelEl.innerHTML = ''; }
});

searchInputEl.addEventListener('input', () => {
  runSearch('next', { incremental: true });
  clearTimeout(_crossPaneDebounceTimer);
  _crossPaneDebounceTimer = setTimeout(runCrossPane, 200);
});
searchInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); runSearch(e.shiftKey ? 'prev' : 'next'); }
  else if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
});
searchPrevEl.addEventListener('click', () => runSearch('prev'));
searchNextEl.addEventListener('click', () => runSearch('next'));
searchCloseEl.addEventListener('click', closeSearch);
searchRegexEl?.addEventListener('click', () => {
  _searchRegex = !_searchRegex;
  searchRegexEl.classList.toggle('is-active', _searchRegex);
  searchRegexEl.setAttribute('aria-pressed', String(_searchRegex));
  runSearch('next', { incremental: true });
});

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

const IMAGE_PASTE_TRIGGER = '\x16'; // SYN (^V) — triggers iTerm2-compatible image paste protocol

async function pasteImageIntoTerminal(paneId = st.focusedPaneId, options = {}) {
  const node = paneManager.getPaneNode(paneId);
  if (!node?.sessionReady) return false;
  const snap = options.clipboardSnapshot ?? (await getClipboardSnapshot());
  if (!snap.hasImage) return false;
  bridge.writeTerminal({ paneId: node.paneId, data: IMAGE_PASTE_TRIGGER });
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

  const dialog = document.createElement('div');
  dialog.className = 'color-picker-dialog';

  const header = document.createElement('div');
  header.className = 'color-picker-header';
  const headerTitle = document.createElement('span');
  headerTitle.textContent = 'Pane Color';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'color-picker-close';
  closeBtn.setAttribute('type', 'button');
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', () => picker.remove());
  header.appendChild(headerTitle);
  header.appendChild(closeBtn);

  const presets = document.createElement('div');
  presets.className = 'color-picker-presets';
  for (const color of ColorsRegistry.PRESET_PANE_COLORS) {
    const btn = document.createElement('button');
    btn.className = 'color-preset';
    btn.classList.toggle('is-selected', color === currentColor);
    btn.style.setProperty('--color', color);
    btn.dataset.color = color;
    btn.setAttribute('type', 'button');
    btn.setAttribute('aria-label', 'Select ' + color);
    btn.addEventListener('click', () => { setPaneColor(paneId, color); picker.remove(); });
    presets.appendChild(btn);
  }

  const custom = document.createElement('div');
  custom.className = 'color-picker-custom';
  const customLabel = document.createElement('label');
  customLabel.textContent = 'Custom:';
  const colorInput = document.createElement('input');
  colorInput.setAttribute('type', 'color');
  colorInput.value = currentColor || '#000000';
  colorInput.addEventListener('input', () => { setPaneColor(paneId, colorInput.value); });
  customLabel.appendChild(colorInput);
  custom.appendChild(customLabel);

  const footer = document.createElement('div');
  footer.className = 'color-picker-footer';
  const clearBtn = document.createElement('button');
  clearBtn.setAttribute('type', 'button');
  clearBtn.className = 'color-picker-clear';
  clearBtn.textContent = 'Clear Color';
  clearBtn.addEventListener('click', () => { clearPaneColor(paneId); picker.remove(); });
  footer.appendChild(clearBtn);

  dialog.appendChild(header);
  dialog.appendChild(presets);
  dialog.appendChild(custom);
  dialog.appendChild(footer);
  picker.appendChild(dialog);

  picker.addEventListener('click', (e) => { if (e.target === picker) picker.remove(); });
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
    mruOrder: st.paneMruOrder,
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

  if (action === 'ssh-connections') {
    openSettingsToTab('appearance');
    openSshConnectionsSubPage();
    return;
  }
  if (action.startsWith('ssh-open-')) {
    const profileId = action.slice('ssh-open-'.length);
    paneManager.addPane({ shellProfileId: profileId });
    return;
  }
  if (action.startsWith('ssh-host-')) {
    const alias = action.slice('ssh-host-'.length);
    const existingId = `ssh-config-${alias}`;
    if (settingsUI.getShellProfiles().find((p) => p.id === existingId)) {
      paneManager.addPane({ shellProfileId: existingId });
    } else {
      const profile = { id: existingId, name: alias, kind: 'ssh', command: 'ssh', args: ['-t', '--', alias], sshConfig: { host: alias } };
      bridge.addShellProfile(profile).then(() => {
        loadShellProfiles();
        paneManager.addPane({ shellProfileId: existingId });
      }).catch(reportError);
    }
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
  clearScrollback: () => { const node = paneNodeMap.get(st.focusedPaneId); if (node) node.terminal.clear(); },
  scrollToTop:     () => { const node = paneNodeMap.get(st.focusedPaneId); if (node) node.terminal.scrollToTop(); },
  scrollToBottom:  () => { const node = paneNodeMap.get(st.focusedPaneId); if (node) node.terminal.scrollToBottom(); },
  scrollPageUp:    () => { const node = paneNodeMap.get(st.focusedPaneId); if (node) node.terminal.scrollPages(-1); },
  scrollPageDown:  () => { const node = paneNodeMap.get(st.focusedPaneId); if (node) node.terminal.scrollPages(1); },
  newWindow: () => { void bridge.newWindow?.().catch(reportError); },
});

const dispatchKeydown = createDispatcher({
  getKeymap: ShortcutsRegistry.getActiveKeymap,
  actions: keyboardActions,
  getMode: () => st.currentMode,
  isInputFocused: () => {
    const el = document.activeElement;
    if (!el) return false;
    // Exclude xterm's hidden helper textarea so terminal shortcuts still fire.
    if (el.classList.contains('xterm-helper-textarea')) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  },
  isCommandPaletteOpen,
});

window.addEventListener('keydown', dispatchKeydown, true);

const onWindowKeyup = (event) => {
  if (paneManager && st.paneCycleState && (event.key === 'Control' || event.key === 'Meta')) {
    paneManager.commitPaneCycle();
  }
};
window.addEventListener('keyup', onWindowKeyup);

const onWindowFocus = () => {
  // Re-focus the active terminal whenever the window regains OS focus.
  // This is especially important for new windows where terminal.focus() may
  // have been called before the OS granted focus to the window, causing the
  // call to be silently ignored and leaving keyboard input non-functional.
  const focusedPanelId = st.panes.find((p) => p.id === st.focusedPaneId)?.focusedPanelId ?? st.focusedPaneId;
  const node = paneNodeMap.get(focusedPanelId);
  if (node?.sessionReady) node.terminal.focus();
};
window.addEventListener('focus', onWindowFocus);

const onWindowBlur = () => {
  if (paneManager && st.paneCycleState) paneManager.commitPaneCycle();
};
window.addEventListener('blur', onWindowBlur);

addPaneButtonEl.addEventListener('click', () => {
  try { paneManager.addPane(); } catch (error) { reportError(error); }
});

// ── Session restore ───────────────────────────────────────────────────────────

function restoreSession(session) {
  const validPanes = (session.panes ?? [])
    .filter((p) => p && typeof p.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(p.accent))
    .map((p, index) => {
      const id = `${_panePrefix}p${index + 1}`;
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
let _resizeRafId = null;
const onWindowResize = () => {
  if (_resizeRafId === null) {
    _resizeRafId = requestAnimationFrame(() => {
      _resizeRafId = null;
      try { layoutRenderer.renderPanes(false); } catch (error) { reportError(error); }
    });
  }
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => {
    try { layoutRenderer.render(true); } catch (error) { reportError(error); }
  }, 120);
};
window.addEventListener('resize', onWindowResize);

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

    if (_winLabel === 'main' && savedSettings?.session?.panes?.length > 0) {
      restoreSession(savedSettings.session);
    } else if (_winLabel !== 'main') {
      // New window: start with a single fresh tab.
      const p = _initialPanes[0];
      st.panes = [{ ...p, cwd: bridge.defaultCwd, terminalTitle: bridge.defaultTabTitle }];
      st.focusedPaneId = p.id;
      st.paneMruOrder = [p.id];
      st.nextPaneNumber = 2;
    } else {
      st.panes = st.panes.map((p) =>
        p.title === null ? { ...p, cwd: bridge.defaultCwd, terminalTitle: bridge.defaultTabTitle } : p
      );
    }

    // Wait for web fonts before the first fit so xterm measures correct
    // character dimensions rather than falling back to the system font.
    await document.fonts.ready;
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
  window.removeEventListener('keydown', dispatchKeydown, true);
  window.removeEventListener('keyup', onWindowKeyup);
  window.removeEventListener('focus', onWindowFocus);
  window.removeEventListener('blur', onWindowBlur);
  window.removeEventListener('resize', onWindowResize);
  window.removeEventListener('error', onWindowError);
  window.removeEventListener('unhandledrejection', onUnhandledRejection);
  if (_resizeRafId !== null) { cancelAnimationFrame(_resizeRafId); _resizeRafId = null; }
});


const onWindowError = (event) => { reportError(event.error || event.message); };
const onUnhandledRejection = (event) => { reportError(event.reason); };
window.addEventListener('error', onWindowError);
window.addEventListener('unhandledrejection', onUnhandledRejection);

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
