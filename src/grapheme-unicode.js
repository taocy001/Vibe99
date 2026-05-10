// Custom xterm.js Unicode provider with ZWJ grapheme cluster support.
//
// xterm.js 6 processes codepoints one at a time via IUnicodeVersionProvider.
// The default Unicode 11 provider only marks wcwidth=0 characters as "combined"
// (joined to the preceding cell). ZWJ emoji sequences (e.g. 👨‍👩‍👧‍👦) consist of
// wide emoji codepoints (wcwidth=2) joined by ZWJ (U+200D, wcwidth=0). Without
// ZWJ tracking, each component renders as a separate 2-cell character.
//
// Fix: wrap the Unicode 11 provider and track ZWJ state. Any width-2 character
// that immediately follows a ZWJ is marked combined (width=0) so xterm merges
// it into the preceding grapheme cluster cell.
//
// NOT HANDLED (out of scope for P2.3):
//   - Regional indicator flag pairs (🇺🇸 = U+1F1FA U+1F1F8, no ZWJ)
//   - Skin-tone modifier sequences (👋🏽 = U+1F44B U+1F3FD, no ZWJ)

import { Unicode11Addon } from '@xterm/addon-unicode11';

const ZWJ = 0x200D;

// Matches xterm's internal createPropertyValue(charKind=0, width, shouldJoin).
// Encoding: bit 0 = shouldJoin, bits 1-2 = width. charKind (bits 3+) is always
// 0 for all characters handled by the Unicode 11 provider and here.
export function encodeProperty(width, combined) {
  return (width & 3) << 1 | (combined ? 1 : 0);
}

// Extracts width from a property value produced by encodeProperty.
export function extractWidth(prop) {
  return (prop >> 1) & 3;
}

// Obtain a Unicode 11 provider instance without activating it on a real
// terminal — used to delegate wcwidth and base charProperties behaviour.
function buildU11Provider() {
  let provider = null;
  const fake = {
    unicode: {
      register(p) { provider = p; },
      get activeVersion() { return ''; },
      set activeVersion(_) {}
    }
  };
  new Unicode11Addon().activate(fake);
  if (!provider || typeof provider.charProperties !== 'function') {
    throw new Error('GraphemeUnicodeAddon: Unicode11Addon internal API changed — unicode.register() was not called as expected');
  }
  return provider;
}

export class GraphemeProvider {
  constructor() {
    this.version = 'grapheme-v1';
    this._u11 = buildU11Provider();
    this._lastWasZWJ = false;
  }

  resetZWJState() {
    this._lastWasZWJ = false;
  }

  wcwidth(codepoint) {
    return this._u11.wcwidth(codepoint);
  }

  charProperties(codepoint, preceding) {
    const afterZWJ = this._lastWasZWJ;
    this._lastWasZWJ = (codepoint === ZWJ);

    // Only width-2 (wide) codepoints form valid ZWJ emoji components.
    // Narrow codepoints (width 1, e.g. ASCII) after a ZWJ are not collapsed —
    // that would be a malformed sequence and must not corrupt rendering.
    if (afterZWJ && this._u11.wcwidth(codepoint) === 2) {
      return encodeProperty(0, true);
    }

    return this._u11.charProperties(codepoint, preceding);
  }
}

export class GraphemeUnicodeAddon {
  activate(terminal) {
    const provider = new GraphemeProvider();
    terminal.unicode.register(provider);
    terminal.unicode.activeVersion = 'grapheme-v1';

    // Clear ZWJ state on terminal hard reset (ESC c) so a ZWJ stranded at the
    // end of a write chunk does not contaminate the first character after reset.
    terminal.parser.registerEscHandler({ final: 'c' }, () => {
      provider.resetZWJState();
      return false; // let xterm handle the reset normally
    });
  }

  dispose() {}
}
