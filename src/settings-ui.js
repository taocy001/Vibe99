// Settings state, UI rendering, and persistence extracted from renderer.js.
// The `settings` object is exported as a shared mutable reference — all modules
// that import it always see the latest values.

import { getDefaultFontFamily, splitArgs, formatArgs } from './terminal-bridge.js';
import { t, setLocale, SUPPORTED_LOCALES } from './i18n.js';
import * as ShortcutsRegistry from './shortcuts-registry.js';
import * as ShortcutsUI from './shortcuts-ui.js';
import {
  serializeLayout,
  collectPanelIds,
} from './split-layout.js';

// Exported shared settings object.  Initialised with safe defaults; the
// real fontFamily is patched in by createSettingsUI once the bridge is known.
export const settings = {
  fontSize: 13,
  fontFamily: 'monospace',
  paneOpacity: 0.8,
  paneMaskOpacity: 0.75,
  paneWidth: 720,
  scrollback: 5000,
  breathingAlertEnabled: true,
  notificationsEnabled: false,
  notificationSilenceMs: 30000,
  showStatusBar: false,
  colorMode: 'dark',
  language: 'en',
  windowTitleFormat: '\\w',
  statusBarFormat: '\\w\\p',
  statusBarHints: 'cycleRecent,enterNav,newPane,closePane,toggleSearch,splitRight',
};

// ---------------------------------------------------------------------------
// Theme helpers (used by both settings-ui and the terminal renderer)
// ---------------------------------------------------------------------------

