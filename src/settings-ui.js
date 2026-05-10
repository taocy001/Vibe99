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
import { COLOR_PRESETS, DEFAULT_PRESET_ID, getPreset } from './color-presets.js';
import { parseItermcolors, generateItermcolors } from './itermcolors.js';

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
  copyOnSelect: false,
  showStatusBar: false,
  colorMode: 'dark',
  language: 'en',
  windowTitleFormat: '\\w',
  statusBarFormat: '\\w\\p',
  statusBarHints: 'cycleRecent,enterNav,newPane,closePane,toggleSearch,splitRight',
  colorPresetId: DEFAULT_PRESET_ID,
  customPalette: null,
};

// ---------------------------------------------------------------------------
// Theme helpers (used by both settings-ui and the terminal renderer)
// ---------------------------------------------------------------------------

export function resolveEffectiveColorMode() {
  if (settings.colorMode !== 'auto') return settings.colorMode;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function readTerminalVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function createTerminalTheme(accent) {
  const mode  = resolveEffectiveColorMode();
  const bg    = readTerminalVar('--terminal-bg');
  const fg    = readTerminalVar('--terminal-fg');
  const selBg = readTerminalVar('--terminal-selection-bg');
  const preset = settings.colorPresetId === 'custom' && settings.customPalette
    ? settings.customPalette : getPreset(settings.colorPresetId ?? DEFAULT_PRESET_ID);
  const p = preset[mode] ?? getPreset(DEFAULT_PRESET_ID)[mode];
  const a = p.ansi;
  return {
    // Transparent background lets allowTransparency:true show through to CSS bg.
    background: mode === 'dark' ? bg + '00' : bg,
    foreground: fg,
    // Near-bg selection keeps selectionBackgroundOpaque close to terminal bg,
    // minimising the glyph anti-aliased edge delta in the WebGL renderer.
    selectionBackground: selBg,
    cursor: accent,
    cursorAccent: mode === 'dark' ? p.background : '#ffffff',
    black: a[0], red: a[1], green: a[2], yellow: a[3],
    blue: a[4], magenta: a[5], cyan: a[6], white: a[7],
    brightBlack: a[8], brightRed: a[9], brightGreen: a[10], brightYellow: a[11],
    brightBlue: a[12], brightMagenta: a[13], brightCyan: a[14], brightWhite: a[15],
  };
}

export function fixXtermViewportBg(terminalHost, _mode) {
  const vp = terminalHost.querySelector('.xterm-viewport');
  if (vp) vp.style.backgroundColor = resolveEffectiveColorMode() === 'light'
    ? readTerminalVar('--terminal-bg')
    : '';
}

export function applyTerminalPalette() {
  const mode = resolveEffectiveColorMode();
  const preset = settings.colorPresetId === 'custom' && settings.customPalette
    ? settings.customPalette : getPreset(settings.colorPresetId ?? DEFAULT_PRESET_ID);
  const p = preset[mode] ?? getPreset(DEFAULT_PRESET_ID)[mode];
  document.documentElement.style.setProperty('--terminal-bg', p.background);
  document.documentElement.style.setProperty('--terminal-fg', p.foreground);
  document.documentElement.style.setProperty('--terminal-selection-bg', p.selectionBg);
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
  saveSession = true,
  onOpenSshConnection = null,
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

  // Master font list: system = always available on macOS; others detected at runtime.
  // Non-system entries include Nerd Font fallback names so Powerline/icon glyphs render
  // when the Nerd Font variant of a font is installed alongside the base font.
  const FONT_PRESETS_DEF = [
    { value: 'Menlo, monospace',                                              label: 'Menlo',           system: true  },
    { value: 'Monaco, monospace',                                             label: 'Monaco',          system: true  },
    { value: "'SF Mono', monospace",                                          label: 'SF Mono',         system: true  },
    { value: "'JetBrains Mono', 'JetBrainsMono Nerd Font', monospace",        label: 'JetBrains Mono',  system: false },
    { value: "'Fira Code', 'FiraCode Nerd Font', monospace",                  label: 'Fira Code',       system: false },
    { value: "'Cascadia Code', 'CaskaydiaCove Nerd Font', monospace",         label: 'Cascadia Code',   system: false },
    { value: 'Consolas, monospace',                                           label: 'Consolas',        system: false },
    { value: "'Hack', 'Hack Nerd Font', monospace",                           label: 'Hack',            system: false },
    { value: "'Source Code Pro', 'SauceCodePro Nerd Font', monospace",        label: 'Source Code Pro', system: false },
    { value: "'Inconsolata', 'Inconsolata Nerd Font', monospace",              label: 'Inconsolata',     system: false },
    { value: "'MesloLGS NF', 'MesloLGS Nerd Font', monospace",               label: 'MesloLGS NF',     system: false },
    { value: "'DejaVu Sans Mono', 'DejaVuSansMono Nerd Font', monospace",     label: 'DejaVu Sans Mono',system: false },
    // Courier New: system: true because the monospace CSS generic often resolves to Courier/
    // Courier New, making canvas measureText return an identical width and falsely flag it
    // as "not installed". It is available on all macOS and Windows systems.
    { value: "'Courier New', monospace",                                      label: 'Courier New',     system: true  },
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
  const notificationSilenceRow  = document.getElementById('notifications-silence-row');
  const copyOnSelectToggleEl   = document.getElementById('copy-on-select-toggle');
  const showStatusBarToggleEl  = document.getElementById('show-status-bar-toggle');
  const statusBarConfigRowsEl  = document.getElementById('status-bar-config-rows');
  const windowTitleFormatInputEl = document.getElementById('window-title-format');
  const statusBarFormatInputEl   = document.getElementById('status-bar-format');
  const statusBarHintsInputEl    = document.getElementById('status-bar-hints');
  const colorModeSegmentedEl     = document.getElementById('color-mode-segmented');
  const colorPresetGridEl  = document.getElementById('color-preset-grid');
  const colorImportBtnEl   = document.getElementById('color-import-btn');
  const colorExportBtnEl   = document.getElementById('color-export-btn');
  const colorImportInputEl = document.getElementById('color-import-input');
  const shellIntegrationInstallBtn   = document.getElementById('shell-integration-install-btn');
  const profilesTabListEl   = document.getElementById('profiles-tab-list');
  const profilesTabEditorEl = document.getElementById('profiles-tab-editor');
  const profilesTabAddBtnEl = document.getElementById('profiles-tab-add-btn');
  const keysTabContentEl    = document.getElementById('keys-tab-content');
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

  function _buildColorPresetsGrid() {
    if (!colorPresetGridEl) return;
    const mode = resolveEffectiveColorMode();
    colorPresetGridEl.replaceChildren();
    const entries = [...Object.entries(COLOR_PRESETS)];
    if (settings.colorPresetId === 'custom' && settings.customPalette) {
      entries.push(['custom', { label: 'Custom', ...settings.customPalette }]);
    }
    for (const [id, preset] of entries) {
      const palette = preset[mode];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'color-preset-card';
      if (id === settings.colorPresetId) btn.classList.add('is-active');
      btn.dataset.presetId = id;
      const preview = document.createElement('div');
      preview.className = 'color-preset-preview';
      preview.style.background = palette.background;
      for (const i of [1, 2, 3, 4, 5, 6]) {
        const dot = document.createElement('span');
        dot.className = 'color-preset-dot';
        dot.style.background = palette.ansi[i];
        preview.appendChild(dot);
      }
      const label = document.createElement('span');
      label.className = 'color-preset-label';
      label.textContent = preset.label;
      btn.appendChild(preview);
      btn.appendChild(label);
      colorPresetGridEl.appendChild(btn);
    }
  }

  function applyColorsUI() {
    _buildColorPresetsGrid();
  }

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
    applyTerminalPalette();
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
    if (notificationSilenceRow) notificationSilenceRow.classList.toggle('is-hidden', !settings.notificationsEnabled);
    copyOnSelectToggleEl.checked = settings.copyOnSelect;
    showStatusBarToggleEl.checked = settings.showStatusBar;
    document.body.classList.toggle('hide-status-bar', !settings.showStatusBar);
    if (statusBarConfigRowsEl) statusBarConfigRowsEl.classList.toggle('is-hidden', !settings.showStatusBar);
    applyColorModeUI(settings.colorMode);
    applyColorMode(settings.colorMode);
    applyColorsUI();
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
        // Legacy multi-fallback defaults → single-family format
        'Menlo, Monaco, "SF Mono", monospace': 'Menlo, monospace',
        'Consolas, "Cascadia Mono", "Courier New", monospace': 'Consolas, monospace',
        '"DejaVu Sans Mono", "Liberation Mono", "Ubuntu Mono", monospace': "'DejaVu Sans Mono', monospace",
        // Pre-P1.4 presets → Nerd Font fallback stacks
        "'JetBrains Mono', monospace": "'JetBrains Mono', 'JetBrainsMono Nerd Font', monospace",
        "'Fira Code', monospace": "'Fira Code', 'FiraCode Nerd Font', monospace",
        "'Cascadia Code', monospace": "'Cascadia Code', 'CaskaydiaCove Nerd Font', monospace",
        "'Hack', monospace": "'Hack', 'Hack Nerd Font', monospace",
        "'Source Code Pro', monospace": "'Source Code Pro', 'SauceCodePro Nerd Font', monospace",
        "'Inconsolata', monospace": "'Inconsolata', 'Inconsolata Nerd Font', monospace",
        "'Inconsolata', 'InconsolataLGC Nerd Font', monospace": "'Inconsolata', 'Inconsolata Nerd Font', monospace",
        "'MesloLGS NF', monospace": "'MesloLGS NF', 'MesloLGS Nerd Font', monospace",
        "'MesloLGS NF', 'Meslo LG S for Powerline', monospace": "'MesloLGS NF', 'MesloLGS Nerd Font', monospace",
        "'DejaVu Sans Mono', monospace": "'DejaVu Sans Mono', 'DejaVuSansMono Nerd Font', monospace",
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
    if (typeof uiSettings.copyOnSelect  === 'boolean')         settings.copyOnSelect          = uiSettings.copyOnSelect;
    if (typeof uiSettings.showStatusBar === 'boolean')         settings.showStatusBar         = uiSettings.showStatusBar;
    if (typeof uiSettings.colorMode === 'string') settings.colorMode = uiSettings.colorMode;
    if (typeof uiSettings.language === 'string') {
      settings.language = uiSettings.language;
      setLocale(uiSettings.language);
    }
    if (typeof uiSettings.windowTitleFormat === 'string') settings.windowTitleFormat = uiSettings.windowTitleFormat;
    if (typeof uiSettings.statusBarFormat   === 'string') settings.statusBarFormat   = uiSettings.statusBarFormat;
    if (typeof uiSettings.statusBarHints    === 'string') settings.statusBarHints    = uiSettings.statusBarHints;
    if (typeof uiSettings.colorPresetId === 'string') settings.colorPresetId = uiSettings.colorPresetId;
    if (uiSettings.customPalette && typeof uiSettings.customPalette === 'object') {
      settings.customPalette = uiSettings.customPalette;
    }

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
        ...(saveSession && { session: buildSessionData() }),
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
        ...(saveSession && { session: buildSessionData() }),
      };
      void bridge.saveSettings(settingsToSave).catch(reportError);
    }
  }

  // ── Shell profile management ───────────────────────────────────────────────

  function loadShellProfiles() {
    return Promise.all([
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
        if (profile.kind === 'ssh') {
          const badge = document.createElement('span');
          badge.className = 'shell-profile-ssh-badge';
          badge.textContent = 'SSH';
          name.appendChild(badge);
        }

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
          editingShellProfile = {
            id: profile.id,
            name: profile.name || '',
            command: profile.command,
            args: formatArgs(profile.args ?? []),
            kind: profile.kind || 'local',
            sshHost: profile.sshConfig?.host ?? '',
            sshPort: profile.sshConfig?.port != null ? String(profile.sshConfig.port) : '',
            sshUser: profile.sshConfig?.user ?? '',
            sshIdentityFile: profile.sshConfig?.identityFile ?? '',
            isNew: false,
          };
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
      ...(profile.kind === 'ssh' && { kind: 'ssh', sshConfig: { ...profile.sshConfig } }),
    };
    bridge.addShellProfile(clonedProfile).then((config) => {
      const userIds = new Set((config.profiles ?? []).map((p) => p.id));
      shellProfiles = [...(config.profiles ?? []), ...detectedShellProfiles.filter((p) => !userIds.has(p.id))];
      defaultShellProfileId = config.defaultProfile ?? '';
      selectedShellProfileId = clonedProfile.id;
      editingShellProfile = {
        id: clonedProfile.id,
        name: clonedProfile.name,
        command: clonedProfile.command,
        args: formatArgs(clonedProfile.args ?? []),
        kind: clonedProfile.kind || 'local',
        sshHost: clonedProfile.sshConfig?.host ?? '',
        sshPort: clonedProfile.sshConfig?.port != null ? String(clonedProfile.sshConfig.port) : '',
        sshUser: clonedProfile.sshConfig?.user ?? '',
        sshIdentityFile: clonedProfile.sshConfig?.identityFile ?? '',
        isNew: true,
      };
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

  function buildSshArgs(sshConfig) {
    const args = ['-t'];
    if (sshConfig.port) args.push('-p', String(sshConfig.port));
    if (sshConfig.identityFile) args.push('-i', sshConfig.identityFile);
    const target = sshConfig.user ? `${sshConfig.user}@${sshConfig.host}` : sshConfig.host;
    args.push('--', target);
    return args;
  }

  function createModalShellProfileEditor() {
    const editor = document.createElement('div');
    editor.className = 'shell-profile-editor';

    const isSsh = (editingShellProfile.kind || 'local') === 'ssh';

    // Type selector
    const typeLabel = document.createElement('label');
    typeLabel.textContent = 'Type';
    typeLabel.setAttribute('for', 'modal-shell-edit-kind');
    const typeSelect = document.createElement('select');
    typeSelect.id = 'modal-shell-edit-kind';
    typeSelect.className = 'shell-profile-type-select';
    [['local', 'Local Shell'], ['ssh', 'SSH']].forEach(([val, lbl]) => {
      const opt = document.createElement('option');
      opt.value = val; opt.textContent = lbl;
      typeSelect.appendChild(opt);
    });
    typeSelect.value = editingShellProfile.kind || 'local';
    editor.append(typeLabel, typeSelect);

    // Common fields: Name and ID
    const commonFields = [
      { key: 'name', label: 'Name (optional)', placeholder: 'e.g. My Server' },
      { key: 'id',   label: 'ID',              placeholder: 'e.g. my-server' },
    ];
    const inputs = {};
    for (const field of commonFields) {
      const label = document.createElement('label');
      label.textContent = field.label;
      label.setAttribute('for', `modal-shell-edit-${field.key}`);
      const input = document.createElement('input');
      input.id = `modal-shell-edit-${field.key}`;
      input.type = 'text';
      input.value = editingShellProfile[field.key] ?? '';
      input.placeholder = field.placeholder;
      inputs[field.key] = input;
      if (field.key === 'name' && editingShellProfile.isNew) {
        input.addEventListener('input', () => {
          if (!inputs.id.value && input.value.trim()) {
            inputs.id.value = input.value.trim().toLowerCase().replace(/\s+/g, '-');
          }
        });
      }
      editor.append(label, input);
    }

    // Local-only fields
    const localSection = document.createElement('div');
    localSection.className = 'shell-profile-local-fields';
    [
      { key: 'command', label: 'Command',   placeholder: '/bin/zsh' },
      { key: 'args',    label: 'Arguments', placeholder: '-il' },
    ].forEach(({ key, label: lbl, placeholder }) => {
      const labelEl = document.createElement('label');
      labelEl.textContent = lbl;
      labelEl.setAttribute('for', `modal-shell-edit-${key}`);
      const input = document.createElement('input');
      input.id = `modal-shell-edit-${key}`;
      input.type = 'text';
      input.value = editingShellProfile[key] ?? '';
      input.placeholder = placeholder;
      inputs[key] = input;
      localSection.append(labelEl, input);
    });
    editor.appendChild(localSection);

    // SSH-only fields
    const sshSection = document.createElement('div');
    sshSection.className = 'shell-profile-ssh-fields';
    const sshFieldDefs = [
      { key: 'sshHost',         label: 'Host',          placeholder: 'example.com' },
      { key: 'sshPort',         label: 'Port',          placeholder: '22' },
      { key: 'sshUser',         label: 'User',          placeholder: 'ubuntu' },
      { key: 'sshIdentityFile', label: 'Identity File', placeholder: '~/.ssh/id_rsa' },
    ];
    for (const { key, label: lbl, placeholder } of sshFieldDefs) {
      const labelEl = document.createElement('label');
      labelEl.textContent = lbl;
      labelEl.setAttribute('for', `modal-shell-edit-${key}`);
      const input = document.createElement('input');
      input.id = `modal-shell-edit-${key}`;
      input.type = 'text';
      input.value = editingShellProfile[key] ?? '';
      input.placeholder = placeholder;
      inputs[key] = input;
      sshSection.append(labelEl, input);
    }
    editor.appendChild(sshSection);

    // Show/hide sections based on current type selection
    function updateTypeUI() {
      const ssh = typeSelect.value === 'ssh';
      localSection.style.display = ssh ? 'none' : 'contents';
      sshSection.style.display = ssh ? 'contents' : 'none';
    }
    typeSelect.addEventListener('change', updateTypeUI);
    updateTypeUI();

    // Actions
    const actionsEl = document.createElement('div');
    actionsEl.className = 'shell-profile-editor-actions';

    // "Open Connection" button for SSH profiles
    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'settings-btn shell-profile-editor-btn ssh-open-btn';
    openBtn.textContent = 'Open Connection';
    openBtn.title = 'Open a new pane with this SSH profile';
    openBtn.style.display = isSsh && !editingShellProfile.isNew ? '' : 'none';
    openBtn.addEventListener('click', () => {
      if (onOpenSshConnection && selectedShellProfileId) {
        settingsPanelEl.classList.add('is-hidden');
        onOpenSshConnection(selectedShellProfileId);
      }
    });

    typeSelect.addEventListener('change', () => {
      openBtn.style.display = typeSelect.value === 'ssh' && !editingShellProfile.isNew ? '' : 'none';
    });

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
      const kind = typeSelect.value;
      const id = inputs.id.value.trim();
      const name = inputs.name.value.trim();
      if (!id) { reportError(new Error('ID is required')); return; }

      let profile;
      if (kind === 'ssh') {
        const host = inputs.sshHost.value.trim();
        if (!host) { reportError(new Error('Host is required for SSH profiles')); return; }
        const rawPort = inputs.sshPort.value.trim();
        const portNum = rawPort ? Number(rawPort) : null;
        if (portNum !== null && (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535)) {
          reportError(new Error('Port must be a number between 1 and 65535'));
          return;
        }
        const sshConfig = {
          host,
          ...(portNum !== null && portNum !== 22 && { port: portNum }),
          ...(inputs.sshUser.value.trim() && { user: inputs.sshUser.value.trim() }),
          ...(inputs.sshIdentityFile.value.trim() && { identityFile: inputs.sshIdentityFile.value.trim() }),
        };
        profile = { id, name, kind: 'ssh', command: 'ssh', args: buildSshArgs(sshConfig), sshConfig };
      } else {
        const command = inputs.command.value.trim();
        if (!command) { reportError(new Error('Command is required')); return; }
        profile = { id, name, command, args: splitArgs(inputs.args.value.trim()) };
      }

      bridge.addShellProfile(profile).then((config) => {
        const userIds = new Set((config.profiles ?? []).map((p) => p.id));
        shellProfiles = [...(config.profiles ?? []), ...detectedShellProfiles.filter((p) => !userIds.has(p.id))];
        defaultShellProfileId = config.defaultProfile ?? '';
        selectedShellProfileId = profile.id;
        const saved = shellProfiles.find((p) => p.id === profile.id) ?? profile;
        editingShellProfile = {
          id: saved.id,
          name: saved.name || '',
          command: saved.command,
          args: formatArgs(saved.args ?? []),
          kind: saved.kind || 'local',
          sshHost: saved.sshConfig?.host ?? '',
          sshPort: saved.sshConfig?.port != null ? String(saved.sshConfig.port) : '',
          sshUser: saved.sshConfig?.user ?? '',
          sshIdentityFile: saved.sshConfig?.identityFile ?? '',
          isNew: false,
        };
        renderModalShellProfiles();
      }).catch(reportError);
    });

    actionsEl.append(openBtn, cancel, save);
    editor.appendChild(actionsEl);

    queueMicrotask(() => {
      const firstInput = editor.querySelector('input');
      if (firstInput) { firstInput.focus(); firstInput.select(); }
    });
    return editor;
  }

  // ── SSH Connections subpage ────────────────────────────────────────────────

  function sshProfileDisplayHost(profile) {
    const sc = profile.sshConfig;
    if (!sc) return profile.command;
    const addr = sc.port && sc.port !== 22 ? `${sc.host}:${sc.port}` : sc.host;
    return sc.user ? `${sc.user}@${addr}` : addr;
  }

  function openSshConnectionsSubPage() {
    loadShellProfiles();
    // Hoist form state so onAction callback (4th arg) can close over them
    let formVisible = false;
    let formEl = null;
    openSubPage('SSH 连接', (contentEl) => {
      const container = document.createElement('div');
      container.className = 'ssh-connections-container';

      // ── Inline "new connection" form (hidden by default) ──
      formEl = document.createElement('div');
      formEl.className = 'ssh-quick-form';
      formEl.style.display = 'none';

      const formFields = [
        { key: 'name',         label: 'Name (optional)', placeholder: 'My Server' },
        { key: 'host',         label: 'Host',            placeholder: 'example.com' },
        { key: 'port',         label: 'Port',            placeholder: '22' },
        { key: 'user',         label: 'User',            placeholder: 'ubuntu' },
        { key: 'identityFile', label: 'Identity File',   placeholder: '~/.ssh/id_rsa' },
      ];
      const formInputs = {};
      for (const { key, label: lbl, placeholder } of formFields) {
        const labelEl = document.createElement('label');
        labelEl.textContent = lbl;
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.placeholder = placeholder;
        formInputs[key] = inp;
        formEl.append(labelEl, inp);
      }
      const formActions = document.createElement('div');
      formActions.className = 'ssh-quick-form-actions';
      const cancelFormBtn = document.createElement('button');
      cancelFormBtn.className = 'settings-btn shell-profile-editor-btn';
      cancelFormBtn.textContent = 'Cancel';
      cancelFormBtn.addEventListener('click', () => {
        formEl.style.display = 'none';
        formVisible = false;
      });
      const saveFormBtn = document.createElement('button');
      saveFormBtn.className = 'settings-btn shell-profile-editor-btn is-primary';
      saveFormBtn.textContent = 'Save & Connect';
      saveFormBtn.addEventListener('click', () => {
        const host = formInputs.host.value.trim();
        if (!host || host.startsWith('-')) { reportError(new Error('Invalid host')); return; }
        const rawPort = formInputs.port.value.trim();
        const portNum = rawPort ? Number(rawPort) : null;
        if (portNum !== null && (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535)) {
          reportError(new Error('Port must be 1–65535'));
          return;
        }
        const name = formInputs.name.value.trim() || host;
        const id = `ssh-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}`;
        const sshConfig = {
          host,
          ...(portNum && portNum !== 22 && { port: portNum }),
          ...(formInputs.user.value.trim() && { user: formInputs.user.value.trim() }),
          ...(formInputs.identityFile.value.trim() && { identityFile: formInputs.identityFile.value.trim() }),
        };
        const profile = { id, name, kind: 'ssh', command: 'ssh', args: buildSshArgs(sshConfig), sshConfig };
        bridge.addShellProfile(profile).then((config) => {
          const userIds = new Set((config.profiles ?? []).map((p) => p.id));
          shellProfiles = [...(config.profiles ?? []), ...detectedShellProfiles.filter((p) => !userIds.has(p.id))];
          defaultShellProfileId = config.defaultProfile ?? '';
          formEl.style.display = 'none';
          formVisible = false;
          settingsPanelEl.classList.add('is-hidden');
          if (onOpenSshConnection) onOpenSshConnection(id);
        }).catch(reportError);
      });
      formActions.append(cancelFormBtn, saveFormBtn);
      formEl.appendChild(formActions);
      container.appendChild(formEl);

      // ── Saved SSH profiles ──
      const savedSection = document.createElement('div');
      savedSection.className = 'ssh-connections-section';
      const savedTitle = document.createElement('div');
      savedTitle.className = 'ssh-connections-section-title';
      savedTitle.textContent = '已保存的连接';
      savedSection.appendChild(savedTitle);

      const sshProfiles = shellProfiles.filter((p) => p.kind === 'ssh');
      if (sshProfiles.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'ssh-connections-empty';
        empty.textContent = '暂无保存的 SSH 连接，点击 + 新建';
        savedSection.appendChild(empty);
      } else {
        for (const profile of sshProfiles) {
          const row = document.createElement('div');
          row.className = 'ssh-connections-row';
          const info = document.createElement('div');
          info.className = 'ssh-connections-info';
          const nameEl = document.createElement('div');
          nameEl.className = 'ssh-connections-name';
          nameEl.textContent = profile.name || profile.id;
          const hostEl = document.createElement('div');
          hostEl.className = 'ssh-connections-host';
          hostEl.textContent = sshProfileDisplayHost(profile);
          info.append(nameEl, hostEl);
          const openBtn = document.createElement('button');
          openBtn.className = 'settings-btn ssh-connections-open-btn';
          openBtn.textContent = 'Open';
          openBtn.addEventListener('click', () => {
            settingsPanelEl.classList.add('is-hidden');
            if (onOpenSshConnection) onOpenSshConnection(profile.id);
          });
          row.append(info, openBtn);
          savedSection.appendChild(row);
        }
      }
      container.appendChild(savedSection);

      // ── ~/.ssh/config entries ──
      const configSection = document.createElement('div');
      configSection.className = 'ssh-connections-section';
      const configTitle = document.createElement('div');
      configTitle.className = 'ssh-connections-section-title';
      configTitle.textContent = '来自 ~/.ssh/config';
      configSection.appendChild(configTitle);

      const loadingEl = document.createElement('div');
      loadingEl.className = 'ssh-connections-empty';
      loadingEl.textContent = '正在读取…';
      configSection.appendChild(loadingEl);
      container.appendChild(configSection);

      const savedAliases = new Set(sshProfiles.map((p) => p.sshConfig?.host ?? p.id));

      bridge.readSshConfig().then((entries) => {
        loadingEl.remove();
        const unsaved = entries.filter((e) => !savedAliases.has(e.alias) && !savedAliases.has(e.host));
        if (unsaved.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'ssh-connections-empty';
          empty.textContent = entries.length === 0 ? '未找到 ~/.ssh/config' : '所有主机已保存为连接';
          configSection.appendChild(empty);
          return;
        }
        for (const entry of unsaved) {
          const row = document.createElement('div');
          row.className = 'ssh-connections-row';
          const info = document.createElement('div');
          info.className = 'ssh-connections-info';
          const nameEl = document.createElement('div');
          nameEl.className = 'ssh-connections-name';
          nameEl.textContent = entry.alias;
          const hostEl = document.createElement('div');
          hostEl.className = 'ssh-connections-host';
          const addr = entry.port && entry.port !== 22 ? `${entry.host}:${entry.port}` : entry.host;
          hostEl.textContent = entry.user ? `${entry.user}@${addr}` : addr;
          info.append(nameEl, hostEl);
          const connectBtn = document.createElement('button');
          connectBtn.className = 'settings-btn ssh-connections-open-btn';
          connectBtn.textContent = 'Connect';
          connectBtn.addEventListener('click', () => {
            // Create a profile for this alias then open it
            const id = `ssh-config-${entry.alias}`;
            const sshConfig = {
              host: entry.alias,  // use alias; ssh resolves via ~/.ssh/config
              ...(entry.port && entry.port !== 22 && { port: entry.port }),
              ...(entry.user && { user: entry.user }),
              ...(entry.identityFile && { identityFile: entry.identityFile }),
            };
            const profile = {
              id,
              name: entry.alias,
              kind: 'ssh',
              command: 'ssh',
              args: ['-t', entry.alias],
              sshConfig,
            };
            bridge.addShellProfile(profile).then((config) => {
              const userIds = new Set((config.profiles ?? []).map((p) => p.id));
              shellProfiles = [...(config.profiles ?? []), ...detectedShellProfiles.filter((p) => !userIds.has(p.id))];
              defaultShellProfileId = config.defaultProfile ?? '';
              settingsPanelEl.classList.add('is-hidden');
              if (onOpenSshConnection) onOpenSshConnection(id);
            }).catch(reportError);
          });
          row.append(info, connectBtn);
          configSection.appendChild(row);
        }
      }).catch(() => {
        loadingEl.textContent = '读取 ~/.ssh/config 失败';
      });

      contentEl.appendChild(container);
    }, '+', () => {
      if (!formEl) return;
      formVisible = !formVisible;
      formEl.style.display = formVisible ? 'grid' : 'none';
      if (formVisible) {
        const firstInput = formEl.querySelector('input');
        if (firstInput) firstInput.focus();
      }
    });
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
    settingsSubpageBackEl.focus();
  }

  function initProfilesTab() {
    _spShellListEl = profilesTabListEl;
    _spShellEditorEl = profilesTabEditorEl;
    loadShellProfiles().then(() => {
      if (shellProfiles.length > 0) {
        const first = shellProfiles[0];
        selectedShellProfileId = first.id;
        editingShellProfile = {
          id: first.id,
          name: first.name || '',
          command: first.command,
          args: formatArgs(first.args ?? []),
          kind: first.kind || 'local',
          sshHost: first.sshConfig?.host ?? '',
          sshPort: first.sshConfig?.port != null ? String(first.sshConfig.port) : '',
          sshUser: first.sshConfig?.user ?? '',
          sshIdentityFile: first.sshConfig?.identityFile ?? '',
          isNew: false,
        };
      } else {
        selectedShellProfileId = null;
        editingShellProfile = null;
      }
      renderModalShellProfiles();
    });
  }

  // ── Settings UI event listeners ────────────────────────────────────────────

  let profilesTabInitialized = false;
  let keysTabInitialized = false;

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
    if (tabId === 'profiles' && !profilesTabInitialized) {
      profilesTabInitialized = true;
      initProfilesTab();
    }
    if (tabId === 'keys' && !keysTabInitialized) {
      keysTabInitialized = true;
      ShortcutsUI.renderIntoContainer(keysTabContentEl, bridge, scheduleSettingsSave);
    }
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
    if (notificationSilenceRow) notificationSilenceRow.classList.toggle('is-hidden', !settings.notificationsEnabled);
    scheduleSettingsSave();
  });

  notificationSilenceEl?.addEventListener('change', () => {
    const secs = Math.max(5, Math.min(300, Number(notificationSilenceEl.value) || 30));
    notificationSilenceEl.value = String(secs);
    settings.notificationSilenceMs = secs * 1000;
    scheduleSettingsSave();
  });

  copyOnSelectToggleEl.addEventListener('change', () => {
    settings.copyOnSelect = copyOnSelectToggleEl.checked;
    scheduleSettingsSave();
  });

  showStatusBarToggleEl.addEventListener('change', () => {
    settings.showStatusBar = showStatusBarToggleEl.checked;
    document.body.classList.toggle('hide-status-bar', !settings.showStatusBar);
    if (statusBarConfigRowsEl) statusBarConfigRowsEl.classList.toggle('is-hidden', !settings.showStatusBar);
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

  profilesTabAddBtnEl?.addEventListener('click', () => {
    editingShellProfile = { id: '', name: '', command: '', args: '', kind: 'local', sshHost: '', sshPort: '', sshUser: '', sshIdentityFile: '', isNew: true };
    selectedShellProfileId = null;
    renderModalShellProfiles();
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

  // ── Colors tab ─────────────────────────────────────────────────────────────

  colorPresetGridEl?.addEventListener('click', (e) => {
    const card = e.target.closest('.color-preset-card');
    if (!card) return;
    settings.colorPresetId = card.dataset.presetId;
    applyTerminalPalette();
    for (const [, node] of paneNodeMap) {
      node.terminal.options.theme = createTerminalTheme(node.accent || '#888888');
    }
    applyColorsUI();
    scheduleSettingsSave();
  });

  colorImportBtnEl?.addEventListener('click', () => colorImportInputEl?.click());
  colorImportBtnEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); colorImportInputEl?.click(); }
  });

  colorImportInputEl?.addEventListener('change', () => {
    const file = colorImportInputEl.files?.[0];
    if (!file) return;
    file.text().then((text) => {
      const palette = parseItermcolors(text);
      if (!palette) return;
      settings.colorPresetId = 'custom';
      settings.customPalette = { dark: palette, light: palette };
      applyTerminalPalette();
      for (const [, node] of paneNodeMap) {
        node.terminal.options.theme = createTerminalTheme(node.accent || '#888888');
      }
      applyColorsUI();
      scheduleSettingsSave();
    });
    colorImportInputEl.value = '';
  });

  colorExportBtnEl?.addEventListener('click', () => {
    const mode = resolveEffectiveColorMode();
    const preset = settings.colorPresetId === 'custom' && settings.customPalette
      ? settings.customPalette : getPreset(settings.colorPresetId ?? DEFAULT_PRESET_ID);
    const p = preset[mode] ?? getPreset(DEFAULT_PRESET_ID)[mode];
    const xml = generateItermcolors(p);
    const blob = new Blob([xml], { type: 'application/xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${settings.colorPresetId}.itermcolors`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  colorExportBtnEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); colorExportBtnEl.click(); }
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
    openSshConnectionsSubPage,
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
