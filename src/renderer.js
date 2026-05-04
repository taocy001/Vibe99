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
import { renderHintBar } from './hint-bar.js';
import { showContextMenu, hideContextMenu } from './context-menu.js';
import { t, setLocale, getLocale, SUPPORTED_LOCALES } from './i18n.js';
import {
  leaf as layoutLeaf,
  split as layoutSplit,
  computeLayout,
  collectDividers,
  replaceLeaf,
  removeLeaf,
  collectPanelIds,
  serializeLayout,
  deserializeLayout,
  DIVIDER_PX,
  MIN_RATIO,
  MAX_RATIO,
} from './split-layout.js';

function getRuntimePlatform() {
  const platform = navigator.platform.toLowerCase();
  if (platform.includes('win')) {
    return 'win32';
  }
  if (platform.includes('mac')) {
    return 'darwin';
  }
  return 'linux';
}

function getDefaultFontFamily(platform = getRuntimePlatform()) {
  if (platform === 'win32' || platform === 'windows') {
    return 'Consolas, monospace';
  }
  if (platform === 'darwin') {
    return 'Menlo, monospace';
  }
  return "'DejaVu Sans Mono', monospace";
}

function basename(path) {
  return path.replace(/\/+$/, '').split('/').pop() || '/';
}

function splitArgs(str) {
  const args = [];
  let cur = '';
  let inQuote = false;
  let quoteChar = '';
  for (const ch of str) {
    if (inQuote) {
      if (ch === quoteChar) { inQuote = false; } else { cur += ch; }
    } else if (ch === '"' || ch === "'") {
      inQuote = true;
      quoteChar = ch;
    } else if (/\s/.test(ch)) {
      if (cur) { args.push(cur); cur = ''; }
    } else {
      cur += ch;
    }
  }
  if (cur) { args.push(cur); }
  return args;
}

// Converts a string array back to a shell-quoted command-line string.
// This is the inverse of splitArgs(): formatArgs(splitArgs(s)) === s for any s.
function formatArgs(args) {
  return args.map((arg) => {
    // Arguments needing quoting: contain spaces, double quotes, backslashes, or are empty.
    if (arg === '' || /[\s"]/.test(arg) || /\\/.test(arg)) {
      // Escape backslashes and double quotes before wrapping in double quotes.
      const escaped = arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      return `"${escaped}"`;
    }
    return arg;
  }).join(' ');
}


function createUnavailableBridge() {
  const fail = () => {
    throw new Error('Tauri bridge is unavailable');
  };

  const defaultCwd = '/';

  return {
    platform: getRuntimePlatform(),
    defaultCwd,
    defaultTabTitle: basename(defaultCwd),
    createTerminal: fail,
    writeTerminal: fail,
    resizeTerminal: fail,
    destroyTerminal: fail,
    closeWindow: fail,
    readClipboardText: () => Promise.reject(new Error('Clipboard bridge is unavailable')),
    writeClipboardText: fail,
    getClipboardSnapshot: () => ({ text: '', hasImage: false }),
    openExternalUrl: fail,
    showContextMenu: fail,
    loadSettings: () => Promise.resolve({}),
    saveSettings: () => Promise.resolve({}),
    listShellProfiles: () => Promise.resolve({ profiles: [], defaultProfile: '' }),
    addShellProfile: fail,
    removeShellProfile: fail,
    setDefaultShellProfile: fail,
    detectShellProfiles: () => Promise.resolve([]),
    installShellIntegration: fail,
    setWindowTheme: () => Promise.resolve(),
    setWindowTitle: () => Promise.resolve(),
    getSystemInfo: () => Promise.resolve({ username: '', hostname: '' }),
    onTerminalData: () => () => {},
    onTerminalExit: () => () => {},
    onMenuAction: () => () => {},
    onOpenSettings: () => () => {},
    cwdReady: Promise.resolve(),
  };
}

function createTauriBridge(tauri) {
  const { invoke } = tauri.core;
  const { getCurrentWindow } = tauri.window;
  const { readText: clipboardReadText, writeText: clipboardWriteText } =
    tauri.clipboardManager;
  const { openUrl } = tauri.opener;

  function base64Encode(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    return btoa(binary);
  }

  function onTauriEvent(event, handler) {
    const unlisten = tauri.event.listen(event, (e) => handler(e.payload));
    return () => unlisten.then((fn) => fn());
  }

  // Resolve the real CWD from the Tauri backend so the initial tab title
  // shows the directory basename (e.g. "/home/yar/projects" → "projects").
  let _resolvedCwd = '.';
  const _cwdReady = invoke('get_cwd')
    .then((cwd) => { _resolvedCwd = cwd; })
    .catch(() => {});

  return {
    platform: getRuntimePlatform(),
    get defaultCwd() { return _resolvedCwd; },
    get defaultTabTitle() { return basename(_resolvedCwd); },
    createTerminal: (payload) =>
      invoke('terminal_create', {
        paneId: payload.paneId,
        cols: payload.cols,
        rows: payload.rows,
        cwd: payload.cwd,
        shellProfileId: payload.shellProfileId ?? null,
      }),
    writeTerminal: (payload) =>
      invoke('terminal_write', {
        paneId: payload.paneId,
        data: base64Encode(payload.data),
      }),
    resizeTerminal: (payload) =>
      invoke('terminal_resize', {
        paneId: payload.paneId,
        cols: payload.cols,
        rows: payload.rows,
      }),
    destroyTerminal: (payload) =>
      invoke('terminal_destroy', { paneId: payload.paneId }),
    closeWindow: () => getCurrentWindow().close(),
    exitApp: () => invoke('exit_app'),
    readClipboardText: () => clipboardReadText(),
    writeClipboardText: (text) => clipboardWriteText(text),
    getClipboardSnapshot: async () => {
      try {
        const text = await clipboardReadText();
        return { text: text ?? '', hasImage: false };
      } catch {
        return { text: '', hasImage: false };
      }
    },
    openExternalUrl: (url) => openUrl(url),
    showContextMenu: () => {},
    loadSettings: () => invoke('settings_load'),
    saveSettings: (payload) => invoke('settings_save', { settings: payload }),
    listShellProfiles: () => invoke('shell_profiles_list'),
    addShellProfile: (profile) => invoke('shell_profile_add', { profile }),
    removeShellProfile: (profileId) => invoke('shell_profile_remove', { profileId }),
    setDefaultShellProfile: (profileId) => invoke('shell_profile_set', { profileId }),
    detectShellProfiles: () => invoke('shell_profiles_detect'),
    installShellIntegration: () => invoke('install_shell_integration'),
    setWindowTheme: (mode) => invoke('set_window_theme', { mode }),
    setWindowTitle: (title) => getCurrentWindow().setTitle(title).catch(() => {}),
    getSystemInfo: () => invoke('get_system_info'),
    onTerminalData: (handler) => onTauriEvent('vibe99:terminal-data', handler),
    onTerminalExit: (handler) => onTauriEvent('vibe99:terminal-exit', handler),
    onMenuAction: (handler) => onTauriEvent('vibe99:menu-action', handler),
    onOpenSettings: (handler) => onTauriEvent('open-settings', handler),
    cwdReady: _cwdReady,
  };
}

const bridge = window.__TAURI__
  ? createTauriBridge(window.__TAURI__)
  : window.vibe99 ?? createUnavailableBridge();

const initialPanes = [
  {
    id: 'p1',
    title: null,
    terminalTitle: bridge.defaultTabTitle,
    cwd: bridge.defaultCwd,
    accent: ColorsRegistry.ACCENT_PALETTE[0],
    shellProfileId: null,
    layout: null,
    focusedPanelId: 'p1',
  },
  {
    id: 'p2',
    title: null,
    terminalTitle: bridge.defaultTabTitle,
    cwd: bridge.defaultCwd,
    accent: ColorsRegistry.ACCENT_PALETTE[1],
    shellProfileId: null,
    layout: null,
    focusedPanelId: 'p2',
  },
  {
    id: 'p3',
    title: null,
    terminalTitle: bridge.defaultTabTitle,
    cwd: bridge.defaultCwd,
    accent: ColorsRegistry.ACCENT_PALETTE[2],
    shellProfileId: null,
    layout: null,
    focusedPanelId: 'p3',
  },
];


let panes = initialPanes.map((pane) => ({ ...pane }));
let focusedPaneId = panes[0].id;
let nextPaneNumber = panes.length + 1;
let renamingPaneId = null;
let isRenderingTabs = false; // Guard against re-entrant renderTabs calls
let _tabsLastSig = '';
let _tabsLastFocused = -1;
let dragState = null;
let currentMode = 'terminal'; // 'terminal' | 'nav'
let enterNavSourcePaneId = null; // Track which pane was focused when entering nav mode
let pendingTabFocus = null;
let sessionRestoreComplete = false;

// Mode management
function setMode(next) {
  if (currentMode === next) return;
  currentMode = next;
  document.body.classList.toggle('is-navigation-mode', currentMode === 'nav');
  render();
}

// Most-recently-used pane stack for Ctrl+` cycling. Index 0 is the most
// recently visited pane (typically equals focusedPaneId when no cycle is in
// progress). All current pane IDs always appear exactly once.
let paneMruOrder = panes.map((pane) => pane.id);

// Transient state while the user is cycling with the modifier still held.
// `snapshot` freezes the MRU order at the start of the cycle so repeated
// presses step through a stable list. `index` points into that snapshot.
// `null` means no cycle is in progress.
let paneCycleState = null;

const paneNodeMap = new Map();

// panelId → { cwd, shellProfileId, accent, breathingMonitor } for split panels
const panelDataMap = new Map();
let nextPanelSeq = 1;
function genPanelId() { return `panel-${nextPanelSeq++}`; }

// Centralized panel teardown: cleans every registry and disposes the xterm
// instance. Always call this instead of manually removing from each map.
function destroyPanelNode(panelId, node, { destroyTerminal = true } = {}) {
  // If the destroyed panel was the search target, clear its decorations first.
  if (!searchBarEl?.classList.contains('is-hidden') && focusedPaneId === panelId) {
    node.searchAddon?.clearDecorations();
  }
  paneActivityWatcher.forget(panelId);
  if (destroyTerminal) bridge.destroyTerminal({ paneId: panelId });
  node.terminal.dispose();
  node.root.remove();
  paneNodeMap.delete(panelId);
  panelDataMap.delete(panelId);
  activeCwdMap.delete(panelId);
}

function validCwd(cwd) {
  if (typeof cwd !== 'string' || !cwd || cwd === '/' || cwd === '.') return bridge.defaultCwd;
  return cwd;
}

// Return a display-friendly path with the home directory replaced by '~'.
function abbreviatePath(path) {
  if (!path) return '';
  const home = bridge.defaultCwd;
  if (!home) return path;
  if (path === home) return '~';
  if (path.startsWith(home + '/') || path.startsWith(home + '\\')) {
    return '~' + path.slice(home.length);
  }
  return path;
}

// panelId → current working directory, updated live by OSC 7 sequences.
const activeCwdMap = new Map();

// Username and hostname for \u, \h, \H format variables — fetched once at startup.
let sysInfo = { username: '', hostname: '' };
bridge.getSystemInfo().then((info) => { sysInfo = info; }).catch(() => {});

// Shared PS1-compatible format string expansion used by both window title and status bar.
// Variables: \w abbrev-cwd  \W cwd-basename  \u username  \h short-host  \H full-host  \p panel-indicator
function expandTitleVars(fmt, focusedPane, panelIndicator = '') {
  const activePanelId = focusedPane?.focusedPanelId ?? focusedPane?.id;
  const rawCwd = activeCwdMap.get(activePanelId)
    ?? panelDataMap.get(activePanelId)?.cwd
    ?? focusedPane?.cwd
    ?? '';
  const abbrCwd = abbreviatePath(rawCwd);
  const cwdBase = abbrCwd ? (abbrCwd === '~' ? '~' : basename(abbrCwd)) : '';
  const shortHost = sysInfo.hostname.split('.')[0];
  return fmt
    .replace(/\\w/g, abbrCwd)
    .replace(/\\W/g, cwdBase)
    .replace(/\\u/g, sysInfo.username)
    .replace(/\\H/g, sysInfo.hostname)
    .replace(/\\h/g, shortHost)
    .replace(/\\p/g, panelIndicator);
}

function getPanelIndicator(focusedPane) {
  if (!focusedPane?.layout) return '';
  const activePanelId = focusedPane.focusedPanelId ?? focusedPane.id;
  const ids = collectPanelIds(focusedPane.layout);
  return ids.length > 1 ? `  ·  ${ids.indexOf(activePanelId) + 1}/${ids.length}` : '';
}

function formatWindowTitle(fmt) {
  const focusedPane = panes[getFocusedIndex()];
  return expandTitleVars(fmt, focusedPane, getPanelIndicator(focusedPane));
}

function formatStatusBar(fmt) {
  const focusedPane = panes[getFocusedIndex()];
  return expandTitleVars(fmt, focusedPane, getPanelIndicator(focusedPane));
}

// splitNode (object identity) → HTMLElement for split dividers
const splitDividerElMap = new Map();
// el (WeakMap) → { splitNode, direction, usableSize } — updated each render
const splitDividerDataMap = new WeakMap();

const stageEl = document.getElementById('stage');

const MAX_DIVIDERS = 10;
const dividerEls = Array.from({ length: MAX_DIVIDERS }, () => {
  const el = document.createElement('div');
  el.className = 'pane-divider';
  el.style.display = 'none';
  stageEl.appendChild(el);
  return el;
});

// RAF-throttle: drop mousemove callbacks that arrive faster than one animation
// frame.  The latest event is always used so no state is lost.
// Call .cancel() in the corresponding mouseup to discard any pending frame,
// preventing a stale RAF from firing against a newly-started drag.
function rafThrottle(fn) {
  let raf = null;
  let latest = null;
  function throttled(e) {
    latest = e;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = null;
      fn(latest);
    });
  }
  throttled.cancel = () => {
    if (raf !== null) {
      cancelAnimationFrame(raf);
      raf = null;
    }
  };
  return throttled;
}

let dividerDrag = null;

dividerEls.forEach((el) => {
  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const dividerIndex = parseInt(el.dataset.dividerIndex, 10);
    const focusedIndex = getFocusedIndex();
    const stageWidth = stageEl.clientWidth;
    const previewWidth = getPreviewWidth(stageWidth, panes.length);
    const initialDividerX = getPaneLeft(dividerIndex, previewWidth, focusedIndex);
    dividerDrag = {
      el,
      startX: e.clientX,
      initialPaneWidth: settings.paneWidth,
      dividerIndex,
      focusedIndex,
      paneCount: panes.length,
      stageWidth,
      initialDividerX,
      isLeftOfFocused: dividerIndex <= focusedIndex,
    };
    el.classList.add('is-dragging');
    document.body.style.cursor = 'col-resize';
  });
});

const onDividerMouseMove = rafThrottle((e) => {
  if (!dividerDrag) return;
  const { startX, initialDividerX, focusedIndex, paneCount, stageWidth, isLeftOfFocused, initialPaneWidth } = dividerDrag;
  const dx = e.clientX - startX;
  let newPaneWidth;
  if (isLeftOfFocused && focusedIndex > 0) {
    const newX = Math.max(10, initialDividerX + dx);
    newPaneWidth = stageWidth - (newX / focusedIndex) * (paneCount - 1);
  } else {
    newPaneWidth = initialPaneWidth + dx;
  }
  newPaneWidth = Math.max(400, Math.min(2000, Math.round(newPaneWidth)));
  if (newPaneWidth !== settings.paneWidth) {
    settings.paneWidth = newPaneWidth;
    applySettings();
    renderPanes(true);
  }
});
document.addEventListener('mousemove', onDividerMouseMove);

