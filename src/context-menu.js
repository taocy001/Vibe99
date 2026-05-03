/**
 * context-menu.js — framework-agnostic DOM context menu engine.
 *
 * Item shape:
 *   { label, action, shortcut?, disabled?, isDefault? }  — leaf
 *   { type: 'separator' }                                 — divider
 *   { label, children: Item[] }                           — submenu (one level)
 *
 * Usage:
 *   import { showContextMenu, hideContextMenu } from './context-menu.js';
 *
 *   showContextMenu(items, x, y, (action) => handleAction(action));
 *
 * The module owns a single active menu element. Calling showContextMenu() while
 * one is already open first closes the old one (via hideContextMenu).
 */

let _dismissListener = null;
let _blurListener = null;
let _onHide = null;  // optional callback invoked when the menu is dismissed

/**
 * Show a context menu at (x, y).
 * @param {Array}    items     Menu item descriptors (see module doc).
 * @param {number}   x        Left position in viewport px.
 * @param {number}   y        Top position in viewport px.
 * @param {Function} onAction Called with the action string when an item is clicked.
 * @param {Function} [onHide] Optional: called when the menu is dismissed without a selection.
 */
export function showContextMenu(items, x, y, onAction, onHide) {
  hideContextMenu();
  _onHide = onHide ?? null;

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.setAttribute('role', 'menu');

  for (const item of items) {
    if (item.type === 'separator') {
      const sep = document.createElement('div');
      sep.className = 'context-menu-separator';
      menu.appendChild(sep);
      continue;
    }

    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'context-menu-item';
    row.setAttribute('role', 'menuitem');
    row.disabled = item.disabled || false;

    const labelEl = document.createElement('span');
    labelEl.className = 'context-menu-label';
    labelEl.textContent = item.label;
    row.appendChild(labelEl);

    if (item.shortcut) {
      const shortcut = document.createElement('span');
      shortcut.className = 'context-menu-shortcut';
      shortcut.textContent = item.shortcut;
      row.appendChild(shortcut);
    }

    row.addEventListener('click', (e) => {
      e.stopPropagation();
      _onHide = null;  // action taken — don't call onHide
      hideContextMenu();
      onAction(item.action);
    });

    if (item.children?.length) {
      row.classList.add('context-menu-parent');
      const submenu = document.createElement('div');
      submenu.className = 'context-menu-submenu';
      submenu.setAttribute('role', 'menu');

      for (const child of item.children) {
        const childRow = document.createElement('button');
        childRow.type = 'button';
        childRow.className = 'context-menu-item';
        childRow.setAttribute('role', 'menuitem');
        childRow.disabled = child.disabled || false;

        const childLabel = document.createElement('span');
        childLabel.className = 'context-menu-label';
        childLabel.textContent = child.label;
        childRow.appendChild(childLabel);

        if (child.isDefault) {
          const check = document.createElement('span');
          check.className = 'context-menu-shortcut';
          check.textContent = '★';
          childRow.appendChild(check);
        }

        childRow.addEventListener('click', (e) => {
          e.stopPropagation();
          _onHide = null;
          hideContextMenu();
          onAction(child.action);
        });

        submenu.appendChild(childRow);
      }
      row.appendChild(submenu);
    }

    menu.appendChild(row);
  }

  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  document.body.appendChild(menu);

  // Flip left/down if the menu bleeds outside the viewport.
  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      menu.style.left = `${Math.max(0, x - rect.width)}px`;
    }
    if (rect.bottom > window.innerHeight) {
      menu.style.top = `${Math.max(0, y - rect.height)}px`;
    }
  });

  // Dismiss on outside click or window blur — registered in a microtask so the
  // mousedown that opened the menu doesn't immediately close it.
  _dismissListener = (e) => {
    if (!e.target.closest('.context-menu')) hideContextMenu();
  };
  _blurListener = hideContextMenu;
  // Capture current references — if hideContextMenu() fires before this
  // microtask runs (e.g., rapid double open), the stale fn won't be registered.
  const dismiss = _dismissListener;
  const blur = _blurListener;
  queueMicrotask(() => {
    if (_dismissListener === dismiss) document.addEventListener('pointerdown', dismiss);
    if (_blurListener === blur) window.addEventListener('blur', blur);
  });
}

/** Close the active context menu, if any. */
export function hideContextMenu() {
  const menu = document.querySelector('.context-menu');
  if (menu) menu.remove();

  if (_dismissListener) {
    document.removeEventListener('pointerdown', _dismissListener);
    _dismissListener = null;
  }
  if (_blurListener) {
    window.removeEventListener('blur', _blurListener);
    _blurListener = null;
  }

  if (_onHide) {
    const cb = _onHide;
    _onHide = null;
    cb();
  }
}
