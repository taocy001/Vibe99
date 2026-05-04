/**
 * Keyboard Shortcuts UI Module
 *
 * Handles the user interface for keyboard shortcuts management,
 * including the modal dialog and recording functionality.
 */

import * as ShortcutsRegistry from './shortcuts-registry.js';

/**
 * Get human-readable names for shortcut actions
 */
function getShortcutActionName(actionId) {
  const names = {
    'new-tab': 'New Tab',
    'close-tab': 'Close Tab',
    'navigation-mode': 'Navigation Mode',
    'copy': 'Copy',
    'paste': 'Paste',
    'navigate-left': 'Navigate Left',
    'navigate-right': 'Navigate Right',
    'split-right': 'Split Right',
    'split-down': 'Split Down',
    'focus-panel-prev': 'Focus Left Panel',
    'focus-panel-next': 'Focus Right Panel',
    'font-size-increase': 'Increase Font Size',
    'font-size-decrease': 'Decrease Font Size',
    'font-size-reset': 'Reset Font Size',
    'search': 'Search',
    'nav-left': 'Focus Previous',
    'nav-right': 'Focus Next',
    'focus-first': 'Focus First',
    'focus-last': 'Focus Last',
    'jump-to': 'Jump to Pane',
    'new-pane': 'New Pane',
    'close-pane': 'Close Pane',
    'rename-pane': 'Rename Pane',
  };
  return names[actionId] || actionId;
}

/**
 * Get description for shortcut actions
 */
function getShortcutActionDescription(actionId) {
  const descriptions = {
    'new-tab': 'Create a new terminal pane',
    'close-tab': 'Close the current pane',
    'navigation-mode': 'Enter keyboard navigation mode',
    'copy': 'Copy selected text to clipboard',
    'paste': 'Paste clipboard content to terminal',
    'navigate-left': 'Switch to the pane on the left',
    'navigate-right': 'Switch to the pane on the right',
    'split-right': 'Split current pane to the right',
    'split-down': 'Split current pane downward',
    'focus-panel-prev': 'Focus the previous split panel',
    'focus-panel-next': 'Focus the next split panel',
    'font-size-increase': 'Increase terminal font size',
    'font-size-decrease': 'Decrease terminal font size',
    'font-size-reset': 'Reset terminal font size to default',
    'search': 'Toggle the terminal search bar',
    'nav-left': 'Focus previous pane (navigation mode)',
    'nav-right': 'Focus next pane (navigation mode)',
    'focus-first': 'Jump to first pane (navigation mode)',
    'focus-last': 'Jump to last pane (navigation mode)',
    'jump-to': 'Jump to pane 1-9 (navigation mode)',
    'new-pane': 'Create a new terminal pane (navigation mode)',
    'close-pane': 'Close current pane (navigation mode)',
    'rename-pane': 'Rename current pane (navigation mode)',
  };
  return descriptions[actionId] || '';
}

/**
 * Show a custom confirmation dialog. Returns a Promise that resolves to true/false.
 */