document.addEventListener('mouseup', () => {
  if (!dividerDrag) return;
  onDividerMouseMove.cancel();
  dividerDrag.el.classList.remove('is-dragging');
  document.body.style.cursor = '';
  dividerDrag = null;
  renderPanes(true);
  scheduleSettingsSave();
});

// ── Split divider drag ────────────────────────────────────────────────────────

let splitDividerDrag = null;

stageEl.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  const el = e.target.closest('.pane-split-divider');
  if (!el) return;

  const divData = splitDividerDataMap.get(el);
  if (!divData) return;

  e.preventDefault();
  e.stopPropagation();

  splitDividerDrag = {
    el,
    splitNode: divData.splitNode,
    direction: divData.direction,
    startPos: divData.direction === 'v' ? e.clientX : e.clientY,
    initialRatio: divData.splitNode.ratio,
    usableSize: divData.usableSize,
  };
  el.classList.add('is-dragging');
  document.body.style.cursor = divData.direction === 'v' ? 'col-resize' : 'row-resize';
});

const onSplitDividerMouseMove = rafThrottle((e) => {
  if (!splitDividerDrag) return;
  const { direction, startPos, initialRatio, usableSize, splitNode } = splitDividerDrag;
  const currentPos = direction === 'v' ? e.clientX : e.clientY;
  const delta = currentPos - startPos;
  let newRatio = initialRatio + delta / usableSize;
  newRatio = Math.max(MIN_RATIO, Math.min(MAX_RATIO, newRatio));
  if (Math.abs(newRatio - splitNode.ratio) > 0.0005) {
    splitNode.ratio = newRatio;
    // Skip fitTerminal (refit=false) during drag to avoid forced reflows on
    // every mousemove; refit happens once on mouseup.
    renderPanes(false);
  }
});
document.addEventListener('mousemove', onSplitDividerMouseMove);

document.addEventListener('mouseup', () => {
  if (!splitDividerDrag) return;
  onSplitDividerMouseMove.cancel();
  splitDividerDrag.el.classList.remove('is-dragging');
  document.body.style.cursor = '';
  splitDividerDrag = null;
  renderPanes(true);
  scheduleSettingsSave();
});

// P4-2: Double-click split divider → ratio preset menu
let _pendingRatioNode = null;

stageEl.addEventListener('dblclick', (e) => {
  const el = e.target.closest('.pane-split-divider');
  if (!el) return;
  const divData = splitDividerDataMap.get(el);
  if (!divData) return;
  e.preventDefault();
  e.stopPropagation();

  _pendingRatioNode = divData.splitNode;
  const isV = divData.direction === 'v';
  const items = [
    { label: 'Equal (50/50)',                                   action: 'split-ratio:0.5',  shortcut: Math.abs(divData.splitNode.ratio - 0.5)  < 0.02 ? '✓' : '' },
    { label: isV ? 'Left larger (67/33)'  : 'Top larger (67/33)',    action: 'split-ratio:0.67', shortcut: Math.abs(divData.splitNode.ratio - 0.67) < 0.02 ? '✓' : '' },
    { label: isV ? 'Right larger (33/67)' : 'Bottom larger (33/67)', action: 'split-ratio:0.33', shortcut: Math.abs(divData.splitNode.ratio - 0.33) < 0.02 ? '✓' : '' },
  ];
  showContextMenu(items, e.clientX, e.clientY,
    (action) => handleMenuAction(action, null),
    () => { _pendingRatioNode = null; },
  );
});

const tabsListEl = document.getElementById('tabs-list');
const statusLabelEl = document.getElementById('status-label');
const statusHintEl = document.getElementById('status-hint');
const broadcastIndicatorEl = document.getElementById('broadcast-indicator');
const addPaneButtonEl = document.getElementById('tabs-add');
let broadcastEnabled = false;

// ── Terminal search bar ───────────────────────────────────────────────────────

const searchBarEl = document.getElementById('search-bar');
const searchInputEl = document.getElementById('search-input');
const searchCountEl = document.getElementById('search-count');
const searchPrevEl = document.getElementById('search-prev');
const searchNextEl = document.getElementById('search-next');
const searchCloseEl = document.getElementById('search-close');

function getActiveSearchAddon() {
  return focusedPaneId ? paneNodeMap.get(focusedPaneId)?.searchAddon : null;
}

const SEARCH_DECORATION_OPTS = {
  matchBackground: '#ffdd5540',
  matchBorder: '#ffdd5580',
  matchOverviewRuler: '#ffdd55',
  activeMatchBackground: '#ff990080',
  activeMatchBorder: '#ff9900',
  activeMatchColorOverviewRuler: '#ff9900',
};

// incremental=true only for live typing (expands selection in-place as user types).
// Explicit Next/Prev calls use incremental=false so they always advance past the
// current match.
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
  if (direction === 'next') {
    addon.findNext(term, opts);
  } else {
    addon.findPrevious(term, opts);
  }
  // Count and no-match state are driven by onDidChangeResults; no local update here.
}

function openSearch() {
  searchBarEl.classList.remove('is-hidden');
  searchInputEl.focus();
  searchInputEl.select();
  runSearch('next');
}

function closeSearch() {
  searchBarEl.classList.add('is-hidden');
  const addon = getActiveSearchAddon();
  addon?.clearDecorations();
  searchInputEl.value = '';
  searchCountEl.textContent = '';
  searchInputEl.classList.remove('no-match');
  paneNodeMap.get(focusedPaneId)?.terminal.focus();
}

function toggleSearch() {
  if (searchBarEl.classList.contains('is-hidden')) {
    openSearch();
  } else {
    closeSearch();
  }
}

searchInputEl.addEventListener('input', () => runSearch('next', { incremental: true }));

searchInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    runSearch(e.shiftKey ? 'prev' : 'next');
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeSearch();
  }
});

searchPrevEl.addEventListener('click', () => runSearch('prev'));
searchNextEl.addEventListener('click', () => runSearch('next'));
searchCloseEl.addEventListener('click', closeSearch);

function setBroadcastEnabled(enabled) {
  broadcastEnabled = enabled;
  broadcastIndicatorEl?.classList.toggle('is-active', enabled);
}
const settingsPanelEl = document.getElementById('settings-panel');
const fontSizeRangeEl = document.getElementById('font-size-input');
const fontSizeDisplayEl = document.getElementById('font-size-display');
const scrollbackInputEl = document.getElementById('scrollback-input');
const scrollbackDisplayEl = document.getElementById('scrollback-display');
const fontFamilySelectEl = document.getElementById('font-family-select');
const fontFamilyInputEl = document.getElementById('font-family-input');
const FONT_PRESET_VALUES = new Set(
  Array.from(fontFamilySelectEl.options).map((o) => o.value).filter((v) => v !== '__custom__')
);
const paneWidthRangeEl = document.getElementById('pane-width-range');
const paneWidthValueEl = document.getElementById('pane-width-value');
const paneOpacityRangeEl = document.getElementById('pane-opacity-range');
const paneOpacityValueEl = document.getElementById('pane-opacity-value');
const paneMaskOpacityRangeEl = document.getElementById('pane-mask-alpha-range');
const paneMaskOpacityValueEl = document.getElementById('pane-mask-alpha-value');
const breathingAlertToggleEl = document.getElementById('breathing-alert-toggle');
const showStatusBarToggleEl = document.getElementById('show-status-bar-toggle');
const windowTitleFormatInputEl = document.getElementById('window-title-format');
const statusBarFormatInputEl = document.getElementById('status-bar-format');
const statusBarHintsInputEl = document.getElementById('status-bar-hints');
const colorModeSegmentedEl = document.getElementById('color-mode-segmented');

function applyColorModeUI(mode) {
  colorModeSegmentedEl?.querySelectorAll('.settings-segment').forEach(btn => {
    btn.classList.toggle('is-active', btn.dataset.value === mode);
  });
}
const shellProfilesSettingsBtn = document.getElementById('shell-profiles-settings-btn');
const keyboardShortcutsSettingsBtn = document.getElementById('keyboard-shortcuts-settings-btn');
const shellIntegrationInstallBtn = document.getElementById('shell-integration-install-btn');
const languageSelectEl = document.getElementById('language-select');

// Populate language selector
SUPPORTED_LOCALES.forEach(({ code, label }) => {
  const opt = document.createElement('option');
  opt.value = code;
  opt.textContent = label;
  languageSelectEl.appendChild(opt);
});

const settings = {
  fontSize: 13,
  fontFamily: getDefaultFontFamily(bridge.platform),
  paneOpacity: 0.8,
  paneMaskOpacity: 0.75,
  paneWidth: 720,
  scrollback: 5000,
  breathingAlertEnabled: true,
  showStatusBar: false,
  colorMode: 'dark',
  language: 'en',
  windowTitleFormat: '\\w',
  statusBarFormat: '\\w\\p',
  statusBarHints: 'cycleRecent,enterNav,newPane,closePane,toggleSearch,splitRight',
};
let pendingSettingsSave = null;

let shellProfiles = [];
let defaultShellProfileId = '';
let editingShellProfile = null; // null or { id?, name, command, args }
let selectedShellProfileId = null; // ID of currently selected profile for editing

// Surface "settled output on a backgrounded pane" via a pulsing mask. The
// watcher just decides *when* a pane should alert; the alert renderer
// decides *how* it looks. To switch styles (border flash, tab badge, …),
// swap `createBreathingMaskAlert` for another renderer with the same shape.
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

const removeTerminalDataListener = bridge.onTerminalData(({ paneId, data }) => {
  const node = paneNodeMap.get(paneId);
  if (!node) return;
  node.terminal.write(data);
  paneActivityWatcher.noteData(paneId);
});

const removeTerminalExitListener = bridge.onTerminalExit(({ paneId, exitCode }) => {
  const node = paneNodeMap.get(paneId);
  if (!node) {
    return;
  }

  // If the terminal was destroyed for a shell change, or the process exited
  // within a short grace period after a shell change, don't close the pane.
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

  const paneIndex = getPaneIndex(paneId);
  if (paneIndex === -1) {
    return;
  }

  if (panes.length === 1) {
    void bridge.exitApp().catch(reportError);
    return;
  }

  closePane(paneIndex, { destroyTerminal: false });
});

const removeMenuActionListener = bridge.onMenuAction(({ action, paneId }) => {
  try {
    handleMenuAction(action, paneId);
  } catch (error) {
    reportError(error);
  }
});

function reportError(error) {
  const message = error instanceof Error ? error.message : String(error);
  statusLabelEl.textContent = `Error: ${message}`;
  statusHintEl.textContent = '';
  console.error(error);
}

function getPreviewWidth(stageWidth, count) {
  if (count <= 1) {
    return 0;
  }

  if (stageWidth >= settings.paneWidth * count) {
    return settings.paneWidth;
  }

  return (stageWidth - settings.paneWidth) / (count - 1);
}

function getPaneLabel(pane) {
  return pane.title ?? pane.terminalTitle ?? '';
}

function applyTranslations() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
}

function applyColorMode(mode) {
  document.documentElement.classList.remove('theme-dark', 'theme-light', 'theme-auto');
  document.documentElement.classList.add(`theme-${mode}`);
  bridge.setWindowTheme(mode).catch(() => {});
  // Re-theme all open terminals
  for (const [, node] of paneNodeMap) {
    const accent = node.accent || '#888888';
    node.terminal.options.theme = createTerminalTheme(accent);
    fixXtermViewportBg(node.terminalHost, mode);
  }
  // xterm.js may update viewport.style.backgroundColor asynchronously
  requestAnimationFrame(() => {
    for (const [, node] of paneNodeMap) {
      fixXtermViewportBg(node.terminalHost, mode);
    }
  });
}

function fixXtermViewportBg(terminalHost, _mode) {
  const vp = terminalHost.querySelector('.xterm-viewport');
  if (vp) vp.style.backgroundColor = resolveEffectiveColorMode() === 'light' ? '#f4f0ea' : '';
}

function applySettings() {
  document.documentElement.style.setProperty('--app-font-size', `${settings.fontSize}px`);
  document.documentElement.style.setProperty('--pane-opacity', settings.paneOpacity.toFixed(2));
  document.documentElement.style.setProperty('--pane-bg-mask-opacity', settings.paneMaskOpacity.toFixed(2));
  document.documentElement.style.setProperty('--pane-width', `${settings.paneWidth}px`);
  fontSizeRangeEl.value = String(settings.fontSize);
  fontSizeDisplayEl.textContent = String(settings.fontSize);
  scrollbackInputEl.value = String(settings.scrollback);
  scrollbackDisplayEl.textContent = String(settings.scrollback);
  if (FONT_PRESET_VALUES.has(settings.fontFamily)) {
    fontFamilySelectEl.value = settings.fontFamily;
    fontFamilySelectEl.classList.remove('is-hidden');
    fontFamilyInputEl.classList.add('is-hidden');
  } else {
    fontFamilySelectEl.value = '__custom__';
    fontFamilySelectEl.classList.add('is-hidden');
    fontFamilyInputEl.value = settings.fontFamily;
    fontFamilyInputEl.classList.remove('is-hidden');
  }
  paneWidthRangeEl.value = String(settings.paneWidth);
  paneWidthValueEl.textContent = `${settings.paneWidth}px`;
  paneOpacityRangeEl.value = settings.paneOpacity.toFixed(2);
  paneOpacityValueEl.textContent = settings.paneOpacity.toFixed(2);
  paneMaskOpacityRangeEl.value = settings.paneMaskOpacity.toFixed(2);
  paneMaskOpacityValueEl.textContent = settings.paneMaskOpacity.toFixed(2);
  breathingAlertToggleEl.checked = settings.breathingAlertEnabled;
  paneActivityWatcher.setGlobalEnabled(settings.breathingAlertEnabled);
  showStatusBarToggleEl.checked = settings.showStatusBar;
  document.body.classList.toggle('hide-status-bar', !settings.showStatusBar);
  applyColorModeUI(settings.colorMode);
  applyColorMode(settings.colorMode);
  languageSelectEl.value = settings.language;
  if (windowTitleFormatInputEl) windowTitleFormatInputEl.value = settings.windowTitleFormat;
  if (statusBarFormatInputEl) statusBarFormatInputEl.value = settings.statusBarFormat;
  if (statusBarHintsInputEl) statusBarHintsInputEl.value = settings.statusBarHints;
}