export function resolveEffectiveColorMode() {
  if (settings.colorMode !== 'auto') return settings.colorMode;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function createTerminalTheme(accent) {
  if (resolveEffectiveColorMode() === 'light') {
    return {
      background: '#f4f0ea',
      foreground: '#383a42',
      cursor: accent,
      cursorAccent: '#ffffff',
      selectionBackground: `${accent}55`,
      black: '#383a42', red: '#ca1243', green: '#3d8c40', yellow: '#c18401',
      blue: '#3b65cc', magenta: '#8b1fa8', cyan: '#0c7ba1', white: '#696c77',
      brightBlack: '#4f525e', brightRed: '#e06c75', brightGreen: '#50a14f',
      brightYellow: '#986801', brightBlue: '#4078f2', brightMagenta: '#a626a4',
      brightCyan: '#0184bc', brightWhite: '#383a42',
    };
  }
  return {
    background: '#11111100',
    foreground: '#d9d4c7',
    cursor: accent,
    cursorAccent: '#111111',
    selectionBackground: `${accent}44`,
    black: '#111111', red: '#ff6b57', green: '#98c379', yellow: '#e5c07b',
    blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#d9d4c7',
    brightBlack: '#5a6374', brightRed: '#ff8578', brightGreen: '#b0d98b',
    brightYellow: '#f0d58a', brightBlue: '#7eb7ff', brightMagenta: '#d9a5e8',
    brightCyan: '#7fd8e6', brightWhite: '#ffffff',
  };
}

export function fixXtermViewportBg(terminalHost, _mode) {
  const vp = terminalHost.querySelector('.xterm-viewport');
  if (vp) vp.style.backgroundColor = resolveEffectiveColorMode() === 'light' ? '#f4f0ea' : '';
}

// ---------------------------------------------------------------------------
// Factory — call once after the bridge and DOM are available
// ---------------------------------------------------------------------------

/**
 * createSettingsUI({ bridge, st, paneNodeMap, panelDataMap,
 *                    paneActivityWatcher, onRender, onUpdateStatus,
 *                    initializePaneTerminal, reportError })
 *
 * Sets up all settings-related DOM event listeners and returns the public API
 * used by the rest of the application.
 */
export function createSettingsUI({
  bridge,
  st,             // shared mutable state
  paneNodeMap,
  panelDataMap,
  paneActivityWatcher,
  onRender,
  onUpdateStatus,
  initializePaneTerminal,
  reportError,
}) {
  // Fix fontFamily now that we have the bridge
  settings.fontFamily = getDefaultFontFamily(bridge.platform);

  // ── DOM element references ─────────────────────────────────────────────────
  const settingsPanelEl       = document.getElementById('settings-panel');
  const fontSizeRangeEl       = document.getElementById('font-size-input');
  const fontSizeDisplayEl     = document.getElementById('font-size-display');
  const scrollbackInputEl     = document.getElementById('scrollback-input');
  const scrollbackDisplayEl   = document.getElementById('scrollback-display');
  const fontFamilySelectEl    = document.getElementById('font-family-select');
  const fontFamilyInputEl     = document.getElementById('font-family-input');

  // Master font list: system = always available on macOS; others detected at runtime
  const FONT_PRESETS_DEF = [
    { value: 'Menlo, monospace',             label: 'Menlo',           system: true  },
    { value: 'Monaco, monospace',            label: 'Monaco',          system: true  },
    { value: "'SF Mono', monospace",         label: 'SF Mono',         system: true  },
    { value: "'JetBrains Mono', monospace",  label: 'JetBrains Mono',  system: false },
    { value: "'Fira Code', monospace",       label: 'Fira Code',       system: false },
    { value: "'Cascadia Code', monospace",   label: 'Cascadia Code',   system: false },
    { value: 'Consolas, monospace',          label: 'Consolas',        system: false },
    { value: "'Hack', monospace",            label: 'Hack',            system: false },
    { value: "'Source Code Pro', monospace", label: 'Source Code Pro', system: false },
    { value: "'Inconsolata', monospace",     label: 'Inconsolata',     system: false },
    { value: "'MesloLGS NF', monospace",     label: 'MesloLGS NF',    system: false },
    { value: "'DejaVu Sans Mono', monospace",label: 'DejaVu Sans Mono',system: false },
    // Courier New: system: true because the monospace CSS generic often resolves to Courier/
    // Courier New, making canvas measureText return an identical width and falsely flag it
    // as "not installed". It is available on all macOS and Windows systems.
    { value: "'Courier New', monospace",     label: 'Courier New',     system: true  },
  ];
  const FONT_PRESET_VALUES = new Set(FONT_PRESETS_DEF.map((f) => f.value));

  function _buildFontSelectGroups(available, popular) {
    const makeOpt = (v, l, disabled = false) => {
      const o = document.createElement('option');
      o.value = v; o.textContent = l; o.disabled = disabled;
      return o;
    };
    fontFamilySelectEl.replaceChildren();
    available.forEach((f) => fontFamilySelectEl.appendChild(makeOpt(f.value, f.label)));
    if (available.length && popular.length) {
      fontFamilySelectEl.appendChild(makeOpt('', '──────────────', true));
    }
    popular.forEach((f) => fontFamilySelectEl.appendChild(makeOpt(f.value, f.label)));
    fontFamilySelectEl.appendChild(makeOpt('__custom__', 'Custom…'));
  }

  // Sync initial build: system fonts are available, rest goes to Popular
  _buildFontSelectGroups(
    FONT_PRESETS_DEF.filter((f) => f.system),
    FONT_PRESETS_DEF.filter((f) => !f.system),
  );

  // After fonts load, regroup by canvas-based availability detection and restore selection.
  // document.fonts.check() is unreliable in WKWebView for non-CSS-loaded fonts; canvas
  // measurement detects any font installed on the system.
  document.fonts.ready.then(() => {
    const _fc = document.createElement('canvas').getContext('2d');
    const _testStr = 'mmmmwwwwllll||||iiii';
    _fc.font = '16px monospace';
    const _refW = _fc.measureText(_testStr).width;
    const isInstalled = (label) => {
      _fc.font = `16px "${label}", monospace`;
      return _fc.measureText(_testStr).width !== _refW;
    };
    const available = FONT_PRESETS_DEF.filter((f) => f.system || isInstalled(f.label));
    const popular   = FONT_PRESETS_DEF.filter((f) => !f.system && !isInstalled(f.label));
    _buildFontSelectGroups(available, popular);
    fontFamilySelectEl.value = FONT_PRESET_VALUES.has(settings.fontFamily)
      ? settings.fontFamily
      : '__custom__';
  });
  const paneWidthRangeEl      = document.getElementById('pane-width-range');
  const paneWidthValueEl      = document.getElementById('pane-width-value');
  const paneOpacityRangeEl    = document.getElementById('pane-opacity-range');
  const paneOpacityValueEl    = document.getElementById('pane-opacity-value');
  const paneMaskOpacityRangeEl = document.getElementById('pane-mask-alpha-range');
  const paneMaskOpacityValueEl = document.getElementById('pane-mask-alpha-value');
  const breathingAlertToggleEl  = document.getElementById('breathing-alert-toggle');
  const notificationsToggleEl   = document.getElementById('notifications-toggle');
  const notificationSilenceEl   = document.getElementById('notifications-silence');
  const showStatusBarToggleEl  = document.getElementById('show-status-bar-toggle');
  const windowTitleFormatInputEl = document.getElementById('window-title-format');
  const statusBarFormatInputEl   = document.getElementById('status-bar-format');
  const statusBarHintsInputEl    = document.getElementById('status-bar-hints');
  const colorModeSegmentedEl     = document.getElementById('color-mode-segmented');
  const shellProfilesSettingsBtn = document.getElementById('shell-profiles-settings-btn');
  const keyboardShortcutsSettingsBtn = document.getElementById('keyboard-shortcuts-settings-btn');
  const shellIntegrationInstallBtn   = document.getElementById('shell-integration-install-btn');
  const languageSelectEl = document.getElementById('language-select');
  const settingsSubpageEl      = document.getElementById('settings-subpage');
  const settingsSubpageTitleEl = document.getElementById('settings-subpage-title');
  const settingsSubpageContentEl = document.getElementById('settings-subpage-content');
  const settingsSubpageBackEl  = document.getElementById('settings-subpage-back');
  const settingsSubpageActionEl = document.getElementById('settings-subpage-action');

  // Populate language selector
  SUPPORTED_LOCALES.forEach(({ code, label }) => {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = label;
    languageSelectEl.appendChild(opt);
  });

  // ── Shell profile state ────────────────────────────────────────────────────
  let shellProfiles = [];
  let defaultShellProfileId = '';
  let editingShellProfile = null;
  let selectedShellProfileId = null;
  let detectedShellProfiles = [];
  let pendingSettingsSave = null;
  // Sub-page shell profile container refs (set when sub-page is open)
  let _spShellListEl = null;
  let _spShellEditorEl = null;

  // ── Helpers ────────────────────────────────────────────────────────────────

  function applyColorModeUI(mode) {
    colorModeSegmentedEl?.querySelectorAll('.settings-segment').forEach(btn => {
      btn.classList.toggle('is-active', btn.dataset.value === mode);
    });
  }

  function applyColorMode(mode) {
    // Resolve 'auto' to the actual effective class so all theme-light/theme-dark
    // CSS rules apply correctly — theme-auto only has partial CSS coverage.
    const effectiveClass = mode === 'auto' ? resolveEffectiveColorMode() : mode;
    document.documentElement.classList.remove('theme-dark', 'theme-light', 'theme-auto');
    document.documentElement.classList.add(`theme-${effectiveClass}`);
    bridge.setWindowTheme(mode).catch(() => {});
    for (const [, node] of paneNodeMap) {
      const accent = node.accent || '#888888';
      node.terminal.options.theme = createTerminalTheme(accent);
      fixXtermViewportBg(node.terminalHost, mode);
    }
    requestAnimationFrame(() => {
      for (const [, node] of paneNodeMap) {
        fixXtermViewportBg(node.terminalHost, mode);
      }
    });
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
    if (notificationsToggleEl) notificationsToggleEl.checked = settings.notificationsEnabled;
    if (notificationSilenceEl) notificationSilenceEl.value = String(Math.round(settings.notificationSilenceMs / 1000));
    showStatusBarToggleEl.checked = settings.showStatusBar;
    document.body.classList.toggle('hide-status-bar', !settings.showStatusBar);
    applyColorModeUI(settings.colorMode);
    applyColorMode(settings.colorMode);
    languageSelectEl.value = settings.language;
    if (windowTitleFormatInputEl) windowTitleFormatInputEl.value = settings.windowTitleFormat;
    if (statusBarFormatInputEl)   statusBarFormatInputEl.value   = settings.statusBarFormat;
    if (statusBarHintsInputEl)    statusBarHintsInputEl.value    = settings.statusBarHints;
  }

  function applyTranslations() {
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = t(el.dataset.i18n);
    });
  }

  function applyPersistedSettings(nextSettings) {
    if (!nextSettings || typeof nextSettings !== 'object') return;

    const uiSettings =
      nextSettings && typeof nextSettings.ui === 'object' && nextSettings.ui !== null
        ? nextSettings.ui
        : nextSettings;

    if (Number.isFinite(uiSettings.fontSize))    settings.fontSize    = uiSettings.fontSize;
    if (Number.isFinite(uiSettings.scrollback))  settings.scrollback  = Math.max(1000, Math.min(50000, uiSettings.scrollback));
    if (typeof uiSettings.fontFamily === 'string') {
      settings.fontFamily = uiSettings.fontFamily;
      // Migrate old multi-fallback default values to the current single-family format
      const FONT_MIGRATIONS = {
        'Menlo, Monaco, "SF Mono", monospace': 'Menlo, monospace',
        'Consolas, "Cascadia Mono", "Courier New", monospace': 'Consolas, monospace',
        '"DejaVu Sans Mono", "Liberation Mono", "Ubuntu Mono", monospace': "'DejaVu Sans Mono', monospace",
      };
      if (settings.fontFamily in FONT_MIGRATIONS) {
        settings.fontFamily = FONT_MIGRATIONS[settings.fontFamily];
      }
    }
    if (Number.isFinite(uiSettings.paneOpacity))  settings.paneOpacity = Math.max(0.55, Math.min(1, uiSettings.paneOpacity));
    if (Number.isFinite(uiSettings.paneMaskOpacity)) settings.paneMaskOpacity = Math.max(0, Math.min(1, uiSettings.paneMaskOpacity));
    // Migrate legacy paneMaskAlpha → paneMaskOpacity
    if (Number.isFinite(uiSettings.paneMaskAlpha) && !Number.isFinite(uiSettings.paneMaskOpacity)) {
      settings.paneMaskOpacity = Math.max(0, Math.min(1, uiSettings.paneMaskAlpha));
    }
    // Migrate v3 inverted mask opacity
    if (nextSettings?.version != null && nextSettings.version < 4) {
      settings.paneMaskOpacity = 1 - settings.paneMaskOpacity;
    }
    if (Number.isFinite(uiSettings.paneWidth)) settings.paneWidth = uiSettings.paneWidth;
    if (typeof uiSettings.breathingAlertEnabled  === 'boolean') settings.breathingAlertEnabled  = uiSettings.breathingAlertEnabled;
    if (typeof uiSettings.notificationsEnabled   === 'boolean') settings.notificationsEnabled   = uiSettings.notificationsEnabled;
    if (Number.isFinite(uiSettings.notificationSilenceMs) && uiSettings.notificationSilenceMs >= 5000) settings.notificationSilenceMs = uiSettings.notificationSilenceMs;
    if (typeof uiSettings.showStatusBar === 'boolean')         settings.showStatusBar         = uiSettings.showStatusBar;
    if (typeof uiSettings.colorMode === 'string') settings.colorMode = uiSettings.colorMode;
    if (typeof uiSettings.language === 'string') {
      settings.language = uiSettings.language;
      setLocale(uiSettings.language);
    }
    if (typeof uiSettings.windowTitleFormat === 'string') settings.windowTitleFormat = uiSettings.windowTitleFormat;
    if (typeof uiSettings.statusBarFormat   === 'string') settings.statusBarFormat   = uiSettings.statusBarFormat;
    if (typeof uiSettings.statusBarHints    === 'string') settings.statusBarHints    = uiSettings.statusBarHints;

    if (typeof uiSettings.shortcuts === 'object' && uiSettings.shortcuts !== null) {
      ShortcutsRegistry.loadShortcutsFromSettings(uiSettings);
    } else {
      ShortcutsRegistry.loadShortcutsFromSettings({});
    }
  }

  function buildSessionData() {
    const panes = st.panes;
    const focusedIndex = panes.findIndex((p) => p.id === st.focusedPaneId);
    const safeFocusedIndex = focusedIndex >= 0 ? focusedIndex : 0;
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
      focusedPaneIndex: safeFocusedIndex,
    };
  }

  function scheduleSettingsSave() {
    if (pendingSettingsSave !== null) window.clearTimeout(pendingSettingsSave);
    pendingSettingsSave = window.setTimeout(() => {
      pendingSettingsSave = null;
      const settingsToSave = {
        version: 5,
        ui: { ...settings, shortcuts: ShortcutsRegistry.getShortcutsForSave() },
        session: buildSessionData(),
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
        ui: { ...settings, shortcuts: ShortcutsRegistry.getShortcutsForSave() },
        session: buildSessionData(),
      };
      void bridge.saveSettings(settingsToSave).catch(reportError);
    }
  }

  // ── Shell profile management ───────────────────────────────────────────────

  function loadShellProfiles() {
    Promise.all([
      bridge.listShellProfiles(),
      bridge.detectShellProfiles().catch(() => []),
    ]).then(([config, detected]) => {
      detectedShellProfiles = detected;
      const userProfiles = config.profiles ?? [];
      const userIds = new Set(userProfiles.map((p) => p.id));
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
    btn.addEventListener('click', (event) => { event.stopPropagation(); onClick(); });
    return btn;
  }

  function restartPane(paneId) {
    const node = paneNodeMap.get(paneId);
    if (!node) return;
    node._shellChanging = true;
    node._shellChangeTime = Date.now();
    node.sessionReady = false;
    node.terminal.clear();
    initializePaneTerminal(node).finally(() => { node._shellChanging = false; });
  }

  function changePaneShell(paneId, profileId) {
    const node = paneNodeMap.get(paneId);
    if (!node) return;
    const previousProfileId = st.panes.find((p) => p.id === paneId)?.shellProfileId ?? null;
    st.panes = st.panes.map((p) => p.id === paneId ? { ...p, shellProfileId: profileId } : p);
    scheduleSettingsSave();
    node._shellChanging = true;
    node._shellChangeTime = Date.now();
    node.sessionReady = false;
    node.terminal.clear();
    initializePaneTerminal(node).finally(() => {
      node._shellChanging = false;
      if (!node.sessionReady) {
        st.panes = st.panes.map((p) => p.id === paneId ? { ...p, shellProfileId: previousProfileId } : p);
        scheduleSettingsSave();
      }
    });
  }

  function renderModalShellProfiles() {
    const listEl  = _spShellListEl;
    const editorEl = _spShellEditorEl;
    if (!listEl || !editorEl) return;

    listEl.replaceChildren();
    editorEl.replaceChildren();

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

        actions.appendChild(createProfileActionButton('⧉', 'Clone profile', () => cloneProfile(profile)));

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

        let isDragging = false;
        let dragStartTime = 0;

        item.addEventListener('click', (e) => {
          if (e.target.closest('.shell-profile-actions')) return;
          if (isDragging) return;
          selectedShellProfileId = profile.id;
          editingShellProfile = { id: profile.id, name: profile.name || '', command: profile.command, args: formatArgs(profile.args ?? []), isNew: false };
          renderModalShellProfiles();
        });

        if (!isDetected) {
          item.addEventListener('dragstart', (e) => {
            dragStartTime = Date.now();
            isDragging = true;
            item.classList.add('is-dragging');
            e.dataTransfer.setData('text/plain', profile.id);
            e.dataTransfer.effectAllowed = 'move';
            if (e.dataTransfer.setDragImage) e.dataTransfer.setDragImage(item, 0, 0);
          });
          item.addEventListener('dragend', () => {
            const dragDuration = Date.now() - dragStartTime;
            if (dragDuration < 200) isDragging = false;
            setTimeout(() => { isDragging = false; }, 100);
            item.classList.remove('is-dragging');
            document.querySelectorAll('.shell-profile-item').forEach(el => el.classList.remove('drag-over'));
          });
          item.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'move';
            const dragging = document.querySelector('.shell-profile-item.is-dragging');
            if (dragging && dragging !== item) item.classList.add('drag-over');
          });
          item.addEventListener('dragleave', (e) => {
            if (!item.contains(e.relatedTarget)) item.classList.remove('drag-over');
          });
          item.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            item.classList.remove('drag-over');
            const draggedId = e.dataTransfer.getData('text/plain');
            if (draggedId !== profile.id) reorderProfiles(draggedId, profile.id);
          });
        }

        listEl.appendChild(item);
      }
    }

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
      selectedShellProfileId = clonedProfile.id;
      editingShellProfile = { id: clonedProfile.id, name: clonedProfile.name, command: clonedProfile.command, args: formatArgs(clonedProfile.args ?? []), isNew: true };
      renderModalShellProfiles();
    }).catch(reportError);
  }

  function reorderProfiles(draggedId, targetId) {
    const draggedIndex = shellProfiles.findIndex(p => p.id === draggedId);
    const targetIndex  = shellProfiles.findIndex(p => p.id === targetId);
    if (draggedIndex === -1 || targetIndex === -1) return;
    const [draggedProfile] = shellProfiles.splice(draggedIndex, 1);
    shellProfiles.splice(targetIndex, 0, draggedProfile);
    const userProfiles = shellProfiles.filter(p => !detectedShellProfiles.some(dp => dp.id === p.id));
    Promise.all(userProfiles.map(p => bridge.addShellProfile(p)))
      .then(() => renderModalShellProfiles())
      .catch(reportError);
  }

  function createModalShellProfileEditor() {
    const editor = document.createElement('div');
    editor.className = 'shell-profile-editor';
    const fields = [
      { key: 'name',    label: 'Name (optional)', placeholder: 'e.g. Zsh' },
      { key: 'id',      label: 'ID',              placeholder: 'e.g. zsh' },
      { key: 'command', label: 'Command',          placeholder: '/bin/zsh' },
      { key: 'args',    label: 'Arguments',        placeholder: '-il' },
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
    const actionsEl = document.createElement('div');
    actionsEl.className = 'shell-profile-editor-actions';
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
        selectedShellProfileId = profile.id;
        editingShellProfile = { id: profile.id, name: profile.name, command: profile.command, args: formatArgs(profile.args), isNew: false };
        renderModalShellProfiles();
      }).catch(reportError);
    });
    actionsEl.append(cancel, save);
    editor.appendChild(actionsEl);
    queueMicrotask(() => {
      const firstInput = editor.querySelector('input');
      if (firstInput) { firstInput.focus(); firstInput.select(); }
    });
    return editor;
  }

  // ── Settings panel navigation ──────────────────────────────────────────────

  function openSettingsToTab(tabId) {
    settingsPanelEl.classList.remove('is-hidden');
    let activeBtn = null;
    settingsPanelEl.querySelectorAll('.settings-tab-btn').forEach(b => {
      const match = b.dataset.tab === tabId;
      b.classList.toggle('is-active', match);
      b.setAttribute('aria-selected', match ? 'true' : 'false');
      if (match) activeBtn = b;
    });
    settingsPanelEl.querySelectorAll('.settings-tab-panel').forEach(p => {
      p.classList.toggle('is-hidden', p.id !== `settings-tab-${tabId}`);
    });
    activeBtn?.focus();
  }

  function openSubPage(title, buildFn, actionLabel, onAction) {
    settingsSubpageTitleEl.textContent = title;
    settingsSubpageContentEl.replaceChildren();
    if (actionLabel) {
      settingsSubpageActionEl.textContent = actionLabel;
      settingsSubpageActionEl.classList.remove('is-hidden');
      settingsSubpageActionEl.onclick = onAction ?? null;
    } else {
      settingsSubpageActionEl.classList.add('is-hidden');
      settingsSubpageActionEl.onclick = null;
    }
    buildFn(settingsSubpageContentEl);
    settingsSubpageEl.classList.remove('is-hidden');
    settingsPanelEl.classList.add('has-subpage');
  }

  function closeSubPage() {
    settingsSubpageEl.classList.add('is-hidden');
    settingsPanelEl.classList.remove('has-subpage');
    settingsSubpageContentEl.replaceChildren();
    _spShellListEl = null;
    _spShellEditorEl = null;
    settingsSubpageBackEl.focus();
  }

  function openShellProfilesSubPage() {
    loadShellProfiles();
    openSubPage('Shell Profiles', (contentEl) => {
      contentEl.innerHTML = `
        <div class="shell-profiles-modal-body">
          <div class="shell-profiles-sidebar">
            <div class="shell-profile-list" id="sp-shell-profile-list"></div>
          </div>
          <div class="shell-profiles-editor-panel" id="sp-shell-profile-editor">
            <div class="shell-profiles-editor-placeholder">Select a profile or create a new one</div>
          </div>
        </div>
      `;
      _spShellListEl = contentEl.querySelector('#sp-shell-profile-list');
      _spShellEditorEl = contentEl.querySelector('#sp-shell-profile-editor');
      if (shellProfiles.length > 0) {
        const first = shellProfiles[0];
        selectedShellProfileId = first.id;
        editingShellProfile = { id: first.id, name: first.name || '', command: first.command, args: formatArgs(first.args ?? []), isNew: false };
      } else {
        selectedShellProfileId = null;
        editingShellProfile = null;
      }
      renderModalShellProfiles();
    }, '+', () => {
      editingShellProfile = { id: '', name: '', command: '', args: '', isNew: true };
      selectedShellProfileId = null;
      renderModalShellProfiles();
    });
  }

  // ── Settings UI event listeners ────────────────────────────────────────────

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
    onRender(true);
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
      onRender(true);
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
    }
    applySettings();
    onRender(true);
    scheduleSettingsSave();
  });

  fontFamilyInputEl.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      fontFamilyInputEl.classList.add('is-hidden');
      fontFamilySelectEl.classList.remove('is-hidden');
      fontFamilySelectEl.value = FONT_PRESET_VALUES.has(settings.fontFamily) ? settings.fontFamily : '__custom__';
    }
  });

  function updatePaneWidth(nextValue) {
    const v = Number(nextValue);
    if (!Number.isFinite(v)) { applySettings(); return; }
    settings.paneWidth = Math.max(520, Math.min(2000, Math.round(v / 10) * 10));
    applySettings();
    onRender(true);
    scheduleSettingsSave();
  }
  function updatePaneOpacity(nextValue) {
    const v = Number(nextValue);
    if (!Number.isFinite(v)) { applySettings(); return; }
    settings.paneOpacity = Math.max(0.55, Math.min(1, Number(v.toFixed(2))));
    applySettings();
    scheduleSettingsSave();
  }
  function updatePaneMaskOpacity(nextValue) {
    const v = Number(nextValue);
    if (!Number.isFinite(v)) { applySettings(); return; }
    settings.paneMaskOpacity = Math.max(0, Math.min(1, Number(v.toFixed(2))));
    applySettings();
    scheduleSettingsSave();
  }

  paneWidthRangeEl.addEventListener('input',      () => updatePaneWidth(paneWidthRangeEl.value));
  paneOpacityRangeEl.addEventListener('input',    () => updatePaneOpacity(paneOpacityRangeEl.value));
  paneMaskOpacityRangeEl.addEventListener('input',() => updatePaneMaskOpacity(paneMaskOpacityRangeEl.value));

  breathingAlertToggleEl.addEventListener('change', () => {
    settings.breathingAlertEnabled = breathingAlertToggleEl.checked;
    paneActivityWatcher.setGlobalEnabled(settings.breathingAlertEnabled);
    scheduleSettingsSave();
  });

  notificationsToggleEl?.addEventListener('change', () => {
    settings.notificationsEnabled = notificationsToggleEl.checked;
    scheduleSettingsSave();
  });

  notificationSilenceEl?.addEventListener('change', () => {
    const secs = Math.max(5, Math.min(300, Number(notificationSilenceEl.value) || 30));
    notificationSilenceEl.value = String(secs);
    settings.notificationSilenceMs = secs * 1000;
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
    onUpdateStatus();
    scheduleSettingsSave();
  });

  windowTitleFormatInputEl?.addEventListener('input', () => {
    settings.windowTitleFormat = windowTitleFormatInputEl.value;
    onUpdateStatus();
    scheduleSettingsSave();
  });
  statusBarFormatInputEl?.addEventListener('input', () => {
    settings.statusBarFormat = statusBarFormatInputEl.value;
    onUpdateStatus();
    scheduleSettingsSave();
  });
  statusBarHintsInputEl?.addEventListener('input', () => {
    settings.statusBarHints = statusBarHintsInputEl.value;
    onUpdateStatus();
    scheduleSettingsSave();
  });

  window.addEventListener('pointerdown', (event) => {
    if (!settingsPanelEl.classList.contains('is-hidden') && !settingsPanelEl.contains(event.target)) {
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
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey) {
      if (event.key === '=' || event.key === '+') {
        event.preventDefault();
        settings.fontSize = Math.min(24, settings.fontSize + 1);
        applySettings(); onRender(true); scheduleSettingsSave();
      } else if (event.key === '-') {
        event.preventDefault();
        settings.fontSize = Math.max(10, settings.fontSize - 1);
        applySettings(); onRender(true); scheduleSettingsSave();
      } else if (event.key === '0') {
        event.preventDefault();
        settings.fontSize = 13;
        applySettings(); onRender(true); scheduleSettingsSave();
      }
    }
  });

  settingsSubpageBackEl.addEventListener('click', () => {
    closeSubPage();
  });

  shellProfilesSettingsBtn.addEventListener('click', () => { openShellProfilesSubPage(); });
  shellProfilesSettingsBtn.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openShellProfilesSubPage(); }
  });

  keyboardShortcutsSettingsBtn.addEventListener('click', () => {
    openSubPage('Keyboard Shortcuts', (contentEl) => {
      ShortcutsUI.renderIntoContainer(contentEl, bridge, scheduleSettingsSave);
    });
  });
  keyboardShortcutsSettingsBtn.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openSubPage('Keyboard Shortcuts', (contentEl) => {
        ShortcutsUI.renderIntoContainer(contentEl, bridge, scheduleSettingsSave);
      });
    }
  });

  async function runInstallShellIntegration() {
    const statusLabelEl = document.getElementById('status-label');
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
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); runInstallShellIntegration(); }
  });

  bridge.onOpenSettings(() => {
    settingsPanelEl.classList.remove('is-hidden');
  });

  // ── Public API ─────────────────────────────────────────────────────────────
  return {
    applyPersistedSettings,
    applySettings,
    applyColorMode,
    applyColorModeUI,
    applyTranslations,
    scheduleSettingsSave,
    flushSettingsSave,
    buildSessionData,
    openSettingsToTab,
    openSubPage,
    closeSubPage,
    loadShellProfiles,
    restartPane,
    changePaneShell,
    getShellProfiles: () => shellProfiles,
    getDefaultShellProfileId: () => defaultShellProfileId,
    get settingsPanelEl() { return settingsPanelEl; },
  };
}
