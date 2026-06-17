/**
 * Keydown dispatcher.
 *
 * Walks a keymap (default + user overrides) row by row. The first row whose
 * mode matches and whose chord matches the event wins, and its action is
 * invoked through the actions table.
 *
 * Filters applied in order:
 *   1. Mode — `'*'` matches everything; otherwise must equal `getMode()`.
 *   2. Palette open — when the command palette is open, only the
 *      `toggleCommandPalette` action is allowed; everything else falls through
 *      to the palette's own input field.
 *   3. Chord — see `matchesChord`.
 *   4. INPUT focus — entries flagged `skipInInput` are passed through when an
 *      `<input>` has focus, so users typing in the settings modal don't
 *      accidentally fire terminal-level shortcuts.
 *
 * `getKeymap()` is called on every dispatch so settings-driven overrides take
 * effect without rebinding the listener. Parsed-chord caching keeps that cheap.
 */

import { matchesChord, parseChord } from './keymap.js';

// WKWebView (macOS Tauri) bug: the keydown immediately after compositionend
// still reports event.isComposing = true. Track composition state ourselves
// via compositionstart/end so the guard is reliable across all WebKit builds.
//
// Second WKWebView quirk: compositionend is sometimes never delivered (focus
// changes mid-composition, app/window switch, certain IME commit paths). Left
// alone, _composing stays true forever and every shortcut is silently dropped
// until the next composition happens to end cleanly. Three fallbacks recover:
//   1. compositionend (the normal path)
//   2. blur — focus/window left mid-composition, where end is most often lost
//   3. a watchdog re-armed on every composition signal; if nothing arrives for
//      a while, assume the composition died and clear the flag.
const COMPOSITION_TIMEOUT_MS = 2000;
let _composing = false;
let _compositionWatchdog = null;

function clearComposing() {
  _composing = false;
  if (_compositionWatchdog !== null) {
    clearTimeout(_compositionWatchdog);
    _compositionWatchdog = null;
  }
}

function armCompositionWatchdog() {
  if (_compositionWatchdog !== null) clearTimeout(_compositionWatchdog);
  _compositionWatchdog = setTimeout(clearComposing, COMPOSITION_TIMEOUT_MS);
}

window.addEventListener('compositionstart',  () => { _composing = true; armCompositionWatchdog(); }, true);
window.addEventListener('compositionupdate', () => { if (_composing) armCompositionWatchdog(); }, true);
window.addEventListener('compositionend',    clearComposing, true);
window.addEventListener('blur',              clearComposing, true);

export function createDispatcher({
  getKeymap,
  actions,
  getMode,
  isInputFocused,
  isCommandPaletteOpen,
}) {
  let cachedKeymap = null;
  let parsedKeymap = null;
  function getParsed() {
    const km = getKeymap();
    if (km !== cachedKeymap) {
      parsedKeymap = km.map((entry) => ({
        ...entry,
        parsedChord: parseChord(entry.chord),
      }));
      cachedKeymap = km;
    }
    return parsedKeymap;
  }

  return function dispatch(event) {
    if (_composing || event.isComposing) return;

    const mode = getMode();
    const inputFocused = isInputFocused();
    const paletteOpen = isCommandPaletteOpen();

    for (const entry of getParsed()) {
      if (entry.mode !== '*' && entry.mode !== mode) continue;
      if (paletteOpen && entry.action !== 'toggleCommandPalette') continue;
      if (!matchesChord(event, entry.parsedChord)) continue;
      if (inputFocused && entry.skipInInput) continue;

      const handler = actions[entry.action];
      if (!handler) continue;

      event.preventDefault();
      if (entry.stopPropagation) {
        event.stopPropagation();
        event.stopImmediatePropagation();
      }
      handler(event);
      return;
    }
  };
}