function applyPersistedSettings(nextSettings) {
  if (!nextSettings || typeof nextSettings !== 'object') {
    return;
  }

  const uiSettings =
    nextSettings && typeof nextSettings.ui === 'object' && nextSettings.ui !== null
      ? nextSettings.ui
      : nextSettings;

  if (Number.isFinite(uiSettings.fontSize)) {
    settings.fontSize = uiSettings.fontSize;
  }

  if (Number.isFinite(uiSettings.scrollback)) {
    settings.scrollback = Math.max(1000, Math.min(50000, uiSettings.scrollback));
  }

  if (typeof uiSettings.fontFamily === 'string') {
    settings.fontFamily = uiSettings.fontFamily;
  }

  if (Number.isFinite(uiSettings.paneOpacity)) {
    settings.paneOpacity = Math.max(0.55, Math.min(1, uiSettings.paneOpacity));
  }

  if (Number.isFinite(uiSettings.paneMaskOpacity)) {
    settings.paneMaskOpacity = Math.max(0, Math.min(1, uiSettings.paneMaskOpacity));
  }

  // Migrate legacy paneMaskAlpha → paneMaskOpacity
  if (Number.isFinite(uiSettings.paneMaskAlpha) && !Number.isFinite(uiSettings.paneMaskOpacity)) {
    settings.paneMaskOpacity = Math.max(0, Math.min(1, uiSettings.paneMaskAlpha));
  }

  // Migrate v3 inverted mask opacity: old value was 1 - overlay opacity.
  if (nextSettings?.version != null && nextSettings.version < 4) {
    settings.paneMaskOpacity = 1 - settings.paneMaskOpacity;
  }

  if (Number.isFinite(uiSettings.paneWidth)) {
    settings.paneWidth = uiSettings.paneWidth;
  }

  if (typeof uiSettings.breathingAlertEnabled === 'boolean') {
    settings.breathingAlertEnabled = uiSettings.breathingAlertEnabled;
  }

  if (typeof uiSettings.showStatusBar === 'boolean') {
    settings.showStatusBar = uiSettings.showStatusBar;
  }

  if (typeof uiSettings.colorMode === 'string') {
    settings.colorMode = uiSettings.colorMode;
  }

  if (typeof uiSettings.language === 'string') {
    settings.language = uiSettings.language;
    setLocale(uiSettings.language);
  }

  if (typeof uiSettings.windowTitleFormat === 'string') {
    settings.windowTitleFormat = uiSettings.windowTitleFormat;
  }

  if (typeof uiSettings.statusBarFormat === 'string') {
    settings.statusBarFormat = uiSettings.statusBarFormat;
  }

  if (typeof uiSettings.statusBarHints === 'string') {
    settings.statusBarHints = uiSettings.statusBarHints;
  }

  // Load keyboard shortcuts
  if (typeof uiSettings.shortcuts === 'object' && uiSettings.shortcuts !== null) {
    ShortcutsRegistry.loadShortcutsFromSettings(uiSettings);
  } else {
    ShortcutsRegistry.loadShortcutsFromSettings({});
  }
}

function buildSessionData() {
  const focusedIndex = getFocusedIndex();
  return {
    panes: panes.map((p) => {
      const base = {
        title: p.title,
        cwd: p.cwd,
        accent: p.accent,
        customColor: p.customColor,
        shellProfileId: p.shellProfileId,
        breathingMonitor: p.breathingMonitor !== false,
      };
      if (p.layout) {
        const serialized = serializeLayout(p.layout, (panelId) => {
          const pd = panelDataMap.get(panelId);
          return {
            isRoot: panelId === p.id,
            cwd: pd?.cwd ?? p.cwd,
            shellProfileId: pd?.shellProfileId ?? p.shellProfileId ?? null,
            breathingMonitor: pd?.breathingMonitor !== false,
          };
        });
        base.layout = serialized;
        base.focusedIsRoot = p.focusedPanelId === p.id;
      }
      return base;
    }),
    focusedPaneIndex: focusedIndex >= 0 ? focusedIndex : 0,
  };
}

function restoreSession(session) {
  const validPanes = (session.panes ?? [])
    .filter((p) => p && typeof p.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(p.accent))
    .map((p, index) => {
      const id = `p${index + 1}`;

      // v5: restore split layout
      let layout = null;
      let focusedPanelId = id;
      if (p.layout && typeof p.layout === 'object') {
        try {
          layout = deserializeLayout(p.layout, (leafData) => {
            const panelId = leafData.isRoot ? id : genPanelId();
            panelDataMap.set(panelId, {
              cwd: validCwd(leafData.cwd),
              shellProfileId: (typeof leafData.shellProfileId === 'string' && leafData.shellProfileId) || null,
              accent: (typeof p.accent === 'string' && p.accent) || '#888888',
              breathingMonitor: leafData.breathingMonitor !== false,
            });
            return panelId;
          });
          // Find which panelId was focused (first leaf with isRoot=true, otherwise first leaf)
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
    panes = initialPanes.map((p) => ({
      ...p,
      cwd: bridge.defaultCwd,
      terminalTitle: bridge.defaultTabTitle,
    }));
    focusedPaneId = panes[0].id;
    nextPaneNumber = panes.length + 1;
    paneMruOrder = panes.map((p) => p.id);
    paneCycleState = null;
    return;
  }

  panes = validPanes;
  const focusedIndex = Math.min(
    Number.isFinite(session.focusedPaneIndex) ? session.focusedPaneIndex : 0,
    panes.length - 1,
  );
  focusedPaneId = panes[Math.max(0, focusedIndex)].id;
  nextPaneNumber = panes.length + 1;
  // Initial MRU order: focused pane first, then remaining panes in tab order.
  paneMruOrder = [focusedPaneId, ...panes.map((p) => p.id).filter((id) => id !== focusedPaneId)];
  paneCycleState = null;
}

function scheduleSettingsSave() {
  if (pendingSettingsSave !== null) {
    window.clearTimeout(pendingSettingsSave);
  }

  pendingSettingsSave = window.setTimeout(() => {
    pendingSettingsSave = null;
    const settingsToSave = {
      version: 5,
      ui: {
        ...settings,
        shortcuts: ShortcutsRegistry.getShortcutsForSave()
      },
      session: buildSessionData()
    };
    bridge.saveSettings(settingsToSave).catch(reportError);
  }, 150);
}

function flushSettingsSave() {
  if (pendingSettingsSave !== null) {
    window.clearTimeout(pendingSettingsSave);
    pendingSettingsSave = null;
    const settingsToSave = {
      version: 5,
      ui: {
        ...settings,
        shortcuts: ShortcutsRegistry.getShortcutsForSave()
      },
      session: buildSessionData()
    };
    void bridge.saveSettings(settingsToSave).catch(reportError);
  }
}

// ----------------------------------------------------------------
// Shell profile management
// ----------------------------------------------------------------

let detectedShellProfiles = [];

function loadShellProfiles() {
  Promise.all([
    bridge.listShellProfiles(),
    bridge.detectShellProfiles().catch(() => []),
  ]).then(([config, detected]) => {
    detectedShellProfiles = detected;
    const userProfiles = config.profiles ?? [];
    const userIds = new Set(userProfiles.map((p) => p.id));
    // Merge: user profiles first, then detected ones not already present.
    shellProfiles = [...userProfiles, ...detected.filter((p) => !userIds.has(p.id))];
    defaultShellProfileId = config.defaultProfile ?? '';
  }).catch(reportError);
}

function createProfileActionButton(label, title, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'settings-btn';
  btn.textContent = label;
  btn.title = title;
  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick();
  });
  return btn;
}

function restartPane(paneId) {
  const node = paneNodeMap.get(paneId);
  if (!node) return;
  node._shellChanging = true;
  node._shellChangeTime = Date.now();
  node.sessionReady = false;
  node.terminal.clear();
  initializePaneTerminal(node).finally(() => {
    node._shellChanging = false;
  });
}

function changePaneShell(paneId, profileId) {
  const node = paneNodeMap.get(paneId);
  if (!node) return;

  const previousProfileId = panes.find((p) => p.id === paneId)?.shellProfileId ?? null;

  panes = panes.map((p) =>
    p.id === paneId ? { ...p, shellProfileId: profileId } : p
  );
  scheduleSettingsSave();

  // Suppress the exit handler — the old PTY is about to be replaced.
  // spawn() on the backend already destroys any previous session.
  node._shellChanging = true;
  node._shellChangeTime = Date.now();
  node.sessionReady = false;
  node.terminal.clear();
  initializePaneTerminal(node).finally(() => {
    node._shellChanging = false;
    // Revert profile on failure so the session doesn't persist a broken profile.
    if (!node.sessionReady) {
      panes = panes.map((p) =>
        p.id === paneId ? { ...p, shellProfileId: previousProfileId } : p
      );
      scheduleSettingsSave();
    }
  });
}

// ----------------------------------------------------------------
// Settings modals for complex settings
// ----------------------------------------------------------------

function openShellProfilesModal(onClose) {
  loadShellProfiles();

  const overlay = document.createElement('div');
  overlay.className = 'settings-modal-overlay';

  overlay.innerHTML = `
    <div class="settings-modal shell-profiles-modal">
      <div class="settings-modal-header">
        <div class="settings-modal-title-group">
          <span>Shell Profiles</span>
          <button type="button" class="shell-profiles-add-btn" id="modal-shell-profile-add" aria-label="Add Profile">+</button>
        </div>
        <button type="button" class="settings-modal-close" aria-label="Close">×</button>
      </div>
      <div class="settings-modal-body shell-profiles-modal-body">
        <div class="shell-profiles-sidebar">
          <div class="shell-profile-list" id="modal-shell-profile-list"></div>
        </div>
        <div class="shell-profiles-editor-panel" id="modal-shell-profile-editor">
          <div class="shell-profiles-editor-placeholder">Select a profile or create a new one</div>
        </div>
      </div>
    </div>
  `;

  const closeModal = () => {
    overlay.remove();
    editingShellProfile = null;
    selectedShellProfileId = null;
    onClose?.();
  };

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });

  overlay.querySelector('.settings-modal-close').addEventListener('click', closeModal);

  // Add profile button
  overlay.querySelector('#modal-shell-profile-add').addEventListener('click', () => {
    editingShellProfile = {
      id: '',
      name: '',
      command: '',
      args: '',
      isNew: true
    };
    selectedShellProfileId = null;
    renderModalShellProfiles();
  });

  document.body.appendChild(overlay);

  // Store reference to modal elements for rendering
  overlay._modalShellProfileList = overlay.querySelector('#modal-shell-profile-list');
  overlay._modalShellProfileEditor = overlay.querySelector('#modal-shell-profile-editor');

  // Select first profile by default if available
  if (shellProfiles.length > 0) {
    const firstProfile = shellProfiles[0];
    selectedShellProfileId = firstProfile.id;
    editingShellProfile = {
      id: firstProfile.id,
      name: firstProfile.name || '',
      command: firstProfile.command,
      args: formatArgs(firstProfile.args ?? []),
      isNew: false
    };
  } else {
    selectedShellProfileId = null;
    editingShellProfile = null;
  }

  renderModalShellProfiles();
}

function renderModalShellProfiles() {
  const overlay = document.querySelector('.settings-modal-overlay');
  if (!overlay || !overlay._modalShellProfileList) return;

  const listEl = overlay._modalShellProfileList;
  const editorEl = overlay._modalShellProfileEditor;

  if (!listEl || !editorEl) return;

  listEl.replaceChildren();
  editorEl.replaceChildren();

  // Render sidebar list
  if (shellProfiles.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'shell-profile-empty';
    empty.textContent = 'No profiles configured';
    listEl.appendChild(empty);
  } else {
    const detectedIds = new Set(detectedShellProfiles.map((p) => p.id));

    for (const profile of shellProfiles) {
      const isDetected = detectedIds.has(profile.id);
      const item = document.createElement('div');
      item.className = `shell-profile-item${profile.id === selectedShellProfileId ? ' is-selected' : ''}${profile.id === defaultShellProfileId ? ' is-default' : ''}${isDetected ? ' is-detected' : ''}`;
      item.dataset.profileId = profile.id;
      item.draggable = !isDetected;

      const name = document.createElement('div');
      name.className = 'shell-profile-name';
      name.textContent = profile.name || profile.id;

      const actions = document.createElement('div');
      actions.className = 'shell-profile-actions';

      // Quick actions: set default, clone, delete
      if (profile.id !== defaultShellProfileId) {
        actions.appendChild(createProfileActionButton('★', 'Set as default', () => {
          const apply = (config) => {
            const userIds = new Set((config.profiles ?? []).map((p) => p.id));
            shellProfiles = [...(config.profiles ?? []), ...detectedShellProfiles.filter((p) => !userIds.has(p.id))];
            defaultShellProfileId = config.defaultProfile ?? '';
            renderModalShellProfiles();
          };
          if (isDetected) {
            bridge.addShellProfile(profile).then(() => {
              bridge.setDefaultShellProfile(profile.id).then(apply).catch(reportError);
            }).catch(reportError);
          } else {
            bridge.setDefaultShellProfile(profile.id).then(apply).catch(reportError);
          }
        }));
      }

      actions.appendChild(createProfileActionButton('⧉', 'Clone profile', () => {
        cloneProfile(profile);
      }));

      if (!isDetected) {
        actions.appendChild(createProfileActionButton('✕', 'Delete', () => {
          if (selectedShellProfileId === profile.id) {
            selectedShellProfileId = null;
            editingShellProfile = null;
          }
          bridge.removeShellProfile(profile.id).then((config) => {
            const userIds = new Set((config.profiles ?? []).map((p) => p.id));
            shellProfiles = [...(config.profiles ?? []), ...detectedShellProfiles.filter((p) => !userIds.has(p.id))];
            defaultShellProfileId = config.defaultProfile ?? '';
            renderModalShellProfiles();
          }).catch(reportError);
        }));
      }

      item.append(name, actions);

      // Click to select (but not when dragging)
      let isDragging = false;
      let dragStartTime = 0;

      item.addEventListener('click', (e) => {
        if (e.target.closest('.shell-profile-actions')) return;
        if (isDragging) return;
        selectedShellProfileId = profile.id;
        editingShellProfile = {
          id: profile.id,
          name: profile.name || '',
          command: profile.command,
          args: formatArgs(profile.args ?? []),
          isNew: false
        };
        renderModalShellProfiles();
      });

      // Drag events for reordering
      if (!isDetected) {
        item.addEventListener('dragstart', (e) => {
          dragStartTime = Date.now();
          isDragging = true;
          item.classList.add('is-dragging');
          e.dataTransfer.setData('text/plain', profile.id);
          e.dataTransfer.effectAllowed = 'move';
          // Set a drag image if possible
          if (e.dataTransfer.setDragImage) {
            e.dataTransfer.setDragImage(item, 0, 0);
          }
        });

        item.addEventListener('dragend', (e) => {
          const dragDuration = Date.now() - dragStartTime;
          // If drag was very short, treat it as a click
          if (dragDuration < 200) {
            isDragging = false;
          }
          setTimeout(() => {
            isDragging = false;
          }, 100);
          item.classList.remove('is-dragging');
          document.querySelectorAll('.shell-profile-item').forEach(el => {
            el.classList.remove('drag-over');
          });
        });

        item.addEventListener('dragover', (e) => {
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = 'move';
          const dragging = document.querySelector('.shell-profile-item.is-dragging');
          if (dragging && dragging !== item) {
            item.classList.add('drag-over');
          }
        });

        item.addEventListener('dragleave', (e) => {
          // Only remove drag-over if we're actually leaving the item
          if (!item.contains(e.relatedTarget)) {
            item.classList.remove('drag-over');
          }
        });

        item.addEventListener('drop', (e) => {
          e.preventDefault();
          e.stopPropagation();
          item.classList.remove('drag-over');
          const draggedId = e.dataTransfer.getData('text/plain');
          const targetId = profile.id;

          if (draggedId !== targetId) {
            reorderProfiles(draggedId, targetId);
          }
        });
      }

      listEl.appendChild(item);
    }
  }

  // Render editor panel
  if (editingShellProfile) {
    editorEl.appendChild(createModalShellProfileEditor());
  } else {
    const placeholder = document.createElement('div');
    placeholder.className = 'shell-profiles-editor-placeholder';
    placeholder.textContent = 'Select a profile or create a new one';
    editorEl.appendChild(placeholder);
  }
}