function showConfirmDialog(message) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'shortcut-recorder-overlay';
    overlay.style.zIndex = '10002';

    overlay.innerHTML = `
      <div class="shortcut-recorder-dialog" style="max-width: 360px;">
        <div class="shortcut-recorder-title">Confirm</div>
        <div style="margin: 16px 0; color: var(--text); font-size: 14px;">${message}</div>
        <div class="shortcut-recorder-actions">
          <button type="button" class="shortcut-recorder-btn" id="confirm-cancel">Cancel</button>
          <button type="button" class="shortcut-recorder-btn is-primary" id="confirm-ok">OK</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const okBtn = overlay.querySelector('#confirm-ok');
    const cancelBtn = overlay.querySelector('#confirm-cancel');

    const cleanup = (result) => {
      overlay.remove();
      resolve(result);
    };

    okBtn.addEventListener('click', () => cleanup(true));
    cancelBtn.addEventListener('click', () => cleanup(false));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cleanup(false);
    });

    okBtn.focus();
  });
}

/**
 * Render keyboard shortcuts UI directly into a container element (inline, no overlay).
 */
export function renderIntoContainer(container, bridge, scheduleSettingsSave) {
  container.innerHTML = `
    <div class="shortcuts-list" id="sp-shortcuts-list"></div>
    <div class="settings-modal-footer" style="padding:10px 14px;">
      <button type="button" class="settings-modal-btn" id="sp-shortcuts-reset">Reset to Defaults</button>
    </div>
  `;
  const listEl = container.querySelector('#sp-shortcuts-list');
  const resetBtn = container.querySelector('#sp-shortcuts-reset');

  function renderList() {
    listEl.replaceChildren();
    const shortcuts = ShortcutsRegistry.getKeyboardShortcuts();
    for (const [id, shortcut] of Object.entries(shortcuts)) {
      const item = document.createElement('div');
      item.className = 'shortcut-item';
      const info = document.createElement('div');
      info.className = 'shortcut-info';
      const name = document.createElement('div');
      name.className = 'shortcut-name';
      name.textContent = getShortcutActionName(id);
      if (shortcut.mode === 'nav') {
        const badge = document.createElement('span');
        badge.className = 'shortcut-mode-badge';
        badge.textContent = 'Nav';
        name.appendChild(badge);
      }
      const description = document.createElement('div');
      description.className = 'shortcut-description';
      description.textContent = getShortcutActionDescription(id);
      info.append(name, description);
      const binding = document.createElement('div');
      binding.className = 'shortcut-binding';
      const keys = document.createElement('div');
      keys.className = 'shortcut-keys';
      keys.textContent = ShortcutsRegistry.formatShortcut(shortcut);
      keys.addEventListener('click', () => startRecording(id));
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'shortcut-edit-btn';
      editBtn.textContent = '✎';
      editBtn.title = 'Change shortcut';
      editBtn.addEventListener('click', () => startRecording(id));
      binding.append(keys, editBtn);
      item.append(info, binding);
      listEl.appendChild(item);
    }
  }

  function startRecording(shortcutId) {
    // Reuse the same recording overlay as the full modal
    _startShortcutRecording(shortcutId, scheduleSettingsSave, () => renderList());
  }

  resetBtn.addEventListener('click', async () => {
    const confirmed = await showConfirmDialog('Reset all keyboard shortcuts to their default values?');
    if (confirmed) {
      ShortcutsRegistry.resetShortcutsToDefaults();
      scheduleSettingsSave();
      renderList();
    }
  });

  renderList();
}

function _startShortcutRecording(shortcutId, scheduleSettingsSave, onRecordComplete) {
  const shortcuts = ShortcutsRegistry.getKeyboardShortcuts();
  const shortcut = shortcuts[shortcutId];
  if (!shortcut) return;
  const recorderOverlay = document.createElement('div');
  recorderOverlay.className = 'shortcut-recorder-overlay';
  recorderOverlay.tabIndex = -1;
  recorderOverlay.innerHTML = `
    <div class="shortcut-recorder-dialog">
      <div class="shortcut-recorder-title">Record Shortcut</div>
      <div class="shortcut-recorder-hint">Press your new key combination for "${getShortcutActionName(shortcutId)}"</div>
      <div class="shortcut-recorder-keys" id="shortcut-recorder-keys">
        <div class="shortcut-recorder-key">Press keys...</div>
      </div>
      <div class="shortcut-recorder-actions">
        <button type="button" class="shortcut-recorder-btn" id="shortcut-recorder-cancel">Cancel</button>
        <button type="button" class="shortcut-recorder-btn is-primary" id="shortcut-recorder-save" disabled>Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(recorderOverlay);
  let recordedShortcut = null;
  const keysDisplay = recorderOverlay.querySelector('#shortcut-recorder-keys');
  const saveBtn = recorderOverlay.querySelector('#shortcut-recorder-save');
  const cancelBtn = recorderOverlay.querySelector('#shortcut-recorder-cancel');
  const close = () => {
    window.removeEventListener('keydown', keydownHandler, true);
    recorderOverlay.remove();
  };
  const keydownHandler = (event) => {
    event.preventDefault(); event.stopPropagation();
    if (event.key === 'Escape') { close(); return; }
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return;
    const parsed = ShortcutsRegistry.parseShortcutEvent(event);
    keysDisplay.innerHTML = '';
    for (const mod of [...parsed.modifiers, parsed.key]) {
      const el = document.createElement('div');
      el.className = 'shortcut-recorder-key';
      el.textContent = mod === 'ctrl' ? (navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl') :
                       mod === 'shift' ? (navigator.platform.toLowerCase().includes('mac') ? '⇧' : 'Shift') :
                       mod === 'alt' ? (navigator.platform.toLowerCase().includes('mac') ? '⌥' : 'Alt') :
                       mod === ' ' ? 'Space' : mod;
      keysDisplay.appendChild(el);
    }
    const newShortcut = { key: parsed.key, modifiers: parsed.modifiers };
    const conflictId = ShortcutsRegistry.findConflict(newShortcut, shortcutId);
    if (conflictId) {
      const w = document.createElement('div');
      w.className = 'shortcut-conflict-warning';
      w.textContent = `Conflicts with "${getShortcutActionName(conflictId)}"`;
      keysDisplay.appendChild(w);
      saveBtn.disabled = true;
    } else {
      saveBtn.disabled = false;
      recordedShortcut = newShortcut;
    }
  };
  window.addEventListener('keydown', keydownHandler, true);
  cancelBtn.addEventListener('click', close);
  saveBtn.addEventListener('click', () => {
    if (!recordedShortcut) return;
    ShortcutsRegistry.updateKeyboardShortcut(shortcutId, recordedShortcut);
    scheduleSettingsSave?.();
    onRecordComplete?.();
    close();
  });
  recorderOverlay.addEventListener('click', (e) => { if (e.target === recorderOverlay) close(); });
  recorderOverlay.style.outline = 'none';
  recorderOverlay.focus();
}

