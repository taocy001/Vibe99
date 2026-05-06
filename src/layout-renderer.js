// DOM rendering pipeline extracted from renderer.js.
// Receives the shared state object `st` and all DOM/module dependencies.

import {
  computeLayout,
  collectDividers,
  collectPanelIds,
  MIN_RATIO,
  MAX_RATIO,
} from './split-layout.js';
import * as ShortcutsRegistry from './shortcuts-registry.js';
import { renderHintBar } from './hint-bar.js';
import { t } from './i18n.js';
import { rafThrottle } from './utils.js';

/**
 * createLayoutRenderer(st, deps)
 *
 * deps: { bridge, settings, paneNodeMap, panelDataMap, activeCwdMap,
 *         splitDividerElMap, splitDividerDataMap, stageEl, tabsListEl,
 *         dividerEls, statusLabelEl, statusHintEl, searchBarEl,
 *         paneActivityWatcher, createTerminalTheme, abbreviatePath,
 *         fitTerminal, scheduleSettingsSave, applySettings,
 *         getFocusedIndex, getTabLayout, getTabsSig, getPaneLabel,
 *         getPreviewWidth, getPaneLeft,
 *         beginTabDrag, showTabContextMenu, handleMenuAction }
 */
export function createLayoutRenderer(st, {
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
  getFocusedIndex,
  getTabLayout,
  getTabsSig,
  getPaneLabel,
  getPreviewWidth,
  getPaneLeft,
  beginTabDrag,
  showTabContextMenu,
  handleMenuAction,
  beginRenamePane,
  commitRenamePane,
  cancelRenamePane,
  ensurePaneNodes,
}) {

  // ── Status / title helpers ─────────────────────────────────────────────────

  function getTextColorForBackground(hexColor) {
    const r = parseInt(hexColor.slice(1, 3), 16);
    const g = parseInt(hexColor.slice(3, 5), 16);
    const b = parseInt(hexColor.slice(5, 7), 16);
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.5 ? '#000' : '#fff';
  }

  function getPanelIndicator(focusedPane) {
    if (!focusedPane?.layout) return '';
    const activePanelId = focusedPane.focusedPanelId ?? focusedPane.id;
    const ids = collectPanelIds(focusedPane.layout);
    return ids.length > 1 ? `  ·  ${ids.indexOf(activePanelId) + 1}/${ids.length}` : '';
  }

  function expandTitleVars(fmt, focusedPane, sysInfo, panelIndicator = '') {
    const activePanelId = focusedPane?.focusedPanelId ?? focusedPane?.id;
    const rawCwd = activeCwdMap.get(activePanelId)
      ?? panelDataMap.get(activePanelId)?.cwd
      ?? focusedPane?.cwd
      ?? '';
    const abbrCwd = abbreviatePath(rawCwd);
    const cwdBase = abbrCwd ? (abbrCwd === '~' ? '~' : abbrCwd.split('/').pop() || '/') : '';
    const shortHost = sysInfo.hostname.split('.')[0];
    return fmt
      .replace(/\\w/g, abbrCwd)
      .replace(/\\W/g, cwdBase)
      .replace(/\\u/g, sysInfo.username)
      .replace(/\\H/g, sysInfo.hostname)
      .replace(/\\h/g, shortHost)
      .replace(/\\p/g, panelIndicator);
  }

  // sysInfo is fetched once after bridge is ready
  let sysInfo = { username: '', hostname: '' };
  bridge.getSystemInfo().then((info) => { sysInfo = info; }).catch(() => {});

  function updateStatus() {
    const focusedPane = st.panes[getFocusedIndex()];
    const focusedPaneLabel = getPaneLabel(focusedPane) || focusedPane?.id || '';
    const keymap = ShortcutsRegistry.getActiveKeymap();
    const { modeLabel: hintModeLabel, hintsHtml } = renderHintBar(
      keymap, st.currentMode, focusedPaneLabel, bridge.platform, settings.statusBarHints
    );
    let modeLabel;
    if (st.currentMode !== 'terminal') {
      modeLabel = hintModeLabel;
    } else {
      const pi = getPanelIndicator(focusedPane);
      const formatted = expandTitleVars(settings.statusBarFormat, focusedPane, sysInfo, pi);
      modeLabel = formatted.trim() ? formatted : focusedPaneLabel;
    }
    statusLabelEl.textContent = modeLabel;
    statusLabelEl.classList.toggle('is-navigation-mode', st.currentMode === 'nav');
    statusHintEl.innerHTML = hintsHtml;
    const pi = getPanelIndicator(focusedPane);
    const titleText = expandTitleVars(settings.windowTitleFormat, focusedPane, sysInfo, pi).trim();
    bridge.setWindowTitle(titleText || 'Vibe99');
  }

  // ── Tab rendering ────────────────────────────────────────��─────────────────

  function createTab(pane, index, focusedIndex, dragMeta) {
    const tab = document.createElement('div');
    tab.className = `tab${index === focusedIndex ? ' is-focused' : ''}`;
    if (dragMeta?.isDragging) { tab.classList.add('is-dragging'); tab.style.transform = `translateX(${dragMeta.offsetX}px)`; }
    if (dragMeta?.insertBefore) tab.classList.add('insert-before');
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
    tabMain.addEventListener('pointerdown', (e) => beginTabDrag(index, e));
    tabMain.addEventListener('dblclick', (e) => {
      e.preventDefault();
      beginRenamePane(index);
    });

    const swatch = document.createElement('span');
    swatch.className = 'tab-swatch';
    if (st.currentMode === 'nav') {
      swatch.textContent = String(index + 1);
      swatch.style.setProperty('--swatch-text-color', 'var(--tab-text-color)');
    }

    let labelOrInput;
    if (st.renamingPaneId === pane.id) {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'tab-input';
      input.value = pane.title ?? pane.terminalTitle ?? '';
      input.setAttribute('aria-label', `Rename tab ${pane.id}`);
      input.addEventListener('click', (e) => e.stopPropagation());
      input.addEventListener('mousedown', (e) => e.stopPropagation());
      let escapePressed = false;
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        else if (e.key === 'Escape') {
          e.preventDefault(); e.stopPropagation();
          escapePressed = true;
          input.blur();
        }
      });
      input.addEventListener('blur', () => {
        if (escapePressed) { escapePressed = false; cancelRenamePane(); }
        else { commitRenamePane(pane.id, input.value); }
      });
      queueMicrotask(() => { input.focus(); input.select(); });
      labelOrInput = input;
    } else {
      const label = document.createElement('span');
      label.className = 'tab-label';
      label.textContent = getPaneLabel(pane) || pane.id;
      labelOrInput = label;
    }

    const tabClose = document.createElement('button');
    tabClose.type = 'button';
    tabClose.className = 'tab-close';
    tabClose.setAttribute('aria-label', 'Close tab');
    if (st.pendingClosePaneId === pane.id) {
      tabClose.classList.add('pending-close');
      tabClose.textContent = '?';
    } else {
      tabClose.textContent = '×';
    }
    tabClose.addEventListener('click', (e) => {
      e.stopPropagation();
      handleMenuAction('tab-close', pane.id);
    });

    tabMain.append(swatch, labelOrInput);
    tab.append(tabMain, tabClose);
    return tab;
  }

  let _tabsLastSig = '';
  let _tabsLastFocused = -1;

  function renderTabs() {
    if (st.isRenderingTabs) return;
    const focusedIndex = getFocusedIndex();
    const sig = getTabsSig();

    if (!st.dragState && sig === _tabsLastSig) {
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

    st.isRenderingTabs = true;
    _tabsLastSig = sig;
    _tabsLastFocused = focusedIndex;
    const draggedPaneId = st.dragState?.paneId ?? null;
    let slot = 0;
    tabsListEl.replaceChildren(
      ...st.panes.map((pane, index) => {
        const isDragging = pane.id === draggedPaneId && st.dragState?.hasMoved;
        const insertBefore = !isDragging && st.dragState?.hasMoved && st.dragState.dropIndex === slot;
        const dragMeta = { isDragging, insertBefore, offsetX: isDragging ? st.dragState.currentX - st.dragState.startX : 0 };
        if (!isDragging) slot += 1;
        return createTab(pane, index, focusedIndex, dragMeta);
      })
    );
    st.isRenderingTabs = false;
  }

  // ── Panel style ─────────────────────────────────────────────────────────────

  function applyPanelStyle(node, accentColor, x, y, w, h, zIndex, isFocused, hasSplits, isActiveTab = false) {
    node.root.classList.toggle('is-active-tab', isActiveTab);
    node.root.classList.toggle('is-focused', isFocused);
    node.root.classList.toggle('is-navigation-target', isFocused && st.currentMode === 'nav');
    node.root.classList.toggle('has-splits', hasSplits);
    node.root.style.setProperty('--pane-accent', accentColor);
    if (hasSplits) {
      node.root.style.left = `${x}px`;
      node.root.style.top  = `${y}px`;
      node.root.style.transform = '';
    } else {
      node.root.style.willChange = 'transform';
      node.root.style.left = '0';
      node.root.style.top  = '0';
      node.root.style.transform = `translateX(${x}px)`;
    }
    node.root.style.width  = `${w}px`;
    node.root.style.height = `${h}px`;
    node.root.style.zIndex = String(zIndex);
    node.root.style.display = '';
    if (node.accent !== accentColor) {
      node.terminal.options.theme = createTerminalTheme(accentColor);
      node.accent = accentColor;
    }
  }

  // ── Split dividers ──────────────────────────────────────────────────────────

  function renderSplitDividers(focusedPane, tabX, tabW, stageHeight) {
    const layout = focusedPane?.layout;
    for (const el of splitDividerElMap.values()) el.style.display = 'none';
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
      el.style.left = `${div.x}px`; el.style.top = `${div.y}px`;
      el.style.width = `${div.w}px`; el.style.height = `${div.h}px`;
      el.style.display = '';
      el.dataset.direction = div.direction;
      splitDividerDataMap.set(el, { splitNode: div.node, direction: div.direction, usableSize: div.usableSize });
    }
    for (const [splitNode, el] of splitDividerElMap.entries()) {
      if (!activeNodes.has(splitNode)) { el.remove(); splitDividerElMap.delete(splitNode); }
    }
  }

  // ── Main pane render ────────────────────────────────────────────────────────

  function renderPanes(refit = false) {
    ensurePaneNodes();

    const stageWidth  = stageEl.clientWidth;
    const stageHeight = stageEl.clientHeight;
    const previewWidth = getPreviewWidth(stageWidth, st.panes.length, settings.paneWidth);
    const focusedIndex = getFocusedIndex();
    const focusedPane  = st.panes[focusedIndex];

    const activePanelId = focusedPane?.focusedPanelId ?? focusedPane?.id ?? st.focusedPaneId;
    paneActivityWatcher.setFocus(activePanelId);

    const visiblePanelIds = new Set();
    const focusedTabX = st.panes.length === 1 ? 0 : getPaneLeft(focusedIndex, previewWidth, focusedIndex, settings.paneWidth);
    const focusedTabW = st.panes.length === 1 ? stageWidth : settings.paneWidth;

    st.panes.forEach((pane, index) => {
      const isFocusedTab = index === focusedIndex;
      const accentColor = pane.customColor || pane.accent;

      if (isFocusedTab && pane.layout) {
        computeLayout(pane.layout, focusedTabX, 0, focusedTabW, stageHeight, (leafNode, x, y, w, h) => {
          const node = paneNodeMap.get(leafNode.panelId);
          if (!node) return;
          const isPanelFocused = leafNode.panelId === pane.focusedPanelId;
          node.root.style.clipPath = '';
          applyPanelStyle(node, accentColor, x, y, w, h, st.panes.length + 10, isPanelFocused, true, true);
          if (refit || node.needsFit) fitTerminal(node, true);
          visiblePanelIds.add(leafNode.panelId);
        });
      } else {
        const displayPanelId = pane.focusedPanelId ?? pane.id;
        const node = paneNodeMap.get(displayPanelId);
        if (node) {
          const left = getPaneLeft(index, previewWidth, focusedIndex, settings.paneWidth);
          const w = st.panes.length === 1 ? stageWidth : settings.paneWidth;
          const clipInset = (!isFocusedTab && st.panes.length > 1 && previewWidth < settings.paneWidth)
            ? `inset(0 ${settings.paneWidth - previewWidth}px 0 0)` : '';
          node.root.style.clipPath = clipInset;
          applyPanelStyle(node, accentColor, left, 0, w, stageHeight, index + 1, isFocusedTab, false, isFocusedTab);
          if (refit || node.needsFit) fitTerminal(node, true);
          visiblePanelIds.add(displayPanelId);
        }
      }
    });

    for (const [panelId, node] of paneNodeMap.entries()) {
      if (!visiblePanelIds.has(panelId)) node.root.style.display = 'none';
    }

    const dividerCount = st.panes.length - 1;
    dividerEls.forEach((el, i) => {
      if (i >= dividerCount) { el.style.display = 'none'; return; }
      const divX = getPaneLeft(i + 1, previewWidth, focusedIndex, settings.paneWidth);
      el.dataset.dividerIndex = String(i + 1);
      el.style.display = 'block';
      el.style.left    = `${divX}px`;
    });

    renderSplitDividers(focusedPane, focusedTabX, focusedTabW, stageHeight);

    if (focusedPane?.layout) {
      for (const panelId of collectPanelIds(focusedPane.layout)) {
        const node = paneNodeMap.get(panelId);
        if (!node?.titleEl) continue;
        const cwd = activeCwdMap.get(panelId) ?? panelDataMap.get(panelId)?.cwd ?? '';
        node.titleEl.textContent = abbreviatePath(cwd) || '~';
      }
    }
  }

  function render(refit = false) {
    renderTabs();
    renderPanes(refit);
    updateStatus();
    if (st.sessionRestoreComplete) scheduleSettingsSave();
  }

  // ── Tab-width divider drag ────────────────────────────────────────────────

  let dividerDrag = null;
  dividerEls.forEach((el) => {
    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      const dividerIndex = parseInt(el.dataset.dividerIndex, 10);
      const focusedIdx   = getFocusedIndex();
      const stageWidth   = stageEl.clientWidth;
      const previewWidth = getPreviewWidth(stageWidth, st.panes.length, settings.paneWidth);
      const initialDivX  = getPaneLeft(dividerIndex, previewWidth, focusedIdx, settings.paneWidth);
      dividerDrag = { el, startX: e.clientX, initialPaneWidth: settings.paneWidth, dividerIndex, focusedIndex: focusedIdx, paneCount: st.panes.length, stageWidth, initialDividerX: initialDivX, isLeftOfFocused: dividerIndex <= focusedIdx };
      el.classList.add('is-dragging');
      document.body.style.cursor = 'col-resize';
      document.addEventListener('mousemove', onDividerMouseMove);
      document.addEventListener('mouseup', onDividerMouseUp);
    });
  });

  const onDividerMouseMove = rafThrottle((e) => {
    if (!dividerDrag) return;
    const { startX, initialDividerX, focusedIndex: fi, paneCount, stageWidth, isLeftOfFocused, initialPaneWidth } = dividerDrag;
    const dx = e.clientX - startX;
    let newPaneWidth;
    if (isLeftOfFocused && fi > 0) {
      const newX = Math.max(10, initialDividerX + dx);
      newPaneWidth = stageWidth - (newX / fi) * (paneCount - 1);
    } else {
      newPaneWidth = initialPaneWidth + dx;
    }
    newPaneWidth = Math.max(520, Math.min(2000, Math.round(newPaneWidth)));
    if (newPaneWidth !== settings.paneWidth) {
      settings.paneWidth = newPaneWidth;
      applySettings();
      renderPanes(true);
    }
  });
  function onDividerMouseUp() {
    document.removeEventListener('mousemove', onDividerMouseMove);
    document.removeEventListener('mouseup', onDividerMouseUp);
    if (!dividerDrag) return;
    onDividerMouseMove.cancel();
    dividerDrag.el.classList.remove('is-dragging');
    document.body.style.cursor = '';
    dividerDrag = null;
    renderPanes(true);
    scheduleSettingsSave();
  }

  // ── Split divider drag ─────────────────────────────────────────────────────

  let _pendingRatioNode = null;
  let splitDividerDrag = null;

  stageEl.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const el = e.target.closest('.pane-split-divider');
    if (!el) return;
    const divData = splitDividerDataMap.get(el);
    if (!divData) return;
    e.preventDefault(); e.stopPropagation();
    splitDividerDrag = { el, splitNode: divData.splitNode, direction: divData.direction, startPos: divData.direction === 'v' ? e.clientX : e.clientY, initialRatio: divData.splitNode.ratio, usableSize: divData.usableSize };
    el.classList.add('is-dragging');
    document.body.style.cursor = divData.direction === 'v' ? 'col-resize' : 'row-resize';
    document.addEventListener('mousemove', onSplitDividerMouseMove);
    document.addEventListener('mouseup', onSplitDividerMouseUp);
  });

  const onSplitDividerMouseMove = rafThrottle((e) => {
    if (!splitDividerDrag) return;
    const { direction, startPos, initialRatio, usableSize, splitNode } = splitDividerDrag;
    const currentPos = direction === 'v' ? e.clientX : e.clientY;
    let newRatio = initialRatio + (currentPos - startPos) / usableSize;
    newRatio = Math.max(MIN_RATIO, Math.min(MAX_RATIO, newRatio));
    if (Math.abs(newRatio - splitNode.ratio) > 0.0005) {
      splitNode.ratio = newRatio;
      renderPanes(false);
    }
  });
  function onSplitDividerMouseUp() {
    document.removeEventListener('mousemove', onSplitDividerMouseMove);
    document.removeEventListener('mouseup', onSplitDividerMouseUp);
    if (!splitDividerDrag) return;
    onSplitDividerMouseMove.cancel();
    splitDividerDrag.el.classList.remove('is-dragging');
    document.body.style.cursor = '';
    splitDividerDrag = null;
    renderPanes(true);
    scheduleSettingsSave();
  }

  // Double-click split divider → ratio preset menu
  stageEl.addEventListener('dblclick', (e) => {
    const el = e.target.closest('.pane-split-divider');
    if (!el) return;
    const divData = splitDividerDataMap.get(el);
    if (!divData) return;
    e.preventDefault(); e.stopPropagation();
    _pendingRatioNode = divData.splitNode;
    const isV = divData.direction === 'v';
    const items = [
      { label: 'Equal (50/50)', action: 'split-ratio:0.5', shortcut: Math.abs(divData.splitNode.ratio - 0.5) < 0.02 ? '✓' : '' },
      { label: isV ? 'Left larger (67/33)' : 'Top larger (67/33)', action: 'split-ratio:0.67', shortcut: Math.abs(divData.splitNode.ratio - 0.67) < 0.02 ? '✓' : '' },
      { label: isV ? 'Right larger (33/67)' : 'Bottom larger (33/67)', action: 'split-ratio:0.33', shortcut: Math.abs(divData.splitNode.ratio - 0.33) < 0.02 ? '✓' : '' },
    ];
    // showContextMenu imported lazily to avoid circular dep
    import('./context-menu.js').then(({ showContextMenu }) => {
      showContextMenu(items, e.clientX, e.clientY,
        (action) => handleMenuAction(action, null),
        () => { _pendingRatioNode = null; },
      );
    });
  });

  // ── Public API ──────────────────────────────────────────────────────────────
  return {
    render,
    renderTabs,
    renderPanes,
    updateStatus,
    applyPanelStyle,
    getPendingRatioNode: () => _pendingRatioNode,
    clearPendingRatioNode: () => { _pendingRatioNode = null; },
  };
}