function cloneProfile(profile) {
  const clonedProfile = {
    id: `${profile.id}-copy-${Date.now()}`,
    name: `${profile.name || profile.id} (副本)`,
    command: profile.command,
    args: profile.args ? [...profile.args] : [],
  };

  bridge.addShellProfile(clonedProfile).then((config) => {
    const userIds = new Set((config.profiles ?? []).map((p) => p.id));
    shellProfiles = [...(config.profiles ?? []), ...detectedShellProfiles.filter((p) => !userIds.has(p.id))];
    defaultShellProfileId = config.defaultProfile ?? '';

    // Enter edit mode with the cloned profile (same as New Profile but with content filled in)
    selectedShellProfileId = clonedProfile.id;
    editingShellProfile = {
      id: clonedProfile.id,
      name: clonedProfile.name,
      command: clonedProfile.command,
      args: formatArgs(clonedProfile.args ?? []),
      isNew: true // Treat as new so user can edit the ID
    };
    renderModalShellProfiles();
  }).catch(reportError);
}

function reorderProfiles(draggedId, targetId) {
  const draggedIndex = shellProfiles.findIndex(p => p.id === draggedId);
  const targetIndex = shellProfiles.findIndex(p => p.id === targetId);

  if (draggedIndex === -1 || targetIndex === -1) return;

  // Remove dragged profile and insert at target position
  const [draggedProfile] = shellProfiles.splice(draggedIndex, 1);
  shellProfiles.splice(targetIndex, 0, draggedProfile);

  // Save the new order (add all profiles to persist order)
  const userProfiles = shellProfiles.filter(p => !detectedShellProfiles.some(dp => dp.id === p.id));
  const savePromises = userProfiles.map(p => bridge.addShellProfile(p));

  Promise.all(savePromises).then(() => {
    renderModalShellProfiles();
  }).catch(reportError);
}

function createModalShellProfileEditor() {
  const editor = document.createElement('div');
  editor.className = 'shell-profile-editor';

  const fields = [
    { key: 'name', label: 'Name (optional)', placeholder: 'e.g. Zsh' },
    { key: 'id', label: 'ID', placeholder: 'e.g. zsh' },
    { key: 'command', label: 'Command', placeholder: '/bin/zsh' },
    { key: 'args', label: 'Arguments', placeholder: '-il' },
  ];

  const inputs = {};
  for (const field of fields) {
    const label = document.createElement('label');
    label.textContent = field.label;
    label.setAttribute('for', `modal-shell-edit-${field.key}`);

    const input = document.createElement('input');
    input.id = `modal-shell-edit-${field.key}`;
    input.type = 'text';
    input.value = editingShellProfile[field.key] ?? '';
    input.placeholder = field.placeholder;
    input.dataset.field = field.key;
    inputs[field.key] = input;

    if (field.key === 'name' && editingShellProfile.isNew) {
      input.addEventListener('input', () => {
        const idInput = inputs.id;
        if (!idInput.value && input.value.trim()) {
          idInput.value = input.value.trim().toLowerCase().replace(/\s+/g, '-');
        }
      });
    }

    editor.append(label, input);
  }

  const actions = document.createElement('div');
  actions.className = 'shell-profile-editor-actions';

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'settings-btn shell-profile-editor-btn';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => {
    editingShellProfile = null;
    selectedShellProfileId = null;
    renderModalShellProfiles();
  });

  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'settings-btn shell-profile-editor-btn is-primary';
  save.textContent = 'Save';
  save.addEventListener('click', () => {
    const profile = {
      id: inputs.id.value.trim(),
      name: inputs.name.value.trim(),
      command: inputs.command.value.trim(),
      args: splitArgs(inputs.args.value.trim()),
    };

    if (!profile.id || !profile.command) {
      reportError(new Error('ID and Command are required'));
      return;
    }

    bridge.addShellProfile(profile).then((config) => {
      const userIds = new Set((config.profiles ?? []).map((p) => p.id));
      shellProfiles = [...(config.profiles ?? []), ...detectedShellProfiles.filter((p) => !userIds.has(p.id))];
      defaultShellProfileId = config.defaultProfile ?? '';

      // Select the newly created/saved profile
      selectedShellProfileId = profile.id;
      editingShellProfile = {
        id: profile.id,
        name: profile.name,
        command: profile.command,
        args: formatArgs(profile.args),
        isNew: false
      };
      renderModalShellProfiles();
    }).catch(reportError);
  });

  actions.append(cancel, save);
  editor.appendChild(actions);

  queueMicrotask(() => {
    const firstInput = editor.querySelector('input');
    if (firstInput) {
      firstInput.focus();
      firstInput.select();
    }
  });

  return editor;
}

function resolveEffectiveColorMode() {
  if (settings.colorMode !== 'auto') return settings.colorMode;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function createTerminalTheme(accent) {
  if (resolveEffectiveColorMode() === 'light') {
    return {
      background: '#f4f0ea',
      foreground: '#383a42',
      cursor: accent,
      cursorAccent: '#ffffff',
      selectionBackground: `${accent}55`,
      black: '#383a42',
      red: '#ca1243',
      green: '#3d8c40',
      yellow: '#c18401',
      blue: '#3b65cc',
      magenta: '#8b1fa8',
      cyan: '#0c7ba1',
      white: '#696c77',
      brightBlack: '#4f525e',
      brightRed: '#e06c75',
      brightGreen: '#50a14f',
      brightYellow: '#986801',
      brightBlue: '#4078f2',
      brightMagenta: '#a626a4',
      brightCyan: '#0184bc',
      brightWhite: '#383a42',
    };
  }
  return {
    background: '#11111100',
    foreground: '#d9d4c7',
    cursor: accent,
    cursorAccent: '#111111',
    selectionBackground: `${accent}44`,
    black: '#111111',
    red: '#ff6b57',
    green: '#98c379',
    yellow: '#e5c07b',
    blue: '#61afef',
    magenta: '#c678dd',
    cyan: '#56b6c2',
    white: '#d9d4c7',
    brightBlack: '#5a6374',
    brightRed: '#ff8578',
    brightGreen: '#b0d98b',
    brightYellow: '#f0d58a',
    brightBlue: '#7eb7ff',
    brightMagenta: '#d9a5e8',
    brightCyan: '#7fd8e6',
    brightWhite: '#ffffff',
  };
}

function isLinkOpenModifierPressed(event) {
  return event.ctrlKey || (bridge.platform === 'darwin' && event.metaKey);
}

function handleTerminalLinkActivation(event, uri) {
  if (!isLinkOpenModifierPressed(event)) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  void bridge.openExternalUrl(uri).catch(reportError);
}

function getFocusedIndex() {
  const focusedIndex = panes.findIndex((pane) => pane.id === focusedPaneId);
  if (focusedIndex !== -1) {
    return focusedIndex;
  }

  focusedPaneId = panes[0]?.id ?? null;
  return panes.length > 0 ? 0 : -1;
}

function getPaneLeft(index, previewWidth, focusedIndex) {
  if (previewWidth >= settings.paneWidth) {
    return index * settings.paneWidth;
  }

  const focusedLeft = focusedIndex * previewWidth;

  if (index < focusedIndex) {
    return index * previewWidth;
  }

  if (index === focusedIndex) {
    return focusedLeft;
  }

  return focusedLeft + settings.paneWidth + (index - focusedIndex - 1) * previewWidth;
}

function getTextColorForBackground(hexColor) {
  const r = parseInt(hexColor.slice(1, 3), 16);
  const g = parseInt(hexColor.slice(3, 5), 16);
  const b = parseInt(hexColor.slice(5, 7), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? '#000' : '#fff';
}

function createTab(pane, index, focusedIndex, dragMeta) {
  const tab = document.createElement('div');
  tab.className = `tab${index === focusedIndex ? ' is-focused' : ''}`;
  if (dragMeta?.isDragging) {
    tab.classList.add('is-dragging');
    tab.style.transform = `translateX(${dragMeta.offsetX}px)`;
  }
  if (dragMeta?.insertBefore) {
    tab.classList.add('insert-before');
  }
  const accentColor = pane.customColor || pane.accent;
  tab.style.setProperty('--pane-accent', accentColor);
  tab.style.setProperty('--tab-text-color', getTextColorForBackground(accentColor));
  tab.dataset.paneId = pane.id;
  tab.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    void showTabContextMenu(pane.id, event);
  });

  const tabMain = document.createElement('button');
  tabMain.type = 'button';
  tabMain.className = 'tab-main';
  tabMain.setAttribute('aria-pressed', String(index === focusedIndex));
  tabMain.addEventListener('pointerdown', (event) => {
    beginTabDrag(index, event);
  });
  tabMain.addEventListener('dblclick', (event) => {
    event.preventDefault();
    beginRenamePane(index);
  });

  const swatch = document.createElement('span');
  swatch.className = 'tab-swatch';

  // Show number badge in navigation mode
  if (currentMode === 'nav') {
    swatch.textContent = String(index + 1);
    // Apply text color based on accent color brightness
    swatch.style.setProperty('--swatch-text-color', 'var(--tab-text-color)');
  }

  let label;
  if (renamingPaneId === pane.id) {
    label = document.createElement('input');
    label.className = 'tab-input';
    label.type = 'text';
    label.value = getPaneLabel(pane);
    label.setAttribute('aria-label', `Rename tab ${pane.id}`);
    label.addEventListener('click', (event) => {
      event.stopPropagation();
    });
    label.addEventListener('mousedown', (event) => {
      event.stopPropagation();
    });
    label.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        commitRenamePane(pane.id, label.value);
      }

      if (event.key === 'Escape') {
        cancelRenamePane();
      }
    });
    label.addEventListener('blur', () => {
      commitRenamePane(pane.id, label.value);
    });
    queueMicrotask(() => {
      label.focus();
      label.select();
    });
  } else {
    label = document.createElement('span');
    label.className = 'tab-label';
    label.textContent = getPaneLabel(pane);
  }

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'tab-close';
  close.textContent = '×';
  close.setAttribute('aria-label', `Close tab ${pane.id}`);

  // Show pending close state
  if (pendingClosePaneId === pane.id) {
    close.classList.add('pending-close');
    close.textContent = '?';
  }

  close.addEventListener('click', (event) => {
    event.stopPropagation();
    closePane(index);
  });

  tabMain.append(swatch, label);
  tab.append(tabMain, close);
  return tab;
}

function createPane(pane, { tabId = null } = {}) {
  const owningTabId = tabId ?? pane.id;
  const isSplitPanel = tabId !== null;
  // Seed the live cwd map from the stored pane cwd so the window title
  // shows a useful path immediately, before any OSC 7 update arrives.
  if (pane.cwd) activeCwdMap.set(pane.id, pane.cwd);
  const paneEl = document.createElement('article');
  paneEl.className = 'pane';
  const accentColor = pane.customColor || pane.accent;
  paneEl.style.setProperty('--pane-accent', accentColor);
  // Release the GPU compositor layer once the slide animation ends.
  paneEl.addEventListener('transitionend', (e) => {
    if (e.propertyName === 'transform') {
      paneEl.style.willChange = '';
    }
  });
  paneEl.addEventListener('click', () => {
    focusSplitPanel(pane.id);
  });

  // Panel header — only visible when has-splits (via CSS)
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
    // Close this specific panel (always context-sensitive via closeActivePanel after focusing it)
    focusSplitPanel(pane.id, { focusTerminal: false });
    closeActivePanel();
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
    if (focusedPaneId !== pane.id) return;
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
      ? (terminal.options.fastScrollSensitivity ?? 5)
      : 1;
    let lines;
    if (ev.deltaMode === WheelEvent.DOM_DELTA_LINE) {
      lines = ev.deltaY * fastMult;
    } else if (ev.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
      lines = Math.round(ev.deltaY * terminal.rows * fastMult);
    } else {
      // DOM_DELTA_PIXEL — macOS trackpad; normalize to cell height in CSS px
      const pixelsPerLine = terminal.options.fontSize * terminal.options.lineHeight;
      _scrollAccum += (ev.deltaY / pixelsPerLine) * fastMult;
      lines = Math.trunc(_scrollAccum);
      _scrollAccum -= lines;
    }
    if (lines !== 0) terminal.scrollLines(lines);
  }, { capture: true, passive: false });

  terminal.attachCustomKeyEventHandler((event) => {
    // Ctrl+Tab is reserved for pane MRU cycling — never let xterm forward
    // the literal Tab keystroke to the PTY.
    if (
      event.type === 'keydown' &&
      event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      event.code === 'Tab'
    ) {
      return false;
    }
    // Cmd+C/V are reserved for copy/paste — handled by the window-level
    // shortcut handler. Returning false prevents xterm from consuming the
    // event so our capturing listener wins and preventDefault() runs.
    if (
      event.type === 'keydown' &&
      event.metaKey &&
      !event.ctrlKey &&
      !event.shiftKey &&
      !event.altKey &&
      (event.key === 'C' || event.key === 'c' || event.key === 'V' || event.key === 'v')
    ) {
      return false;
    }
    if (!isWindowsCtrlVPasteHotkey(event)) {
      return true;
    }
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
  };

  terminalHost.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    focusSplitPanel(node.paneId, { focusTerminal: false });
    void showTerminalContextMenu(node, event);
  });

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
    if (!trimmedTitle) {
      return;
    }
    panes = panes.map((entry) =>
      entry.id === owningTabId ? { ...entry, terminalTitle: trimmedTitle } : entry
    );
    if (entryNeedsTabRefresh(owningTabId)) {
      renderTabs();
    }
  });

  terminal.onSelectionChange(() => {
    const selection = terminal.getSelection();
    if (selection) {
      bridge.writeClipboardText(selection);
    }
  });

  // OSC 7 — shell reports current working directory.
  // Format: file://hostname/path  OR  bare /path (some shells omit the prefix).
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
      panes = panes.map(p => p.id === owningTabId ? { ...p, cwd: path } : p);
    }
    // Update panel header title for this panel regardless of focus
    const titleNode = paneNodeMap.get(pane.id);
    if (titleNode?.titleEl) titleNode.titleEl.textContent = abbreviatePath(path) || '~';
    const focusedPane = panes[getFocusedIndex()];
    const activePanelId = focusedPane?.focusedPanelId ?? focusedPane?.id;
    if (activePanelId === pane.id) updateStatus();
    return true;
  });

  terminal.parser.registerOscHandler(52, (data) => {
    const semicolon = data.indexOf(';');
    if (semicolon === -1) {
      return true;
    }
    const base64Text = data.slice(semicolon + 1);
    if (!base64Text || base64Text === '?') {
      return true;
    }
    try {
      const bytes = atob(base64Text);
      const text = new TextDecoder().decode(
        Uint8Array.from(bytes, (c) => c.charCodeAt(0))
      );
      bridge.writeClipboardText(text);
    } catch {}
    return true;
  });

  terminal.parser.registerOscHandler(133, (data) => {
    if (data === 'C') {
      node.shellCmdMarker = terminal.registerMarker(0);
    } else if (data === 'D' || data.startsWith('D;')) {
      const exitCode = data.length > 2 ? parseInt(data.slice(2), 10) : 0;
      const marker = node.shellCmdMarker;
      if (marker) {
        terminal.registerDecoration({
          marker,
          overviewRulerOptions: {
            color: exitCode === 0 ? '#30D158' : '#FF453A',
            position: 'right',
          },
        });
        node.shellCmdMarker = null;
      }
    }
    return true;
  });

  return node;
}

