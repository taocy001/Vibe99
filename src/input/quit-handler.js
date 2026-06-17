/**
 * Cmd+Q handler — tap vs long-press.
 *
 * Tauri's native `PredefinedMenuItem::quit` is intentionally NOT used for the
 * Cmd+Q accelerator (the menu item carries no accelerator), so the keystroke
 * reaches the webview and we can distinguish:
 *   - a short tap  → close the active tab/panel (same as Cmd+W). When this is
 *                    the last panel of the last tab, closing it would quit the
 *                    app, so we confirm first instead.
 *   - a long press → confirm before quitting the whole application.
 */

import { t } from '../i18n.js';

const LONG_PRESS_MS = 600;

function isQuitChord(event) {
  return event.metaKey && !event.ctrlKey && !event.altKey
    && (event.key === 'q' || event.key === 'Q');
}

/**
 * Show the "quit application" confirmation. Returns a Promise<boolean>.
 * Reuses the shortcut-recorder dialog styling for visual consistency.
 */
function showQuitConfirm() {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'shortcut-recorder-overlay';
    overlay.style.zIndex = '10002';

    overlay.innerHTML = `
      <div class="shortcut-recorder-dialog" style="max-width: 360px;">
        <div class="shortcut-recorder-title">${t('shortcuts.confirm.title')}</div>
        <div style="margin: 16px 0; color: var(--text); font-size: 14px;">${t('quit.confirm.message')}</div>
        <div class="shortcut-recorder-actions">
          <button type="button" class="shortcut-recorder-btn" id="quit-cancel">${t('shortcuts.confirm.cancel')}</button>
          <button type="button" class="shortcut-recorder-btn is-primary" id="quit-ok">${t('shortcuts.confirm.ok')}</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const okBtn = overlay.querySelector('#quit-ok');
    const cancelBtn = overlay.querySelector('#quit-cancel');

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
 * Attach the Cmd+Q keydown/keyup handlers.
 *
 * @param {object} opts
 * @param {object} opts.bridge              Terminal bridge (needs exitApp).
 * @param {Function} opts.closeActiveTab    Close the active tab/panel (= Cmd+W).
 * @param {Function} opts.wouldQuitOnClose  Returns true when closing the active
 *                                          tab/panel would quit the whole app.
 * @param {Function} [opts.reportError]
 * @returns {{ triggerQuitConfirm: () => Promise<void> }}
 */
export function setupQuitHandler({ bridge, closeActiveTab, wouldQuitOnClose, reportError }) {
  let pressActive = false;
  let longTriggered = false;
  let dialogOpen = false;
  let longTimer = null;

  const triggerQuitConfirm = async () => {
    if (dialogOpen) return;
    dialogOpen = true;
    let confirmed = false;
    try {
      confirmed = await showQuitConfirm();
    } finally {
      dialogOpen = false;
    }
    if (confirmed) {
      try { await bridge.exitApp(); } catch (err) { reportError?.(err); }
    }
  };

  const onKeydown = (event) => {
    if (!isQuitChord(event)) return;
    // Cmd+Q is fully owned by us — never let it reach the terminal or default.
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat || dialogOpen || pressActive) return;
    pressActive = true;
    longTriggered = false;
    longTimer = setTimeout(() => {
      longTimer = null;
      longTriggered = true;
      pressActive = false;
      void triggerQuitConfirm(); // long press → confirm quit app
    }, LONG_PRESS_MS);
  };

  const onKeyup = (event) => {
    // The chord ends when either 'q' or the Cmd (Meta) key is released.
    if (event.key !== 'q' && event.key !== 'Q' && event.key !== 'Meta') return;
    if (longTriggered) { longTriggered = false; return; } // already handled as long press
    if (!pressActive) return;

    if (longTimer) { clearTimeout(longTimer); longTimer = null; }
    pressActive = false;
    if (dialogOpen) return;

    // Short tap: close the active tab/panel. If closing it would quit the app
    // (last panel of the last tab), confirm first instead.
    if (wouldQuitOnClose()) {
      void triggerQuitConfirm();
    } else {
      try { closeActiveTab(); } catch (err) { reportError?.(err); }
    }
  };

  window.addEventListener('keydown', onKeydown, true);
  window.addEventListener('keyup', onKeyup, true);

  return { triggerQuitConfirm };
}
