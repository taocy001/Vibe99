// Custom xterm.js Unicode provider with ZWJ grapheme cluster support.
//
// xterm.js 6 processes codepoints one at a time via IUnicodeVersionProvider.
// The default Unicode 11 provider only marks wcwidth=0 characters as "combined"
// (joined to the preceding cell). ZWJ emoji sequences (e.g. 👨‍👩‍👧‍👦) consist of
// wide emoji codepoints (wcwidth=2) joined by ZWJ (U+200D, wcwidth=0). Without
// ZWJ tracking, each component renders as a separate 2-cell character.
//
// Fix: wrap the Unicode 11 provider and track ZWJ state. Any wide character
// that immediately follows a ZWJ is marked combined (width=0) so xterm merges
// it into the preceding grapheme cluster cell.

import { Unicode11Addon } from '@xterm/addon-unicode11';

const ZWJ = 0x200D;

// Matches xterm's internal createPropertyValue(charKind=0, width, combined):
// bit 0 = shouldJoin, bits 1-2 = width.
function encodeProperty(width, combined) {
  return (width & 3) << 1 | (combined ? 1 : 0);
}

// Extracts width from a property value produced by encodeProperty.
function extractWidth(prop) {
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
  return provider;
}

export class GraphemeProvider {
  constructor() {
    this.version = 'grapheme-v1';
    this._u11 = buildU11Provider();
    this._lastWasZWJ = false;
  }

  wcwidth(codepoint) {
    return this._u11.wcwidth(codepoint);
  }

  charProperties(codepoint, preceding) {
    const afterZWJ = this._lastWasZWJ;
    this._lastWasZWJ = (codepoint === ZWJ);

    if (afterZWJ && this._u11.wcwidth(codepoint) > 0) {
      // Wide character following ZWJ: collapse into the preceding cluster.
      return encodeProperty(0, true);
    }

    return this._u11.charProperties(codepoint, preceding);
  }
}

export class GraphemeUnicodeAddon {
  activate(terminal) {
    terminal.unicode.register(new GraphemeProvider());
    terminal.unicode.activeVersion = 'grapheme-v1';
  }

  dispose() {}
}