function entryNeedsTabRefresh(paneId) {
  const pane = panes.find((entry) => entry.id === paneId);
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
    bridge.resizeTerminal({
      paneId: node.paneId,
      cols,
      rows,
    });
    // SIGWINCH on the PTY usually triggers a screen redraw — those bytes
    // would otherwise look like background activity and trip the alert.
    paneActivityWatcher.noteResize(node.paneId);
  }

  node.sizeKey = nextSizeKey;
  node.needsFit = false;
}

async function initializePaneTerminal(node) {
  if (!paneNodeMap.has(node.paneId)) return;
  fitTerminal(node, true);
  const pane = panes.find((p) => p.id === node.paneId);
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

function getTabLayout(pane) {
  return pane.layout ?? { type: 'leaf', panelId: pane.focusedPanelId ?? pane.id };
}

function ensurePaneNodes() {
  // Collect all active panel IDs across all tabs
  const activeIds = new Set();
  for (const pane of panes) {
    for (const panelId of collectPanelIds(getTabLayout(pane))) {
      activeIds.add(panelId);
    }
  }

  // Remove stale nodes
  for (const [panelId, node] of paneNodeMap.entries()) {
    if (!activeIds.has(panelId)) {
      destroyPanelNode(panelId, node);
    }
  }

  // Create new nodes
  for (const pane of panes) {
    const panelIds = collectPanelIds(getTabLayout(pane));
    for (const panelId of panelIds) {
      if (!paneNodeMap.has(panelId)) {
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
          const syntheticPane = {
            id: panelId,
            cwd: pd.cwd,
            accent: pd.accent ?? pane.accent,
            customColor: undefined,
            breathingMonitor: pd.breathingMonitor !== false,
          };
          node = createPane(syntheticPane, { tabId: pane.id });
        }
        paneNodeMap.set(panelId, node);
        stageEl.append(node.root);
        paneActivityWatcher.setPaneEnabled(
          panelId,
          isPrimary ? (pane.breathingMonitor !== false) : (panelDataMap.get(panelId)?.breathingMonitor !== false),
        );
        requestAnimationFrame(() => {
          initializePaneTerminal(node);
        });
      }
    }
  }
}

function createPaneData() {
  const usedAccents = new Set(panes.map((p) => p.accent.toLowerCase()));
  const accent = ColorsRegistry.ACCENT_PALETTE.find((c) => !usedAccents.has(c.toLowerCase()))
    || ColorsRegistry.ACCENT_PALETTE[(nextPaneNumber - 1) % ColorsRegistry.ACCENT_PALETTE.length];
  const focusedPane = panes[getFocusedIndex()];
  const id = `p${nextPaneNumber}`;
  const pane = {
    id,
    title: null,
    terminalTitle: bridge.defaultTabTitle,
    cwd: bridge.defaultCwd,
    accent,
    shellProfileId: null,
    layout: null,
    focusedPanelId: id,
  };

  nextPaneNumber += 1;
  return pane;
}

// Move `paneId` to the front of the MRU stack. Called when a pane is "really"
// visited (clicked, navigation Enter, new pane, etc.) — not while previewing
// in navigation mode and not while a cycle is in progress.
function recordPaneVisit(paneId) {
  if (!paneId) {
    return;
  }
  if (paneMruOrder[0] === paneId) {
    return;
  }
  paneMruOrder = [paneId, ...paneMruOrder.filter((id) => id !== paneId)];
}

// Drop dead pane IDs and append any new ones that snuck in. Keeps the MRU
// invariant (one entry per current pane) without reshuffling the order.
function syncPaneMruOrder() {
  const known = new Set(panes.map((pane) => pane.id));
  paneMruOrder = paneMruOrder.filter((id) => known.has(id));
  for (const pane of panes) {
    if (!paneMruOrder.includes(pane.id)) {
      paneMruOrder.push(pane.id);
    }
  }
}

function focusPane(paneId, options = {}) {
  const { focusTerminal = true } = options;
  paneCycleState = null;
  focusedPaneId = paneId;
  setMode('terminal');
  recordPaneVisit(paneId);
  render();
  const node = paneNodeMap.get(paneId);
  if (node && focusTerminal) {
    requestAnimationFrame(() => {
      node.terminal.focus();
    });
  }
}

function addPane() {
  const newPane = createPaneData();
  paneCycleState = null;
  panes = [...panes, newPane];
  focusedPaneId = newPane.id;
  recordPaneVisit(newPane.id);
  render(true);
  requestAnimationFrame(() => {
    paneNodeMap.get(newPane.id)?.terminal.focus();
  });
}

function closePane(index, options = {}) {
  const { destroyTerminal = true } = options;

  const closingPane = panes[index];
  if (!closingPane) {
    return;
  }

  if (panes.length === 1) {
    void bridge.exitApp().catch(reportError);
    return;
  }

  if (closingPane.id === renamingPaneId) {
    renamingPaneId = null;
  }

  if (closingPane.id === dragState?.paneId) {
    endTabDrag();
  }

  if (closingPane.id === pendingTabFocus?.paneId) {
    clearPendingTabFocus();
  }

  // Destroy all panel nodes for this tab (primary + any split panels).
  // Removing them from paneNodeMap here prevents ensurePaneNodes from
  // calling bridge.destroyTerminal a second time for the same panels.
  for (const panelId of collectPanelIds(getTabLayout(closingPane))) {
    const node = paneNodeMap.get(panelId);
    if (node) destroyPanelNode(panelId, node, { destroyTerminal });
  }

  const remainingPanes = panes.filter((_, paneIndex) => paneIndex !== index);
  if (closingPane.id === focusedPaneId) {
    const fallbackIndex = Math.max(0, index - 1);
    focusedPaneId = remainingPanes[fallbackIndex]?.id ?? remainingPanes[0]?.id ?? null;
  }
  panes = remainingPanes;
  paneCycleState = null;
  paneMruOrder = paneMruOrder.filter((id) => id !== closingPane.id);
  recordPaneVisit(focusedPaneId);

  render(true);
  requestAnimationFrame(() => {
    paneNodeMap.get(focusedPaneId)?.terminal.focus();
  });
}

// ── Split panel management ────────────────────────────────────────────────────

function focusSplitPanel(panelId, { focusTerminal = true } = {}) {
  const pane = panes.find((p) => {
    const layout = getTabLayout(p);
    return collectPanelIds(layout).includes(panelId);
  });
  if (!pane) return;

  // First focus the tab if it's not already focused
  if (pane.id !== focusedPaneId) {
    paneCycleState = null;
    focusedPaneId = pane.id;
    recordPaneVisit(pane.id);
  }

  // Then focus the specific panel within the tab
  panes = panes.map((p) =>
    p.id === pane.id ? { ...p, focusedPanelId: panelId } : p
  );

  setMode('terminal');
  render();

  if (focusTerminal) {
    requestAnimationFrame(() => {
      paneNodeMap.get(panelId)?.terminal.focus();
    });
  }
}

function splitPanel(direction) {
  const focusedPane = panes[getFocusedIndex()];
  if (!focusedPane) return;

  const newPanelId = genPanelId();
  const currentPanelId = focusedPane.focusedPanelId ?? focusedPane.id;
  const currentNode = paneNodeMap.get(currentPanelId);

  // Inherit data from current panel
  const currentData = panelDataMap.get(currentPanelId) ?? {
    cwd: focusedPane.cwd,
    shellProfileId: focusedPane.shellProfileId ?? null,
    accent: focusedPane.accent,
    breathingMonitor: focusedPane.breathingMonitor !== false,
  };

  panelDataMap.set(newPanelId, {
    cwd: currentNode?.cwd ?? currentData.cwd,
    shellProfileId: currentData.shellProfileId,
    accent: focusedPane.accent,
    breathingMonitor: focusedPane.breathingMonitor !== false,
  });

  // Insert split into the layout tree
  const currentLayout = getTabLayout(focusedPane);
  const newSplit = layoutSplit(
    direction,
    0.5,
    { type: 'leaf', panelId: currentPanelId },
    { type: 'leaf', panelId: newPanelId },
  );
  const newLayout = replaceLeaf(currentLayout, currentPanelId, newSplit);

  panes = panes.map((p) =>
    p.id === focusedPane.id
      ? { ...p, layout: newLayout, focusedPanelId: newPanelId }
      : p
  );

  render(true);
  requestAnimationFrame(() => {
    paneNodeMap.get(newPanelId)?.terminal.focus();
  });
}

function closeActivePanel() {
  const focusedPane = panes[getFocusedIndex()];
  if (!focusedPane) return;

  if (!focusedPane.layout) {
    // No split in this tab: close the whole tab
    closePane(getFocusedIndex());
    return;
  }

  const panelId = focusedPane.focusedPanelId ?? focusedPane.id;
  const newLayout = removeLeaf(focusedPane.layout, panelId);

  // Clean up the panel node
  const node = paneNodeMap.get(panelId);
  if (node) {
    destroyPanelNode(panelId, node);
  } else {
    // Node not yet created (rare) — still clean up the data maps
    panelDataMap.delete(panelId);
    activeCwdMap.delete(panelId);
  }

  // Determine new focused panel
  let newFocusId;
  let finalLayout;
  if (!newLayout) {
    // Was the only panel (shouldn't happen in a split, but be safe)
    closePane(getFocusedIndex());
    return;
  } else if (newLayout.type === 'leaf') {
    // Collapsed to single panel
    newFocusId = newLayout.panelId;
    finalLayout = null; // back to single-panel state
  } else {
    finalLayout = newLayout;
    const ids = collectPanelIds(newLayout);
    newFocusId = ids[0] ?? focusedPane.id;
  }

  panes = panes.map((p) =>
    p.id === focusedPane.id
      ? { ...p, layout: finalLayout, focusedPanelId: newFocusId }
      : p
  );

  render(true);
  requestAnimationFrame(() => {
    paneNodeMap.get(newFocusId)?.terminal.focus();
  });
}

function focusPanelDelta(delta) {
  const focusedPane = panes[getFocusedIndex()];
  if (!focusedPane || !focusedPane.layout) return;

  const ids = collectPanelIds(getTabLayout(focusedPane));
  if (ids.length < 2) return;

  const currentIdx = ids.indexOf(focusedPane.focusedPanelId ?? focusedPane.id);
  const nextIdx = (currentIdx + delta + ids.length) % ids.length;
  focusSplitPanel(ids[nextIdx]);
}

// ── Panel drag-to-rearrange ───────────────────────────────────────────────────

let panelDragState = null; // null | { sourcePanelId, startX, startY, ghost, dropOverlay, active }

function getPanelDropZone(panelEl, mouseX, mouseY) {
  const rect = panelEl.getBoundingClientRect();
  const rx = mouseX - rect.left;
  const ry = mouseY - rect.top;
  const w = rect.width;
  const h = rect.height;
  const edge = 0.25;
  if (rx < w * edge) return 'left';
  if (rx > w * (1 - edge)) return 'right';
  if (ry < h * edge) return 'top';
  if (ry > h * (1 - edge)) return 'bottom';
  return 'center';
}

function getHoveredPanelInfo(mouseX, mouseY, excludeId) {
  const focusedPane = panes[getFocusedIndex()];
  if (!focusedPane?.layout) return null;
  const panelIds = new Set(collectPanelIds(focusedPane.layout));
  for (const [panelId, node] of paneNodeMap.entries()) {
    if (panelId === excludeId) continue;
    if (!panelIds.has(panelId)) continue;
    const rect = node.root.getBoundingClientRect();
    if (mouseX >= rect.left && mouseX <= rect.right && mouseY >= rect.top && mouseY <= rect.bottom) {
      return { panelId, node, zone: getPanelDropZone(node.root, mouseX, mouseY) };
    }
  }
  return null;
}

function commitPanelDrop(sourcePanelId, targetPanelId, zone) {
  if (zone === 'center' || sourcePanelId === targetPanelId) return;
  const focusedPane = panes[getFocusedIndex()];
  if (!focusedPane?.layout) return;

  const direction = (zone === 'left' || zone === 'right') ? 'v' : 'h';
  const sourceFirst = (zone === 'left' || zone === 'top');

  // Remove source from current layout
  const layoutAfterRemove = removeLeaf(focusedPane.layout, sourcePanelId);
  if (!layoutAfterRemove) return;

  // Collapse to null if single leaf after remove
  const baseLayout = layoutAfterRemove.type === 'leaf' ? null : layoutAfterRemove;
  const effectiveBase = baseLayout ?? { type: 'leaf', panelId: layoutAfterRemove.panelId ?? targetPanelId };

  // Build new split at the target location
  const sourceLeaf = { type: 'leaf', panelId: sourcePanelId };
  const newSplit = layoutSplit(
    direction, 0.5,
    sourceFirst ? sourceLeaf : { type: 'leaf', panelId: targetPanelId },
    sourceFirst ? { type: 'leaf', panelId: targetPanelId } : sourceLeaf,
  );

  const newLayout = replaceLeaf(effectiveBase, targetPanelId, newSplit);

  panes = panes.map((p) =>
    p.id === focusedPane.id
      ? { ...p, layout: newLayout, focusedPanelId: sourcePanelId }
      : p
  );

  render(true);
  requestAnimationFrame(() => {
    paneNodeMap.get(sourcePanelId)?.terminal.focus();
  });
}

// Drag state machine wired into the stage
stageEl.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  const handle = e.target.closest('.panel-title');
  if (!handle) return;
  const sourcePanelId = handle.dataset.panelId;
  if (!sourcePanelId) return;

  e.preventDefault();
  e.stopPropagation();

  panelDragState = {
    sourcePanelId,
    startX: e.clientX,
    startY: e.clientY,
    ghost: null,
    dropOverlay: null,
    active: false,
    currentZone: null,
    currentTargetId: null,
  };
}, true);

const onPanelDragMouseMove = rafThrottle((e) => {
  if (!panelDragState) return;
  const { sourcePanelId, startX, startY } = panelDragState;

  if (!panelDragState.active) {
    const dist = Math.hypot(e.clientX - startX, e.clientY - startY);
    if (dist < 6) return;

    // Activate drag: create ghost
    panelDragState.active = true;
    const ghost = document.createElement('div');
    ghost.className = 'panel-drag-ghost';
    document.body.appendChild(ghost);
    panelDragState.ghost = ghost;

    // Create drop overlay
    const overlay = document.createElement('div');
    overlay.className = 'panel-drop-overlay';
    document.body.appendChild(overlay);
    panelDragState.dropOverlay = overlay;
  }

  // Position ghost
  if (panelDragState.ghost) {
    panelDragState.ghost.style.left = `${e.clientX + 12}px`;
    panelDragState.ghost.style.top = `${e.clientY + 12}px`;
  }

  // Detect hover target
  const hovered = getHoveredPanelInfo(e.clientX, e.clientY, sourcePanelId);
  if (hovered && hovered.zone !== 'center') {
    panelDragState.currentTargetId = hovered.panelId;
    panelDragState.currentZone = hovered.zone;
    // Position drop overlay on the hovered panel
    const rect = hovered.node.root.getBoundingClientRect();
    const ov = panelDragState.dropOverlay;
    ov.style.left = `${rect.left}px`;
    ov.style.top = `${rect.top}px`;
    ov.style.width = `${rect.width}px`;
    ov.style.height = `${rect.height}px`;
    ov.style.display = '';
    ov.dataset.zone = hovered.zone;
  } else {
    panelDragState.currentTargetId = null;
    panelDragState.currentZone = null;
    if (panelDragState.dropOverlay) panelDragState.dropOverlay.style.display = 'none';
  }
});
document.addEventListener('mousemove', onPanelDragMouseMove);

