// Pane and tab lifecycle management extracted from renderer.js.
// All functions close over `st` (shared mutable state) — mutations are
// immediately visible to the caller because both sides hold a reference to
// the same object.

import * as ColorsRegistry from './colors-registry.js';
import {
  split as _layoutSplit,
  replaceLeaf,
  removeLeaf,
  collectPanelIds,
} from './split-layout.js';

// ---------------------------------------------------------------------------
// Pure layout helpers (no state)
// ---------------------------------------------------------------------------

export function getTabLayout(pane) {
  return pane.layout ?? { type: 'leaf', panelId: pane.focusedPanelId ?? pane.id };
}

export function getPreviewWidth(stageWidth, count, paneWidth) {
  if (count <= 1) return 0;
  if (stageWidth >= paneWidth * count) return paneWidth;
  return (stageWidth - paneWidth) / (count - 1);
}

export function getPaneLeft(index, previewWidth, focusedIndex, paneWidth) {
  if (previewWidth >= paneWidth) return index * paneWidth;
  const focusedLeft = focusedIndex * previewWidth;
  if (index < focusedIndex) return index * previewWidth;
  if (index === focusedIndex) return focusedLeft;
  return focusedLeft + paneWidth + (index - focusedIndex - 1) * previewWidth;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * createPaneManager(st, { bridge, settings, paneNodeMap, panelDataMap,
 *   activeCwdMap, tabsListEl, onRender, onDestroyPanel,
 *   onInitializePaneTerminal, reportError })
 *
 * Returns the full public pane management API.  Callers should destructure
 * the returned object so each function is directly callable by name.
 */
export function createPaneManager(st, {
  bridge,
  settings,
  paneNodeMap,
  panelDataMap,
  activeCwdMap,
  tabsListEl,
  onRender,
  onDestroyPanel,
  onInitializePaneTerminal,
  reportError,
}) {

  // ── State helpers ──────────────────────────────────────────────────────────

  function getFocusedIndex() {
    const idx = st.panes.findIndex((p) => p.id === st.focusedPaneId);
    if (idx !== -1) return idx;
    st.focusedPaneId = st.panes[0]?.id ?? null;
    return st.panes.length > 0 ? 0 : -1;
  }

  function getPaneIndex(paneId) {
    return st.panes.findIndex((p) => p.id === paneId);
  }

  function getOwningTabId(panelId) {
    const direct = st.panes.find((p) => p.id === panelId);
    if (direct) return panelId;
    const owner = st.panes.find((p) => collectPanelIds(getTabLayout(p)).includes(panelId));
    return owner?.id ?? null;
  }

  function getPaneNode(paneId) {
    return paneNodeMap.get(paneId) ?? null;
  }

  function getPaneLabel(pane) {
    return pane?.title ?? pane?.terminalTitle ?? '';
  }

  function getTabsSig() {
    const d = st.dragState;
    return st.panes.map((p) =>
      `${p.id}:${p.title || ''}:${p.terminalTitle || ''}:${p.accent}:${p.customColor || ''}` +
      `:${st.pendingClosePaneId === p.id ? 'P' : ''}:${st.renamingPaneId === p.id ? 'R' : ''}`
    ).join('|') + `|${st.currentMode}|${d ? d.paneId + ':' + (d.dropIndex ?? -1) : ''}`;
  }

  // ── Mode ────────────────────────────��───────────────────────────────���──────

  function setMode(next) {
    if (st.currentMode === next) return;
    st.currentMode = next;
    document.body.classList.toggle('is-navigation-mode', st.currentMode === 'nav');
    onRender();
  }

  // ── MRU stack ───────────────────────��────────────────────────────────��─────

  function recordPaneVisit(paneId) {
    if (!paneId || st.paneMruOrder[0] === paneId) return;
    st.paneMruOrder = [paneId, ...st.paneMruOrder.filter((id) => id !== paneId)];
  }

  function syncPaneMruOrder() {
    const known = new Set(st.panes.map((p) => p.id));
    st.paneMruOrder = st.paneMruOrder.filter((id) => known.has(id));
    for (const pane of st.panes) {
      if (!st.paneMruOrder.includes(pane.id)) st.paneMruOrder.push(pane.id);
    }
  }

  // ── Focus ─────────────────────────���────────────────────────────────────────

  function focusPane(paneId, options = {}) {
    const { focusTerminal = true } = options;
    st.paneCycleState = null;
    st.focusedPaneId = paneId;
    setMode('terminal');
    recordPaneVisit(paneId);
    onRender();
    if (focusTerminal) {
      requestAnimationFrame(() => { paneNodeMap.get(paneId)?.terminal.focus(); });
    }
  }

  function focusSplitPanel(panelId, { focusTerminal = true } = {}) {
    const pane = st.panes.find((p) => collectPanelIds(getTabLayout(p)).includes(panelId));
    if (!pane) return;
    if (pane.id !== st.focusedPaneId) {
      st.paneCycleState = null;
      st.focusedPaneId = pane.id;
      recordPaneVisit(pane.id);
    }
    st.panes = st.panes.map((p) => p.id === pane.id ? { ...p, focusedPanelId: panelId } : p);
    setMode('terminal');
    onRender();
    if (focusTerminal) {
      requestAnimationFrame(() => { paneNodeMap.get(panelId)?.terminal.focus(); });
    }
  }

  // ── Pane data factory ────────────────────────────��─────────────────────────

  function createPaneData() {
    const usedAccents = new Set(st.panes.map((p) => p.accent.toLowerCase()));
    const accent = ColorsRegistry.ACCENT_PALETTE.find((c) => !usedAccents.has(c.toLowerCase()))
      || ColorsRegistry.ACCENT_PALETTE[(st.nextPaneNumber - 1) % ColorsRegistry.ACCENT_PALETTE.length];
    const id = `${st.panePrefix ?? ''}p${st.nextPaneNumber}`;
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
    st.nextPaneNumber += 1;
    return pane;
  }

  // ── Pane lifecycle ─────────────────────────────────────────────────────────

  function addPane() {
    const newPane = createPaneData();
    st.paneCycleState = null;
    st.panes = [...st.panes, newPane];
    st.focusedPaneId = newPane.id;
    recordPaneVisit(newPane.id);
    onRender(true);
    requestAnimationFrame(() => { paneNodeMap.get(newPane.id)?.terminal.focus(); });
  }

  function closePane(index, options = {}) {
    const { destroyTerminal = true } = options;
    const closingPane = st.panes[index];
    if (!closingPane) return;
    if (st.panes.length === 1) { void bridge.exitApp().catch(reportError); return; }
    if (closingPane.id === st.renamingPaneId) st.renamingPaneId = null;
    if (closingPane.id === st.dragState?.paneId) endTabDrag();
    if (closingPane.id === st.pendingTabFocus?.paneId) clearPendingTabFocus();
    for (const panelId of collectPanelIds(getTabLayout(closingPane))) {
      const node = paneNodeMap.get(panelId);
      if (node) onDestroyPanel(panelId, node, { destroyTerminal });
    }
    const remainingPanes = st.panes.filter((_, i) => i !== index);
    if (closingPane.id === st.focusedPaneId) {
      const fallbackIndex = Math.max(0, index - 1);
      st.focusedPaneId = remainingPanes[fallbackIndex]?.id ?? remainingPanes[0]?.id ?? null;
    }
    st.panes = remainingPanes;
    st.paneCycleState = null;
    st.paneMruOrder = st.paneMruOrder.filter((id) => id !== closingPane.id);
    recordPaneVisit(st.focusedPaneId);
    onRender(true);
    requestAnimationFrame(() => { paneNodeMap.get(st.focusedPaneId)?.terminal.focus(); });
  }

  // ── Split panels ───────────────────────────────────────────────────────────

  function splitPanel(direction) {
    const focusedPane = st.panes[getFocusedIndex()];
    if (!focusedPane) return;
    const newPanelId = `panel-${st.nextPanelSeq++}`;
    const currentPanelId = focusedPane.focusedPanelId ?? focusedPane.id;
    const currentNode = paneNodeMap.get(currentPanelId);
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
    const currentLayout = getTabLayout(focusedPane);
    const newSplit = _layoutSplit(
      direction, 0.5,
      { type: 'leaf', panelId: currentPanelId },
      { type: 'leaf', panelId: newPanelId },
    );
    const newLayout = replaceLeaf(currentLayout, currentPanelId, newSplit);
    st.panes = st.panes.map((p) =>
      p.id === focusedPane.id ? { ...p, layout: newLayout, focusedPanelId: newPanelId } : p
    );
    onRender(true);
    requestAnimationFrame(() => { paneNodeMap.get(newPanelId)?.terminal.focus(); });
  }

  function closeActivePanel() {
    const focusedPane = st.panes[getFocusedIndex()];
    if (!focusedPane) return;
    if (!focusedPane.layout) { closePane(getFocusedIndex()); return; }
    const panelId = focusedPane.focusedPanelId ?? focusedPane.id;
    const newLayout = removeLeaf(focusedPane.layout, panelId);
    const node = paneNodeMap.get(panelId);
    if (node) {
      onDestroyPanel(panelId, node);
    } else {
      panelDataMap.delete(panelId);
      activeCwdMap.delete(panelId);
    }
    let newFocusId;
    let finalLayout;
    if (!newLayout) { closePane(getFocusedIndex()); return; }
    else if (newLayout.type === 'leaf') {
      newFocusId = newLayout.panelId;
      finalLayout = null;
    } else {
      finalLayout = newLayout;
      const ids = collectPanelIds(newLayout);
      newFocusId = ids[0] ?? focusedPane.id;
    }
    st.panes = st.panes.map((p) =>
      p.id === focusedPane.id ? { ...p, layout: finalLayout, focusedPanelId: newFocusId } : p
    );
    onRender(true);
    requestAnimationFrame(() => { paneNodeMap.get(newFocusId)?.terminal.focus(); });
  }

  function focusPanelDelta(delta) {
    const focusedPane = st.panes[getFocusedIndex()];
    if (!focusedPane || !focusedPane.layout) return;
    const ids = collectPanelIds(getTabLayout(focusedPane));
    if (ids.length < 2) return;
    const currentIdx = ids.indexOf(focusedPane.focusedPanelId ?? focusedPane.id);
    const nextIdx = (currentIdx + delta + ids.length) % ids.length;
    focusSplitPanel(ids[nextIdx]);
  }

  // ── Panel drag-to-rearrange ─────────────────────────────��──────────────────

  let panelDragState = null;

  function getPanelDropZone(panelEl, mouseX, mouseY) {
    const rect = panelEl.getBoundingClientRect();
    const rx = mouseX - rect.left, ry = mouseY - rect.top;
    const edge = 0.25;
    if (rx < rect.width * edge)        return 'left';
    if (rx > rect.width * (1 - edge))  return 'right';
    if (ry < rect.height * edge)       return 'top';
    if (ry > rect.height * (1 - edge)) return 'bottom';
    return 'center';
  }

  function getHoveredPanelInfo(mouseX, mouseY, excludeId) {
    const focusedPane = st.panes[getFocusedIndex()];
    if (!focusedPane?.layout) return null;
    const panelIds = new Set(collectPanelIds(focusedPane.layout));
    for (const [panelId, node] of paneNodeMap.entries()) {
      if (panelId === excludeId || !panelIds.has(panelId)) continue;
      const rect = node.root.getBoundingClientRect();
      if (mouseX >= rect.left && mouseX <= rect.right && mouseY >= rect.top && mouseY <= rect.bottom) {
        return { panelId, node, zone: getPanelDropZone(node.root, mouseX, mouseY) };
      }
    }
    return null;
  }

  function commitPanelDrop(sourcePanelId, targetPanelId, zone) {
    if (zone === 'center' || sourcePanelId === targetPanelId) return;
    const focusedPane = st.panes[getFocusedIndex()];
    if (!focusedPane?.layout) return;
    const direction = (zone === 'left' || zone === 'right') ? 'v' : 'h';
    const sourceFirst = (zone === 'left' || zone === 'top');
    const layoutAfterRemove = removeLeaf(focusedPane.layout, sourcePanelId);
    if (!layoutAfterRemove) return;
    const baseLayout = layoutAfterRemove.type === 'leaf' ? null : layoutAfterRemove;
    const effectiveBase = baseLayout ?? { type: 'leaf', panelId: layoutAfterRemove.panelId ?? targetPanelId };
    const sourceLeaf = { type: 'leaf', panelId: sourcePanelId };
    const newSplit = _layoutSplit(
      direction, 0.5,
      sourceFirst ? sourceLeaf : { type: 'leaf', panelId: targetPanelId },
      sourceFirst ? { type: 'leaf', panelId: targetPanelId } : sourceLeaf,
    );
    const newLayout = replaceLeaf(effectiveBase, targetPanelId, newSplit);
    st.panes = st.panes.map((p) =>
      p.id === focusedPane.id ? { ...p, layout: newLayout, focusedPanelId: sourcePanelId } : p
    );
    onRender(true);
    requestAnimationFrame(() => { paneNodeMap.get(sourcePanelId)?.terminal.focus(); });
  }

  function rafThrottle(fn) {
    let raf = null, latest = null;
    function throttled(e) {
      latest = e;
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = null; fn(latest); });
    }
    throttled.cancel = () => { if (raf !== null) { cancelAnimationFrame(raf); raf = null; } };
    return throttled;
  }

  const onPanelDragMouseMove = rafThrottle((e) => {
    if (!panelDragState) return;
    const { sourcePanelId, startX, startY } = panelDragState;
    if (!panelDragState.active) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < 6) return;
      panelDragState.active = true;
      const ghost = document.createElement('div');
      ghost.className = 'panel-drag-ghost';
      document.body.appendChild(ghost);
      panelDragState.ghost = ghost;
      const overlay = document.createElement('div');
      overlay.className = 'panel-drop-overlay';
      document.body.appendChild(overlay);
      panelDragState.dropOverlay = overlay;
    }
    if (panelDragState.ghost) {
      panelDragState.ghost.style.left = `${e.clientX + 12}px`;
      panelDragState.ghost.style.top  = `${e.clientY + 12}px`;
    }
    const hovered = getHoveredPanelInfo(e.clientX, e.clientY, sourcePanelId);
    if (hovered && hovered.zone !== 'center') {
      panelDragState.currentTargetId = hovered.panelId;
      panelDragState.currentZone = hovered.zone;
      const rect = hovered.node.root.getBoundingClientRect();
      const ov = panelDragState.dropOverlay;
      ov.style.left = `${rect.left}px`; ov.style.top = `${rect.top}px`;
      ov.style.width = `${rect.width}px`; ov.style.height = `${rect.height}px`;
      ov.style.display = ''; ov.dataset.zone = hovered.zone;
    } else {
      panelDragState.currentTargetId = null;
      panelDragState.currentZone = null;
      if (panelDragState.dropOverlay) panelDragState.dropOverlay.style.display = 'none';
    }
  });
  document.addEventListener('mousemove', onPanelDragMouseMove);

  document.addEventListener('mouseup', () => {
    if (!panelDragState) return;
    onPanelDragMouseMove.cancel();
    const { sourcePanelId, active, currentTargetId, currentZone, ghost, dropOverlay } = panelDragState;
    ghost?.remove(); dropOverlay?.remove();
    panelDragState = null;
    if (active && currentTargetId && currentZone) {
      commitPanelDrop(sourcePanelId, currentTargetId, currentZone);
    } else if (!active) {
      focusSplitPanel(sourcePanelId);
    }
  });

  // Wires into stageEl — called from layout-renderer which owns stageEl
  function attachPanelDragToStage(stageEl) {
    stageEl.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const handle = e.target.closest('.panel-title');
      if (!handle) return;
      const sourcePanelId = handle.dataset.panelId;
      if (!sourcePanelId) return;
      e.preventDefault();
      e.stopPropagation();
      panelDragState = { sourcePanelId, startX: e.clientX, startY: e.clientY, ghost: null, dropOverlay: null, active: false, currentZone: null, currentTargetId: null };
    }, true);
  }

  // ── Tab rename ─────────────────────────���──────────────────────────────��────

  function clearPendingTabFocus() {
    if (!st.pendingTabFocus) return;
    window.clearTimeout(st.pendingTabFocus.timerId);
    st.pendingTabFocus = null;
  }

  function scheduleTabFocus(paneId) {
    clearPendingTabFocus();
    st.pendingTabFocus = {
      paneId,
      timerId: window.setTimeout(() => { st.pendingTabFocus = null; focusPane(paneId); }, 180),
    };
  }

  function beginRenamePane(index) {
    const pane = st.panes[index];
    if (!pane) return;
    clearPendingTabFocus();
    st.renamingPaneId = pane.id;
    try { onRender(); } catch (error) { st.renamingPaneId = null; reportError(error); }
  }

  function cancelRenamePane() {
    st.renamingPaneId = null;
    try { onRender(); } catch (error) { reportError(error); }
  }

  function commitRenamePane(paneId, nextTitle) {
    const trimmedTitle = nextTitle.trim();
    st.renamingPaneId = null;
    st.panes = st.panes.map((entry) =>
      entry.id === paneId ? { ...entry, title: trimmedTitle || null } : entry
    );
    focusPane(paneId, { focusTerminal: true });
  }

  function activateTabPointerUp(paneId) {
    if (st.pendingTabFocus?.paneId === paneId) {
      clearPendingTabFocus();
      const paneIndex = st.panes.findIndex((p) => p.id === paneId);
      if (paneIndex !== -1) beginRenamePane(paneIndex);
      return;
    }
    scheduleTabFocus(paneId);
  }

  // ── Tab drag ────────────────────────────���──────────────────────────────────

  function endTabDrag() {
    st.dragState = null;
    document.body.classList.remove('is-dragging-tabs');
    window.removeEventListener('pointermove', handleTabPointerMove);
    window.removeEventListener('pointerup',   handleTabPointerUp);
    window.removeEventListener('pointercancel', handleTabPointerUp);
  }

  function getTabDropIndex(clientX) {
    const tabElements = [...tabsListEl.querySelectorAll('.tab')].filter(
      (tab) => tab.dataset.paneId !== st.dragState?.paneId
    );
    let slot = 0;
    for (const tab of tabElements) {
      const rect = tab.getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) return slot;
      slot += 1;
    }
    return slot;
  }

  function handleTabPointerMove(event) {
    if (!st.dragState || event.pointerId !== st.dragState.pointerId) return;
    st.dragState.currentX = event.clientX;
    const offsetX = st.dragState.currentX - st.dragState.startX;
    if (Math.abs(offsetX) <= 4 && !st.dragState.hasMoved) return;
    st.dragState.hasMoved = true;
    st.dragState.dropIndex = getTabDropIndex(event.clientX);
    renderTabsInternal();
  }

  function handleTabPointerUp(event) {
    if (!st.dragState || event.pointerId !== st.dragState.pointerId) return;
    const { paneId, dropIndex, hasMoved } = st.dragState;
    endTabDrag();
    if (!hasMoved) { activateTabPointerUp(paneId); return; }
    const pane = st.panes.find((entry) => entry.id === paneId);
    const nextPanes = st.panes.filter((entry) => entry.id !== paneId);
    const insertionIndex = Math.max(0, Math.min(dropIndex, nextPanes.length));
    nextPanes.splice(insertionIndex, 0, pane);
    st.panes = nextPanes;
    onRender();
  }

  function beginTabDrag(index, event) {
    if (event.button !== 0 || st.renamingPaneId !== null) return;
    const pane = st.panes[index];
    if (!pane) return;
    event.preventDefault();
    st.dragState = {
      paneId: pane.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      currentX: event.clientX,
      dropIndex: index,
      hasMoved: false,
    };
    document.body.classList.add('is-dragging-tabs');
    window.addEventListener('pointermove', handleTabPointerMove);
    window.addEventListener('pointerup',   handleTabPointerUp);
    window.addEventListener('pointercancel', handleTabPointerUp);
  }

  // Internal renderTabs caller — provided by layout-renderer after init
  let renderTabsInternal = () => {};
  function setRenderTabsCallback(fn) { renderTabsInternal = fn; }

  // ── Navigation cycling ───────────────────────────���─────────────────────────

  function cycleToRecentPane({ reverse = false } = {}) {
    if (st.panes.length < 2) return;
    syncPaneMruOrder();
    if (!st.paneCycleState) {
      st.paneCycleState = { snapshot: [...st.paneMruOrder], index: 0 };
    }
    const { snapshot } = st.paneCycleState;
    if (snapshot.length < 2) return;
    const step = reverse ? -1 : 1;
    st.paneCycleState.index = (st.paneCycleState.index + step + snapshot.length) % snapshot.length;
    const targetId = snapshot[st.paneCycleState.index];
    if (!st.panes.some((p) => p.id === targetId)) { st.paneCycleState = null; return; }
    st.focusedPaneId = targetId;
    setMode('terminal');
    onRender();
    requestAnimationFrame(() => { paneNodeMap.get(targetId)?.terminal.focus(); });
  }

  function commitPaneCycle() {
    if (!st.paneCycleState) return;
    st.paneCycleState = null;
    recordPaneVisit(st.focusedPaneId);
  }

  // ── Tab navigation ─────────────────────���───────────────────────────────────

  function moveFocus(delta) {
    if (st.panes.length === 0) return;
    const idx = getFocusedIndex();
    const nextIdx = (idx + delta + st.panes.length) % st.panes.length;
    st.focusedPaneId = st.panes[nextIdx].id;
    onRender();
  }

  function navigateLeft() {
    if (st.panes.length === 0) return;
    const idx = getFocusedIndex() - 1;
    if (idx >= 0) focusPane(st.panes[idx].id);
  }

  function navigateRight() {
    if (st.panes.length === 0) return;
    const idx = getFocusedIndex() + 1;
    if (idx < st.panes.length) focusPane(st.panes[idx].id);
  }

  // ── Navigation mode ──────────────────────────��─────────────────────────────

  function blurFocusedTerminal() {
    paneNodeMap.get(st.focusedPaneId)?.terminal.blur();
  }

  function enterNavigationMode() {
    if (st.panes.length === 0) return;
    st.enterNavSourcePaneId = st.focusedPaneId;
    setMode('nav');
    blurFocusedTerminal();
    onRender();
  }

  function cancelNavigationMode() {
    if (st.enterNavSourcePaneId) {
      focusPane(st.enterNavSourcePaneId, { focusTerminal: true });
      st.enterNavSourcePaneId = null;
    } else {
      setMode('terminal');
      onRender();
    }
  }

  function focusPaneAt(index) {
    if (st.panes.length === 0 || index < 0 || index >= st.panes.length) return;
    st.paneCycleState = null;
    st.focusedPaneId = st.panes[index].id;
    onRender();
  }

  function getPaneCount() { return st.panes.length; }
  function getPaneIdAt(index) {
    if (index < 0 || index >= st.panes.length) return null;
    return st.panes[index].id;
  }

  function requestClosePane(paneId) {
    if (st.pendingClosePaneId === paneId) {
      const index = st.panes.findIndex((p) => p.id === paneId);
      if (index !== -1) {
        st.pendingClosePaneId = null;
        closePane(index);
        if (st.currentMode === 'nav' && st.panes.length > 0) {
          focusPane(st.focusedPaneId, { focusTerminal: true });
        }
      }
    } else {
      st.pendingClosePaneId = paneId;
      onRender();
    }
  }

  function startInlineRename(paneId) {
    const index = st.panes.findIndex((p) => p.id === paneId);
    if (index !== -1) {
      if (st.currentMode === 'nav') setMode('terminal');
      beginRenamePane(index);
    }
  }

  // ── Public API ──────────────────��──────────────────────────────────────────
  return {
    getFocusedIndex,
    getPaneIndex,
    getOwningTabId,
    getPaneNode,
    getPaneLabel,
    getTabsSig,
    setMode,
    recordPaneVisit,
    syncPaneMruOrder,
    focusPane,
    focusSplitPanel,
    createPaneData,
    addPane,
    closePane,
    splitPanel,
    closeActivePanel,
    focusPanelDelta,
    commitPanelDrop,
    beginRenamePane,
    cancelRenamePane,
    commitRenamePane,
    activateTabPointerUp,
    beginTabDrag,
    endTabDrag,
    getTabDropIndex,
    cycleToRecentPane,
    commitPaneCycle,
    moveFocus,
    navigateLeft,
    navigateRight,
    enterNavigationMode,
    cancelNavigationMode,
    blurFocusedTerminal,
    focusPaneAt,
    getPaneCount,
    getPaneIdAt,
    requestClosePane,
    startInlineRename,
    setRenderTabsCallback,
    attachPanelDragToStage,
  };
}