/**
 * Open the keyboard shortcuts modal dialog
 */
export function openKeyboardShortcutsModal(bridge, scheduleSettingsSave, onClose) {
  const overlay = document.createElement('div');
  overlay.className = 'settings-modal-overlay';

  overlay.innerHTML = `
    <div class="settings-modal" style="min-width: 420px;">
      <div class="settings-modal-header">
        <span>Keyboard Shortcuts</span>
        <button type="button" class="settings-modal-close" aria-label="Close">×</button>
      </div>
      <div class="settings-modal-body" style="max-height: 450px; overflow-y: auto;">
        <div class="shortcuts-list" id="modal-shortcuts-list"></div>
      </div>
      <div class="settings-modal-footer">
        <button type="button" class="settings-modal-btn" id="modal-shortcuts-reset">Reset to Defaults</button>
        <button type="button" class="settings-modal-btn primary close-btn">Done</button>
      </div>
    </div>
  `;

  const closeModal = () => {
    overlay.remove();
    onClose?.();
  };

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });

  overlay.querySelector('.settings-modal-close').addEventListener('click', closeModal);
  overlay.querySelector('.close-btn').addEventListener('click', closeModal);

  // Reset shortcuts button
  overlay.querySelector('#modal-shortcuts-reset').addEventListener('click', async () => {
    const confirmed = await showConfirmDialog('Reset all keyboard shortcuts to their default values?');
    if (confirmed) {
      ShortcutsRegistry.resetShortcutsToDefaults();
      scheduleSettingsSave();
      renderModalShortcuts();
    }
  });

  document.body.appendChild(overlay);

  // Store reference to modal list for rendering
  overlay._modalShortcutsList = overlay.querySelector('#modal-shortcuts-list');

  renderModalShortcuts();

  /**
   * Render the shortcuts list in the modal
   */
  function renderModalShortcuts() {
    const listEl = overlay._modalShortcutsList;
    if (!listEl) return;

    listEl.replaceChildren();

    const shortcuts = ShortcutsRegistry.getKeyboardShortcuts();

    for (const [id, shortcut] of Object.entries(shortcuts)) {
      const item = document.createElement('div');
      item.className = 'shortcut-item';

      const info = document.createElement('div');
      info.className = 'shortcut-info';

      const name = document.createElement('div');
      name.className = 'shortcut-name';
      name.textContent = getShortcutActionName(id);
      if (shortcut.mode === 'nav') {
        const badge = document.createElement('span');
        badge.className = 'shortcut-mode-badge';
        badge.textContent = 'Nav';
        name.appendChild(badge);
      }

      const description = document.createElement('div');
      description.className = 'shortcut-description';
      description.textContent = getShortcutActionDescription(id);

      info.append(name, description);

      const binding = document.createElement('div');
      binding.className = 'shortcut-binding';

      const keys = document.createElement('div');
      keys.className = 'shortcut-keys';
      keys.textContent = ShortcutsRegistry.formatShortcut(shortcut);
      keys.addEventListener('click', () => {
        startShortcutRecording(id, () => renderModalShortcuts());
      });

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'shortcut-edit-btn';
      editBtn.textContent = '✎';
      editBtn.title = 'Change shortcut';
      editBtn.addEventListener('click', () => {
        startShortcutRecording(id, () => renderModalShortcuts());
      });

      binding.append(keys, editBtn);
      item.append(info, binding);
      listEl.appendChild(item);
    }
  }

  function startShortcutRecording(shortcutId, onRecordComplete) {
    _startShortcutRecording(shortcutId, scheduleSettingsSave, onRecordComplete);
  }
}