document.addEventListener('mouseup', (e) => {
  if (!panelDragState) return;
  onPanelDragMouseMove.cancel();
  const { sourcePanelId, active, currentTargetId, currentZone, ghost, dropOverlay } = panelDragState;
  ghost?.remove();
  dropOverlay?.remove();
  panelDragState = null;

  if (active && currentTargetId && currentZone) {
    commitPanelDrop(sourcePanelId, currentTargetId, currentZone);
  } else if (!active) {
    // Treated as a click: focus the panel
    focusSplitPanel(sourcePanelId);
  }
});

function beginRenamePane(index) {
  const pane = panes[index];
  if (!pane) {
    return;
  }

  clearPendingTabFocus();
  renamingPaneId = pane.id;
  try {
    render();
  } catch (error) {
    renamingPaneId = null;
    reportError(error);
  }
}

function cancelRenamePane() {
  renamingPaneId = null;
  try {
    render();
  } catch (error) {
    reportError(error);
  }
}

function commitRenamePane(paneId, nextTitle) {
  const trimmedTitle = nextTitle.trim();
  renamingPaneId = null;

  panes = panes.map((entry) =>
    entry.id === paneId ? { ...entry, title: trimmedTitle || null } : entry
  );

  // Return focus to the renamed pane's terminal
  focusPane(paneId, { focusTerminal: true });
}

function clearPendingTabFocus() {
  if (!pendingTabFocus) {
    return;
  }

  window.clearTimeout(pendingTabFocus.timerId);
  pendingTabFocus = null;
}

function scheduleTabFocus(paneId) {
  clearPendingTabFocus();
  pendingTabFocus = {
    paneId,
    timerId: window.setTimeout(() => {
      pendingTabFocus = null;
      focusPane(paneId);
    }, 180),
  };
}

function activateTabPointerUp(paneId) {
  if (pendingTabFocus?.paneId === paneId) {
    clearPendingTabFocus();
    const paneIndex = panes.findIndex((pane) => pane.id === paneId);
    if (paneIndex !== -1) {
      beginRenamePane(paneIndex);
    }
    return;
  }

  scheduleTabFocus(paneId);
}

function beginTabDrag(index, event) {
  if (event.button !== 0 || renamingPaneId !== null) {
    return;
  }

  const pane = panes[index];
  if (!pane) {
    return;
  }

  event.preventDefault();
  dragState = {
    paneId: pane.id,
    pointerId: event.pointerId,
    startX: event.clientX,
    currentX: event.clientX,
    dropIndex: index,
    hasMoved: false,
  };

  document.body.classList.add('is-dragging-tabs');
  window.addEventListener('pointermove', handleTabPointerMove);
  window.addEventListener('pointerup', handleTabPointerUp);
  window.addEventListener('pointercancel', handleTabPointerUp);
}

function handleTabPointerMove(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) {
    return;
  }

  dragState.currentX = event.clientX;
  const offsetX = dragState.currentX - dragState.startX;
  const hasMoved = Math.abs(offsetX) > 4;

  if (!hasMoved && !dragState.hasMoved) {
    return;
  }

  dragState.hasMoved = true;
  dragState.dropIndex = getTabDropIndex(event.clientX);
  renderTabs();
}

function handleTabPointerUp(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) {
    return;
  }

  const { paneId, dropIndex, hasMoved } = dragState;
  endTabDrag();

  if (!hasMoved) {
    activateTabPointerUp(paneId);
    return;
  }

  const pane = panes.find((entry) => entry.id === paneId);
  const nextPanes = panes.filter((entry) => entry.id !== paneId);
  const insertionIndex = Math.max(0, Math.min(dropIndex, nextPanes.length));
  nextPanes.splice(insertionIndex, 0, pane);
  panes = nextPanes;
  render();
}

function endTabDrag() {
  dragState = null;
  document.body.classList.remove('is-dragging-tabs');
  window.removeEventListener('pointermove', handleTabPointerMove);
  window.removeEventListener('pointerup', handleTabPointerUp);
  window.removeEventListener('pointercancel', handleTabPointerUp);
}

function getTabDropIndex(clientX) {
  const tabElements = [...tabsListEl.querySelectorAll('.tab')].filter(
    (tab) => tab.dataset.paneId !== dragState?.paneId
  );

  let slot = 0;
  for (const tab of tabElements) {
    const rect = tab.getBoundingClientRect();
    if (clientX < rect.left + rect.width / 2) {
      return slot;
    }
    slot += 1;
  }

  return slot;
}

// Returns a string that captures everything visible in the tab bar.
// Intentionally excludes pane.layout / focusedPanelId — tabs don't display
// split state, so those changes don't require a tab DOM rebuild.
function getTabsSig() {
  const d = dragState;
  return panes.map((p) =>
    `${p.id}:${p.title || ''}:${p.terminalTitle || ''}:${p.accent}:${p.customColor || ''}` +
    `:${pendingClosePaneId === p.id ? 'P' : ''}:${renamingPaneId === p.id ? 'R' : ''}`
  ).join('|') + `|${currentMode}|${d ? d.paneId + ':' + (d.dropIndex ?? -1) : ''}`;
}

function renderTabs() {
  if (isRenderingTabs) return;

  const focusedIndex = getFocusedIndex();
  const sig = getTabsSig();

  // Fast path: only focus changed — patch classes without rebuilding the DOM.
  if (!dragState && sig === _tabsLastSig) {
    if (focusedIndex !== _tabsLastFocused) {
      const tabs = tabsListEl.querySelectorAll('.tab');
      tabs.forEach((tab, i) => {
        tab.classList.toggle('is-focused', i === focusedIndex);
        tab.querySelector('.tab-main')?.setAttribute('aria-pressed', String(i === focusedIndex));
      });
      _tabsLastFocused = focusedIndex;
    }
    return;
  }

  isRenderingTabs = true;
  _tabsLastSig = sig;
  _tabsLastFocused = focusedIndex;
  const draggedPaneId = dragState?.paneId ?? null;
  let slot = 0;

  tabsListEl.replaceChildren(
    ...panes.map((pane, index) => {
      const isDragging = pane.id === draggedPaneId && dragState?.hasMoved;
      const insertBefore = !isDragging && dragState?.hasMoved && dragState.dropIndex === slot;
      const dragMeta = {
        isDragging,
        insertBefore,
        offsetX: isDragging ? dragState.currentX - dragState.startX : 0,
      };
      if (!isDragging) {
        slot += 1;
      }
      return createTab(pane, index, focusedIndex, dragMeta);
    })
  );
  isRenderingTabs = false;
}

function applyPanelStyle(node, accentColor, x, y, w, h, zIndex, isFocused, hasSplits) {
  node.root.classList.toggle('is-focused', isFocused);
  node.root.classList.toggle('is-navigation-target', isFocused && currentMode === 'nav');
  node.root.classList.toggle('has-splits', hasSplits);
  node.root.style.setProperty('--pane-accent', accentColor);
  if (hasSplits) {
    // Split panels are repositioned without animation; use left/top directly.
    node.root.style.left = `${x}px`;
    node.root.style.top = `${y}px`;
    node.root.style.transform = '';
  } else {
    // Tab-slide panels: translateX keeps layout stable so the browser only
    // needs a composite pass (no layout recalculation) on each animation frame.
    // Promote to compositor layer just before the transform changes; the
    // transitionend listener in createPane removes it when the slide finishes.
    node.root.style.willChange = 'transform';
    node.root.style.left = '0';
    node.root.style.top = '0';
    node.root.style.transform = `translateX(${x}px)`;
  }
  node.root.style.width = `${w}px`;
  node.root.style.height = `${h}px`;
  node.root.style.zIndex = String(zIndex);
  node.root.style.display = '';
  if (node.accent !== accentColor) {
    node.terminal.options.theme = createTerminalTheme(accentColor);
    node.accent = accentColor;
  }
}

function renderSplitDividers(focusedPane, tabX, tabW, stageHeight) {
  const layout = focusedPane?.layout;

  // Hide all existing dividers first
  for (const el of splitDividerElMap.values()) {
    el.style.display = 'none';
  }

  if (!layout) return;

  const dividers = collectDividers(layout, tabX, 0, tabW, stageHeight);
  const activeNodes = new Set();

  for (const div of dividers) {
    activeNodes.add(div.node);
    let el = splitDividerElMap.get(div.node);
    if (!el) {
      el = document.createElement('div');
      el.className = 'pane-split-divider';
      stageEl.appendChild(el);
      splitDividerElMap.set(div.node, el);
    }
    el.style.left = `${div.x}px`;
    el.style.top = `${div.y}px`;
    el.style.width = `${div.w}px`;
    el.style.height = `${div.h}px`;
    el.style.display = '';
    el.dataset.direction = div.direction;
    // Keep drag data current so mousedown can read it without re-traversing the tree
    splitDividerDataMap.set(el, { splitNode: div.node, direction: div.direction, usableSize: div.usableSize });
  }

  // Remove stale divider elements for split nodes no longer in the tree
  for (const [splitNode, el] of splitDividerElMap.entries()) {
    if (!activeNodes.has(splitNode)) {
      el.remove();
      splitDividerElMap.delete(splitNode);
    }
  }
}

function renderPanes(refit = false) {
  const stageWidth = stageEl.clientWidth;
  const stageHeight = stageEl.clientHeight;
  const previewWidth = getPreviewWidth(stageWidth, panes.length);
  const focusedIndex = getFocusedIndex();
  const focusedPane = panes[focusedIndex];

  ensurePaneNodes();

  // Track active panel for breathing monitor
  const activePanelId = focusedPane?.focusedPanelId ?? focusedPane?.id ?? focusedPaneId;
  paneActivityWatcher.setFocus(activePanelId);

  const visiblePanelIds = new Set();

  // Compute focused tab's pixel rect
  const focusedTabX = panes.length === 1 ? 0 : getPaneLeft(focusedIndex, previewWidth, focusedIndex);
  const focusedTabW = panes.length === 1 ? stageWidth : settings.paneWidth;

  panes.forEach((pane, index) => {
    const isFocusedTab = index === focusedIndex;
    const accentColor = pane.customColor || pane.accent;

    if (isFocusedTab && pane.layout) {
      // ── Focused tab with splits ──────────────────────────────────────
      computeLayout(pane.layout, focusedTabX, 0, focusedTabW, stageHeight, (leafNode, x, y, w, h) => {
        const node = paneNodeMap.get(leafNode.panelId);
        if (!node) return;
        const isPanelFocused = leafNode.panelId === pane.focusedPanelId;
        node.root.style.clipPath = '';
        applyPanelStyle(node, accentColor, x, y, w, h, panes.length + 10, isPanelFocused, true);
        if (refit || node.needsFit) fitTerminal(node, true);
        visiblePanelIds.add(leafNode.panelId);
      });
    } else {
      // ── Single panel (no split) or non-focused tab ────────────────────
      const displayPanelId = pane.focusedPanelId ?? pane.id;
      const node = paneNodeMap.get(displayPanelId);
      if (node) {
        const left = getPaneLeft(index, previewWidth, focusedIndex);
        const w = panes.length === 1 ? stageWidth : settings.paneWidth;
        // Clip non-focused panes to their visible preview strip so their
        // border/shadow cannot bleed into the focused tab's split panels.
        // When previewWidth >= paneWidth the element doesn't overflow, so no
        // clip is needed (empty string removes any previously set value).
        const clipInset = (!isFocusedTab && panes.length > 1 && previewWidth < settings.paneWidth)
          ? `inset(0 ${settings.paneWidth - previewWidth}px 0 0)`
          : '';
        node.root.style.clipPath = clipInset;
        applyPanelStyle(node, accentColor, left, 0, w, stageHeight, index + 1, isFocusedTab, false);
        if (refit || node.needsFit) fitTerminal(node, true);
        visiblePanelIds.add(displayPanelId);
      }
    }
  });

  // Hide any panel nodes not in the visible set
  for (const [panelId, node] of paneNodeMap.entries()) {
    if (!visiblePanelIds.has(panelId)) {
      node.root.style.display = 'none';
    }
  }

  // Tab-level dividers between adjacent tabs — hidden when focused tab has a split layout
  const dividerCount = panes.length - 1;
  dividerEls.forEach((el, i) => {
    if (i >= dividerCount) {
      el.style.display = 'none';
      return;
    }
    const divX = getPaneLeft(i + 1, previewWidth, focusedIndex);
    el.dataset.dividerIndex = String(i + 1);
    el.style.display = 'block';
    el.style.left = `${divX}px`;
  });

  // Split panel dividers for the focused tab
  renderSplitDividers(focusedPane, focusedTabX, focusedTabW, stageHeight);

  // Update panel header titles — only panels in the focused tab's split layout
  if (focusedPane?.layout) {
    for (const panelId of collectPanelIds(focusedPane.layout)) {
      const node = paneNodeMap.get(panelId);
      if (!node?.titleEl) continue;
      const cwd = activeCwdMap.get(panelId)
        ?? panelDataMap.get(panelId)?.cwd
        ?? '';
      node.titleEl.textContent = abbreviatePath(cwd) || '~';
    }
  }
}

function render(refit = false) {
  renderTabs();
  renderPanes(refit);
  updateStatus();
  if (sessionRestoreComplete) {
    scheduleSettingsSave();
  }
}

function moveFocus(delta) {
  if (panes.length === 0) {
    return;
  }

  const focusedIndex = getFocusedIndex();
  const nextIndex = (focusedIndex + delta + panes.length) % panes.length;
  focusedPaneId = panes[nextIndex].id;
  render();
}

function navigateLeft() {
  if (panes.length === 0) {
    return;
  }

  const focusedIndex = getFocusedIndex();
  const nextIndex = focusedIndex - 1;

  if (nextIndex >= 0) {
    focusPane(panes[nextIndex].id);
  }
}

function navigateRight() {
  if (panes.length === 0) {
    return;
  }

  const focusedIndex = getFocusedIndex();
  const nextIndex = focusedIndex + 1;

  if (nextIndex < panes.length) {
    focusPane(panes[nextIndex].id);
  }
}

// Cycle to the previously-visited pane (similar to browser Ctrl+Tab).
// First press steps from current to MRU[1]; subsequent presses while the
// modifier is held step further back through the snapshot. Reverse cycles
// (Shift+Ctrl+`) walk the snapshot the other way. The cycle commits when
// the modifier is released (see commitPaneCycle).
function cycleToRecentPane({ reverse = false } = {}) {
  if (panes.length < 2) {
    return;
  }

  syncPaneMruOrder();

  if (!paneCycleState) {
    paneCycleState = { snapshot: [...paneMruOrder], index: 0 };
  }

  const { snapshot } = paneCycleState;
  if (snapshot.length < 2) {
    return;
  }

  const step = reverse ? -1 : 1;
  paneCycleState.index = (paneCycleState.index + step + snapshot.length) % snapshot.length;
  const targetId = snapshot[paneCycleState.index];

  if (!panes.some((pane) => pane.id === targetId)) {
    // Target pane was closed mid-cycle — recover by aborting.
    paneCycleState = null;
    return;
  }

  focusedPaneId = targetId;
  setMode('terminal');
  render();

  const node = paneNodeMap.get(targetId);
  if (node) {
    requestAnimationFrame(() => {
      node.terminal.focus();
    });
  }
}

// Promote the cycle's final pane to the front of the MRU stack.
// Called when the cycling modifier is released.
function commitPaneCycle() {
  if (!paneCycleState) {
    return;
  }
  paneCycleState = null;
  recordPaneVisit(focusedPaneId);
}

