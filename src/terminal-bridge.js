// Utilities and Tauri bridge factory extracted from renderer.js.
// This module has no external state dependencies.

export function getRuntimePlatform() {
  const platform = navigator.platform.toLowerCase();
  if (platform.includes('win')) return 'win32';
  if (platform.includes('mac')) return 'darwin';
  return 'linux';
}

export function getDefaultFontFamily(platform = getRuntimePlatform()) {
  if (platform === 'win32' || platform === 'windows') return 'Consolas, monospace';
  if (platform === 'darwin') return 'Menlo, monospace';
  return "'DejaVu Sans Mono', monospace";
}

export function basename(path) {
  return path.replace(/\/+$/, '').split('/').pop() || '/';
}

export function splitArgs(str) {
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
  if (cur) args.push(cur);
  return args;
}

export function formatArgs(args) {
  return args.map((arg) => {
    if (arg === '' || /[\s"]/.test(arg) || /\\/.test(arg)) {
      const escaped = arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      return `"${escaped}"`;
    }
    return arg;
  }).join(' ');
}

export function createUnavailableBridge() {
  const fail = () => { throw new Error('Tauri bridge is unavailable'); };
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

export function createTauriBridge(tauri) {
  const { invoke } = tauri.core;
  const { getCurrentWindow } = tauri.window;
  const { readText: clipboardReadText, writeText: clipboardWriteText } = tauri.clipboardManager;
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
      invoke('terminal_write', { paneId: payload.paneId, data: base64Encode(payload.data) }),
    resizeTerminal: (payload) =>
      invoke('terminal_resize', { paneId: payload.paneId, cols: payload.cols, rows: payload.rows }),
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