function isEditableTarget() {
  return (
    document.activeElement?.tagName === 'INPUT' ||
    document.activeElement?.classList?.contains('xterm-helper-textarea')
  );
}

function getPaneIndex(paneId) {
  return panes.findIndex((pane) => pane.id === paneId);
}

// For split panels, panelId != tab pane.id — find the owning tab.
function getOwningTabId(panelId) {
  const direct = panes.find((p) => p.id === panelId);
  if (direct) return panelId;
  const owner = panes.find((p) => collectPanelIds(getTabLayout(p)).includes(panelId));
  return owner?.id ?? null;
}

function getPaneNode(paneId) {
  return paneNodeMap.get(paneId) ?? null;
}

async function getClipboardSnapshot() {
  try {
    return await bridge.getClipboardSnapshot?.() ?? { text: '', hasImage: false };
  } catch {
    return { text: '', hasImage: false };
  }
}

function isWindowsCtrlVPasteHotkey(event) {
  return (
    bridge.platform === 'win32' &&
    event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === 'v'
  );
}

function copyTerminalSelection(paneId = focusedPaneId) {
  const node = getPaneNode(paneId);
  if (!node) {
    return false;
  }

  const selection = node.terminal.getSelection();
  if (!selection) {
    return false;
  }

  bridge.writeClipboardText(selection);
  return true;
}

async function pasteIntoTerminal(paneId = focusedPaneId, options = {}) {
  const node = getPaneNode(paneId);
  if (!node?.sessionReady) {
    return false;
  }

  const text = options.clipboardSnapshot?.text ?? (await bridge.readClipboardText());
  if (!text) {
    return false;
  }

  if (bridge.platform === 'win32') {
    node.terminal.paste(text);
  } else {
    bridge.writeTerminal({ paneId: node.paneId, data: text });
  }
  return true;
}

function selectAllInTerminal(paneId = focusedPaneId) {
  const node = getPaneNode(paneId);
  if (!node) {
    return false;
  }

  node.terminal.selectAll();
  return true;
}

// showContextMenu and hideContextMenu are imported from ./context-menu.js

async function showTerminalContextMenu(node, event) {
  const clipboardSnapshot = await getClipboardSnapshot();

  const tabId = getOwningTabId(node.paneId);
  const tabPane = tabId ? panes[getPaneIndex(tabId)] : null;
  const breathingOn = tabPane && tabPane.breathingMonitor !== false;
  const hasSplit = !!(tabPane?.layout);
  const isOnlyTab = panes.length <= 1;

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
    items.push(
      { type: 'separator' },
      { label: t('menu.changeProfile'), children: shellChildren },
    );
  }

  showContextMenu(items, event.clientX, event.clientY,
    (action) => handleMenuAction(action, node.paneId),
  );
}

function showTabContextMenu(paneId, event) {
  const paneIndex = getPaneIndex(paneId);
  if (paneIndex === -1) {
    return;
  }

  paneCycleState = null;
  focusedPaneId = paneId;
  recordPaneVisit(paneId);
  render();

  const pane = panes[paneIndex];
  const breathingOn = pane && pane.breathingMonitor !== false;
  const isOnlyTab = panes.length <= 1;
  const canMoveLeft  = paneIndex > 0;
  const canMoveRight = paneIndex < panes.length - 1;

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
  showContextMenu(items, event.clientX, event.clientY,
    (action) => handleMenuAction(action, paneId),
  );
}

function showColorPicker(paneId) {
  hideContextMenu();

  const paneIndex = getPaneIndex(paneId);
  if (paneIndex === -1) return;

  const pane = panes[paneIndex];
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

  picker.addEventListener('click', (e) => {
    if (e.target === picker) {
      picker.remove();
    }
  });

  picker.querySelector('.color-picker-close').addEventListener('click', () => picker.remove());

  picker.querySelectorAll('.color-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      const color = btn.dataset.color;
      setPaneColor(paneId, color);
      picker.remove();
    });
  });

  const colorInput = picker.querySelector('.color-picker-input');
  colorInput.addEventListener('input', () => {
    setPaneColor(paneId, colorInput.value);
  });

  picker.querySelector('.color-picker-clear').addEventListener('click', () => {
    clearPaneColor(paneId);
    picker.remove();
  });

  document.body.appendChild(picker);
  colorInput.focus();
}

function setPaneColor(paneId, color) {
  const paneIndex = getPaneIndex(paneId);
  if (paneIndex === -1) return;

  panes[paneIndex] = { ...panes[paneIndex], customColor: color };
  scheduleSettingsSave();
  render();
}

function clearPaneColor(paneId) {
  const paneIndex = getPaneIndex(paneId);
  if (paneIndex === -1) return;

  panes[paneIndex] = { ...panes[paneIndex], customColor: undefined };
  scheduleSettingsSave();
  render();
}

function togglePaneBreathingMonitor(paneId) {
  const paneIndex = getPaneIndex(paneId);
  if (paneIndex === -1) return;

  const next = panes[paneIndex].breathingMonitor === false;
  panes[paneIndex] = { ...panes[paneIndex], breathingMonitor: next };
  paneActivityWatcher.setPaneEnabled(paneId, next);
  scheduleSettingsSave();
}

// VIB-16: open the command palette over the current panes. Build a
// feature-agnostic item list and let the palette module do the rest.
function openTabSwitcher() {
  hideContextMenu();
  if (renamingPaneId !== null) {
    cancelRenamePane();
  }
  if (!settingsPanelEl.classList.contains('is-hidden')) {
    settingsPanelEl.classList.add('is-hidden');
  }

  const items = panes.map((pane) => ({
    id: pane.id,
    label: getPaneLabel(pane) || pane.id,
    accent: pane.customColor || pane.accent,
  }));

  openCommandPalette(items, focusPane, {
    placeholder: 'Switch tab by title…',
    emptyText: 'No matching tabs',
  });
}

async function pasteImageIntoTerminal(paneId = focusedPaneId, options = {}) {
  const node = getPaneNode(paneId);
  if (!node?.sessionReady) {
    return false;
  }

  const clipboardSnapshot = options.clipboardSnapshot ?? (await getClipboardSnapshot());
  if (!clipboardSnapshot.hasImage) {
    return false;
  }

  bridge.writeTerminal({ paneId: node.paneId, data: '\u0016' });
  return true;
}

function handleMenuAction(action, paneId) {
  if (action === 'terminal-copy') {
    copyTerminalSelection(paneId);
    return;
  }

  if (action === 'terminal-paste') {
    void pasteIntoTerminal(paneId);
    return;
  }

  if (action === 'terminal-paste-image') {
    pasteImageIntoTerminal(paneId);
    return;
  }

  if (action === 'terminal-select-all') {
    selectAllInTerminal(paneId);
    return;
  }

  if (action === 'terminal-change-color') {
    showColorPicker(paneId);
    return;
  }

  if (action === 'terminal-find') {
    toggleSearch();
    return;
  }

  if (action === 'terminal-restart') {
    restartPane(paneId);
    return;
  }

  if (action === 'terminal-close-tab') {
    const tabId = getOwningTabId(paneId);
    if (tabId) {
      const idx = getPaneIndex(tabId);
      if (idx !== -1) closePane(idx);
    }
    return;
  }

  if (action === 'move-tab-left') {
    const idx = getPaneIndex(paneId);
    if (idx > 0) {
      [panes[idx - 1], panes[idx]] = [panes[idx], panes[idx - 1]];
      render();
      scheduleSettingsSave();
    }
    return;
  }

  if (action === 'move-tab-right') {
    const idx = getPaneIndex(paneId);
    if (idx !== -1 && idx < panes.length - 1) {
      [panes[idx], panes[idx + 1]] = [panes[idx + 1], panes[idx]];
      render();
      scheduleSettingsSave();
    }
    return;
  }

  if (action === 'tab-rename') {
    const paneIndex = getPaneIndex(paneId);
    if (paneIndex !== -1) {
      beginRenamePane(paneIndex);
    }
    return;
  }

  if (action === 'tab-close') {
    const paneIndex = getPaneIndex(paneId);
    if (paneIndex !== -1) {
      closePane(paneIndex);
    }
    return;
  }

  if (action === 'tab-change-color') {
    showColorPicker(paneId);
    return;
  }

  if (action.startsWith('tab-set-color:')) {
    const color = action.slice('tab-set-color:'.length);
    setPaneColor(paneId, color);
    return;
  }

  if (action === 'tab-clear-color') {
    clearPaneColor(paneId);
    return;
  }

  if (action === 'pane-toggle-breathing') {
    togglePaneBreathingMonitor(paneId);
    return;
  }

  if (action.startsWith('terminal-change-shell:')) {
    const profileId = action.slice('terminal-change-shell:'.length);
    changePaneShell(paneId, profileId);
    return;
  }

  if (action === 'new-pane') {
    addPane();
    return;
  }

  if (action === 'close-pane') {
    closeActivePanel();
    return;
  }

  if (action === 'split-right') {
    splitPanel('v');
    return;
  }

  if (action === 'split-down') {
    splitPanel('h');
    return;
  }

  if (action.startsWith('split-ratio:')) {
    const ratio = parseFloat(action.slice('split-ratio:'.length));
    if (!Number.isNaN(ratio) && _pendingRatioNode) {
      _pendingRatioNode.ratio = Math.max(MIN_RATIO, Math.min(MAX_RATIO, ratio));
      _pendingRatioNode = null;
      renderPanes(true);
      scheduleSettingsSave();
    }
    return;
  }

  if (action === 'broadcast-toggle') {
    setBroadcastEnabled(!broadcastEnabled);
    return;
  }

  if (action === 'font-size-increase') {
    settings.fontSize = Math.min(24, settings.fontSize + 1);
    applySettings();
    render(true);
    scheduleSettingsSave();
    return;
  }

  if (action === 'font-size-decrease') {
    settings.fontSize = Math.max(10, settings.fontSize - 1);
    applySettings();
    render(true);
    scheduleSettingsSave();
    return;
  }

  if (action === 'font-size-reset') {
    settings.fontSize = 13;
    applySettings();
    render(true);
    scheduleSettingsSave();
    return;
  }

  if (action === 'close-window') {
    void bridge.closeWindow().catch(reportError);
    return;
  }

  if (action === 'rename-tab') {
    const paneIndex = getFocusedIndex();
    if (paneIndex !== -1) {
      if (currentMode === 'nav') setMode('terminal');
      beginRenamePane(paneIndex);
    }
    return;
  }

  if (action === 'clear-scrollback') {
    const node = paneNodeMap.get(focusedPaneId);
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
    showStatusBarToggleEl.checked = settings.showStatusBar;
    document.body.classList.toggle('hide-status-bar', !settings.showStatusBar);
    scheduleSettingsSave();
    return;
  }

  if (action === 'toggle-navigation-mode') {
    if (currentMode === 'nav') {
      setMode('terminal');
      if (focusedPaneId) focusPane(focusedPaneId, { focusTerminal: true });
    } else {
      enterNavigationMode();
    }
    return;
  }

  if (action === 'next-tab') {
    const idx = getFocusedIndex();
    if (idx !== -1 && panes.length > 1) {
      focusPane(panes[(idx + 1) % panes.length].id, { focusTerminal: true });
    }
    return;
  }

  if (action === 'prev-tab') {
    const idx = getFocusedIndex();
    if (idx !== -1 && panes.length > 1) {
      focusPane(panes[(idx - 1 + panes.length) % panes.length].id, { focusTerminal: true });
    }
    return;
  }

  if (action === 'move-tab-left') {
    const idx = getFocusedIndex();
    if (idx > 0) {
      [panes[idx - 1], panes[idx]] = [panes[idx], panes[idx - 1]];
      render();
      scheduleSettingsSave();
    }
    return;
  }

  if (action === 'move-tab-right') {
    const idx = getFocusedIndex();
    if (idx !== -1 && idx < panes.length - 1) {
      [panes[idx], panes[idx + 1]] = [panes[idx + 1], panes[idx]];
      render();
      scheduleSettingsSave();
    }
    return;
  }

  if (action === 'pane-color') {
    if (focusedPaneId) showColorPicker(focusedPaneId);
    return;
  }

  if (action === 'keyboard-shortcuts') {
    openKeymapHelpModal();
    return;
  }
}

function blurFocusedTerminal() {
  const node = paneNodeMap.get(focusedPaneId);
  if (node) {
    node.terminal.blur();
  }
}

function enterNavigationMode() {
  if (panes.length === 0) {
    return;
  }

  // Save the source pane ID so we can return to it on cancel
  enterNavSourcePaneId = focusedPaneId;
  setMode('nav');
  blurFocusedTerminal();
  render();
}

function cancelNavigationMode() {
  // Return focus to the pane that was focused when entering nav mode
  if (enterNavSourcePaneId) {
    focusPane(enterNavSourcePaneId, { focusTerminal: true });
    enterNavSourcePaneId = null;
  } else {
    setMode('terminal');
    render();
  }
}

function updateStatus() {
  const focusedPane = panes[getFocusedIndex()];
  const focusedPaneLabel = getPaneLabel(focusedPane) || focusedPane?.id || '';

  const keymap = ShortcutsRegistry.getActiveKeymap();
  const { modeLabel: hintModeLabel, hintsHtml } = renderHintBar(
    keymap,
    currentMode,
    focusedPaneLabel,
    bridge.platform,
    settings.statusBarHints
  );

  let modeLabel;
  if (currentMode !== 'terminal') {
    modeLabel = hintModeLabel;
  } else {
    const formatted = formatStatusBar(settings.statusBarFormat);
    modeLabel = formatted.trim() ? formatted : focusedPaneLabel;
  }

  statusLabelEl.textContent = modeLabel;
  statusLabelEl.classList.toggle('is-navigation-mode', currentMode === 'nav');
  statusHintEl.innerHTML = hintsHtml;

  const titleText = formatWindowTitle(settings.windowTitleFormat).trim();
  bridge.setWindowTitle(titleText || 'Vibe99');
}

// ---------------------------------------------------------------------------
// VIB-33: Navigation mode enhancement functions
// ---------------------------------------------------------------------------

function focusPaneAt(index) {
  if (panes.length === 0 || index < 0 || index >= panes.length) return;
  paneCycleState = null;
  focusedPaneId = panes[index].id;
  // Stay in nav mode, just update which pane is focused
  render();
}

function getPaneCount() {
  return panes.length;
}

function getPaneIdAt(index) {
  if (panes.length === 0 || index < 0 || index >= panes.length) return null;
  return panes[index].id;
}

// Two-step close confirmation state
let pendingClosePaneId = null;

function requestClosePane(paneId) {
  if (pendingClosePaneId === paneId) {
    // Second press - confirmed
    const index = panes.findIndex((pane) => pane.id === paneId);
    if (index !== -1) {
      pendingClosePaneId = null;
      closePane(index);

      // Exit nav mode and return focus to the now-focused pane after close
      if (currentMode === 'nav' && panes.length > 0) {
        focusPane(focusedPaneId, { focusTerminal: true });
      }
    }
  } else {
    // First press - show pending state
    pendingClosePaneId = paneId;
    render();
  }
}

function startInlineRename(paneId) {
  const index = panes.findIndex((pane) => pane.id === paneId);
  if (index !== -1) {
    // Exit nav mode before starting rename
    if (currentMode === 'nav') {
      setMode('terminal');
    }
    beginRenamePane(index);
  }
}

function openKeymapHelpModal() {
  ShortcutsUI.openKeyboardShortcutsModal(bridge, scheduleSettingsSave);
}

// ---------------------------------------------------------------------------
// Wire renderer-level callbacks into pure action handlers
// ---------------------------------------------------------------------------

// Wire renderer-level callbacks into pure action handlers, then route every
// global keydown through the declarative keymap dispatcher. The keydown switch
// that used to live here is now `KEYMAP` in `input/keymap.js` plus a few flag
// columns (`mode`, `skipInInput`, `stopPropagation`) interpreted by the
// dispatcher.
const keyboardActions = createActions({
  addPane,
  enterNavigationMode,
  cycleToRecentPane,
  navigateLeft,
  navigateRight,
  copyTerminalSelection,
  pasteIntoTerminal,
  moveFocus,
  focusPane,
  cancelNavigationMode,
  getFocusedPaneId: () => focusedPaneId,
  isCommandPaletteOpen,
  closeCommandPalette,
  openTabSwitcher,
  focusPaneAt,
  getPaneCount,
  getPaneIdAt,
  requestClosePane,
  startInlineRename,
  openKeymapHelpModal,
  splitPanel,
  closeActivePanel,
  focusPanelDelta,
  fontSizeIncrease: () => {
    settings.fontSize = Math.min(24, settings.fontSize + 1);
    applySettings();
    render(true);
    scheduleSettingsSave();
  },
  fontSizeDecrease: () => {
    settings.fontSize = Math.max(10, settings.fontSize - 1);
    applySettings();
    render(true);
    scheduleSettingsSave();
  },
  fontSizeReset: () => {
    settings.fontSize = 13;
    applySettings();
    render(true);
    scheduleSettingsSave();
  },
  toggleSearch,
});

const dispatchKeydown = createDispatcher({
  getKeymap: ShortcutsRegistry.getActiveKeymap,
  actions: keyboardActions,
  getMode: () => currentMode,
  isInputFocused: () => document.activeElement?.tagName === 'INPUT',
  isCommandPaletteOpen,
});

window.addEventListener('keydown', dispatchKeydown, true);

// Commit the pane cycle when the cycling modifier is released. Without this,
// a user who presses Ctrl+` and then switches to a different pane via mouse
// would not see their MRU updated to reflect the new active pane.
window.addEventListener('keyup', (event) => {
  if (paneCycleState && (event.key === 'Control' || event.key === 'Meta')) {
    commitPaneCycle();
  }
});

// If the window loses focus mid-cycle (alt-tab away), the keyup event for
// the cycling modifier may never fire. Commit the cycle defensively so the
// MRU stays consistent with what the user sees.
window.addEventListener('blur', () => {
  if (paneCycleState) {
    commitPaneCycle();
  }
});

addPaneButtonEl.addEventListener('click', () => {
  try {
    addPane();
  } catch (error) {
    reportError(error);
  }
});


// Shell profiles modal button (clickable row)
shellProfilesSettingsBtn.addEventListener('click', () => {
  settingsPanelEl.classList.add('is-hidden');
  openShellProfilesModal(() => openSettingsToTab('general'));
});

shellProfilesSettingsBtn.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    settingsPanelEl.classList.add('is-hidden');
    openShellProfilesModal(() => openSettingsToTab('general'));
  }
});

// ----------------------------------------------------------------
// Keyboard shortcuts modal
// ----------------------------------------------------------------

// Keyboard shortcuts modal button (clickable row)
keyboardShortcutsSettingsBtn.addEventListener('click', () => {
  settingsPanelEl.classList.add('is-hidden');
  ShortcutsUI.openKeyboardShortcutsModal(bridge, scheduleSettingsSave, () => openSettingsToTab('general'));
});

keyboardShortcutsSettingsBtn.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    settingsPanelEl.classList.add('is-hidden');
    ShortcutsUI.openKeyboardShortcutsModal(bridge, scheduleSettingsSave, () => openSettingsToTab('general'));
  }
});

async function runInstallShellIntegration() {
  try {
    const result = await bridge.installShellIntegration();
    await bridge.writeClipboardText(result.sourceLine);
    settingsPanelEl.classList.add('is-hidden');
    statusLabelEl.textContent = t('msg.shellIntegrationInstalled');
    setTimeout(() => { statusLabelEl.textContent = ''; }, 8000);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    statusLabelEl.textContent = `${t('msg.shellIntegrationFailed')}${message}`;
    setTimeout(() => { statusLabelEl.textContent = ''; }, 6000);
  }
}

shellIntegrationInstallBtn.addEventListener('click', runInstallShellIntegration);
shellIntegrationInstallBtn.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    runInstallShellIntegration();
  }
});

settingsPanelEl.addEventListener('click', (event) => {
  event.stopPropagation();
  const tabBtn = event.target.closest('.settings-tab-btn');
  if (!tabBtn) return;
  const tabId = tabBtn.dataset.tab;
  settingsPanelEl.querySelectorAll('.settings-tab-btn').forEach(b => {
    b.classList.toggle('is-active', b === tabBtn);
    b.setAttribute('aria-selected', b === tabBtn ? 'true' : 'false');
  });
  settingsPanelEl.querySelectorAll('.settings-tab-panel').forEach(p => {
    p.classList.toggle('is-hidden', p.id !== `settings-tab-${tabId}`);
  });
});

fontSizeRangeEl.addEventListener('input', () => {
  settings.fontSize = Number(fontSizeRangeEl.value);
  applySettings();
  render(true);
  scheduleSettingsSave();
});

scrollbackInputEl.addEventListener('input', () => {
  settings.scrollback = Number(scrollbackInputEl.value);
  applySettings();
  for (const [, node] of paneNodeMap) {
    node.terminal.options.scrollback = settings.scrollback;
  }
  scheduleSettingsSave();
});

fontFamilySelectEl.addEventListener('change', () => {
  if (fontFamilySelectEl.value === '__custom__') {
    fontFamilySelectEl.classList.add('is-hidden');
    fontFamilyInputEl.value = settings.fontFamily;
    fontFamilyInputEl.classList.remove('is-hidden');
    fontFamilyInputEl.focus();
    fontFamilyInputEl.select();
  } else {
    fontFamilyInputEl.classList.add('is-hidden');
    settings.fontFamily = fontFamilySelectEl.value;
    applySettings();
    render(true);
    scheduleSettingsSave();
  }
});

fontFamilyInputEl.addEventListener('change', () => {
  const val = fontFamilyInputEl.value.trim() || getDefaultFontFamily(bridge.platform);
  settings.fontFamily = val;
  if (FONT_PRESET_VALUES.has(settings.fontFamily)) {
    fontFamilySelectEl.value = settings.fontFamily;
    fontFamilyInputEl.classList.add('is-hidden');
    fontFamilySelectEl.classList.remove('is-hidden');
  } else {
    fontFamilySelectEl.value = '__custom__';
    // keep the text input visible — no swap back for non-preset values
  }
  applySettings();
  render(true);
  scheduleSettingsSave();
});

fontFamilyInputEl.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.stopPropagation();
    fontFamilyInputEl.classList.add('is-hidden');
    fontFamilySelectEl.classList.remove('is-hidden');
    if (FONT_PRESET_VALUES.has(settings.fontFamily)) {
      fontFamilySelectEl.value = settings.fontFamily;
    } else {
      fontFamilySelectEl.value = '__custom__';
    }
  }
});

function updatePaneWidth(nextValue) {
  const parsedValue = Number(nextValue);
  if (!Number.isFinite(parsedValue)) {
    applySettings();
    return;
  }

  settings.paneWidth = Math.max(520, Math.min(2000, Math.round(parsedValue / 10) * 10));
  applySettings();
  render(true);
  scheduleSettingsSave();
}

function updatePaneOpacity(nextValue) {
  const parsedValue = Number(nextValue);
  if (!Number.isFinite(parsedValue)) {
    applySettings();
    return;
  }

  settings.paneOpacity = Math.max(0.55, Math.min(1, Number(parsedValue.toFixed(2))));
  applySettings();
  scheduleSettingsSave();
}

function updatePaneMaskOpacity(nextValue) {
  const parsedValue = Number(nextValue);
  if (!Number.isFinite(parsedValue)) {
    applySettings();
    return;
  }

  settings.paneMaskOpacity = Math.max(0, Math.min(1, Number(parsedValue.toFixed(2))));
  applySettings();
  scheduleSettingsSave();
}

paneWidthRangeEl.addEventListener('input', () => {
  updatePaneWidth(paneWidthRangeEl.value);
});

paneOpacityRangeEl.addEventListener('input', () => {
  updatePaneOpacity(paneOpacityRangeEl.value);
});

paneMaskOpacityRangeEl.addEventListener('input', () => {
  updatePaneMaskOpacity(paneMaskOpacityRangeEl.value);
});

breathingAlertToggleEl.addEventListener('change', () => {
  settings.breathingAlertEnabled = breathingAlertToggleEl.checked;
  paneActivityWatcher.setGlobalEnabled(settings.breathingAlertEnabled);
  scheduleSettingsSave();
});

showStatusBarToggleEl.addEventListener('change', () => {
  settings.showStatusBar = showStatusBarToggleEl.checked;
  document.body.classList.toggle('hide-status-bar', !settings.showStatusBar);
  scheduleSettingsSave();
});

colorModeSegmentedEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.settings-segment');
  if (!btn) return;
  settings.colorMode = btn.dataset.value;
  applyColorModeUI(settings.colorMode);
  applyColorMode(settings.colorMode);
  scheduleSettingsSave();
});

languageSelectEl.addEventListener('change', () => {
  settings.language = languageSelectEl.value;
  setLocale(settings.language);
  applyTranslations();
  updateStatus();
  scheduleSettingsSave();
});

windowTitleFormatInputEl?.addEventListener('input', () => {
  settings.windowTitleFormat = windowTitleFormatInputEl.value;
  updateStatus();
  scheduleSettingsSave();
});

statusBarFormatInputEl?.addEventListener('input', () => {
  settings.statusBarFormat = statusBarFormatInputEl.value;
  updateStatus();
  scheduleSettingsSave();
});

statusBarHintsInputEl?.addEventListener('input', () => {
  settings.statusBarHints = statusBarHintsInputEl.value;
  updateStatus();
  scheduleSettingsSave();
});

window.addEventListener('pointerdown', (event) => {
  if (
    !settingsPanelEl.classList.contains('is-hidden') &&
    !settingsPanelEl.contains(event.target)
  ) {
    settingsPanelEl.classList.add('is-hidden');
  }
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !settingsPanelEl.classList.contains('is-hidden')) {
    settingsPanelEl.classList.add('is-hidden');
  }
  if (event.key === ',' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    settingsPanelEl.classList.toggle('is-hidden');
  }
  // Cmd+= or Cmd++ → increase font size; Cmd+- → decrease; Cmd+0 → reset
  if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey) {
    if (event.key === '=' || event.key === '+') {
      event.preventDefault();
      settings.fontSize = Math.min(24, settings.fontSize + 1);
      applySettings();
      render(true);
      scheduleSettingsSave();
    } else if (event.key === '-') {
      event.preventDefault();
      settings.fontSize = Math.max(10, settings.fontSize - 1);
      applySettings();
      render(true);
      scheduleSettingsSave();
    } else if (event.key === '0') {
      event.preventDefault();
      settings.fontSize = 13;
      applySettings();
      render(true);
      scheduleSettingsSave();
    }
  }
});

function openSettingsToTab(tabId) {
  settingsPanelEl.classList.remove('is-hidden');
  settingsPanelEl.querySelectorAll('.settings-tab-btn').forEach(b => {
    const match = b.dataset.tab === tabId;
    b.classList.toggle('is-active', match);
    b.setAttribute('aria-selected', match ? 'true' : 'false');
  });
  settingsPanelEl.querySelectorAll('.settings-tab-panel').forEach(p => {
    p.classList.toggle('is-hidden', p.id !== `settings-tab-${tabId}`);
  });
}

bridge.onOpenSettings(() => {
  settingsPanelEl.classList.remove('is-hidden');
});

// macOS fullscreen: shift content down when auto-hide menu bar appears.
// Use Tauri's isFullscreen() API — window.innerHeight >= screen.height fails
// on notched MacBooks where screen.height includes the notch area.
{
  const html = document.documentElement;
  let menuBarTimer = null;
  let fsCheckTimer = null;
  const tauriWin = window.__TAURI__?.window?.getCurrentWindow?.();

  async function updateFullscreenClass() {
    let isFs = false;
    if (tauriWin) {
      try { isFs = await tauriWin.isFullscreen(); } catch {}
    }
    if (!isFs) {
      html.classList.remove('is-fullscreen', 'menu-bar-showing');
      clearTimeout(menuBarTimer);
    } else {
      const wasFs = html.classList.contains('is-fullscreen');
      html.classList.add('is-fullscreen');
      if (!wasFs) {
        // macOS resets the native WKWebView background on fullscreen entry.
        // Apply immediately and again after the animation settles (~600ms).
        bridge.setWindowTheme(settings.colorMode).catch(() => {});
        setTimeout(() => bridge.setWindowTheme(settings.colorMode).catch(() => {}), 600);
      }
    }
  }

  // Debounce: macOS fullscreen animation takes ~300ms; check after it completes.
  function scheduleFullscreenCheck() {
    clearTimeout(fsCheckTimer);
    fsCheckTimer = setTimeout(() => updateFullscreenClass(), 350);
  }

  // Both resize sources: Tauri's onResized and the web-level resize event.
  // onResized alone can fire before isFullscreen() reflects the new state.
  if (tauriWin) {
    tauriWin.onResized(() => scheduleFullscreenCheck());
  }
  window.addEventListener('resize', () => scheduleFullscreenCheck());
  updateFullscreenClass();

  document.addEventListener('mousemove', (e) => {
    if (!html.classList.contains('is-fullscreen')) return;
    if (e.clientY <= 40) {
      if (!html.classList.contains('menu-bar-showing')) {
        html.classList.add('menu-bar-showing');
      }
      clearTimeout(menuBarTimer);
      menuBarTimer = setTimeout(() => {
        html.classList.remove('menu-bar-showing');
      }, 4000);
    } else if (e.clientY > 60 && html.classList.contains('menu-bar-showing')) {
      clearTimeout(menuBarTimer);
      html.classList.remove('menu-bar-showing');
    }
  });
}

let _resizeTimer = null;
window.addEventListener('resize', () => {
  // Reposition panes immediately so they track the window edge during drag.
  // fitTerminal (the expensive part) is debounced until the resize ends.
  try {
    renderPanes(false);
  } catch (error) {
    reportError(error);
  }
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => {
    try {
      render(true);
    } catch (error) {
      reportError(error);
    }
  }, 120);
});

window.addEventListener('DOMContentLoaded', async () => {
  try {
    await bridge.cwdReady;

    const savedSettings = await bridge.loadSettings();
    applyPersistedSettings(savedSettings);
    applySettings();

    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      if (settings.colorMode === 'auto') {
        applyColorMode('auto');
      }
    });
    applyTranslations();
    loadShellProfiles();

    if (savedSettings?.session?.panes?.length > 0) {
      restoreSession(savedSettings.session);
    } else {
      panes = panes.map((p) =>
        p.title === null
          ? { ...p, cwd: bridge.defaultCwd, terminalTitle: bridge.defaultTabTitle }
          : p
      );
    }

    render(true);
    sessionRestoreComplete = true;
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

window.addEventListener('error', (event) => {
  reportError(event.error || event.message);
});

window.addEventListener('unhandledrejection', (event) => {
  reportError(event.reason);
});
