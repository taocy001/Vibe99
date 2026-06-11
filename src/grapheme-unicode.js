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
//   - Regional indicator flag pairs (🇺🇸): each RI has wcwidth=1 so two RIs
//     naturally occupy 2 cells — no fix needed.
//   - Subdivision flags (🏴󠁧󠁢󠁥󠁮󠁧󠁿): tag chars U+E0020–U+E007F have wcwidth=0
//     so they're already combined by the U11 provider — no fix needed.

import { Unicode11Addon } from '@xterm/addon-unicode11';

const ZWJ = 0x200D;
const SKIN_TONE_START = 0x1F3FB;
const SKIN_TONE_END   = 0x1F3FF;

// East Asian Width = Ambiguous (EAW=A) ranges from Unicode 15 data.
// In a CJK locale these characters occupy 2 columns; in a Western locale 1.
// When ambiguousDouble mode is on we return width=2 so SSH output from a
// CJK-locale remote aligns correctly (matching iTerm2 "treat ambiguous as
// double-width" behaviour).
const EAW_A_RANGES = [
  // Latin supplement
  [0x00A1,0x00A1],[0x00A4,0x00A4],[0x00A7,0x00A8],[0x00AA,0x00AA],
  // U+00B7 (MIDDLE DOT ·) excluded: used as separator by Claude Code, vim listchars,
  // tmux, and other TUI tools that assume width=1. All other EAW=A Latin chars kept.
  [0x00AD,0x00AE],[0x00B0,0x00B4],[0x00B6,0x00B6],[0x00B8,0x00BA],[0x00BC,0x00BF],
  [0x00C6,0x00C6],[0x00D0,0x00D0],[0x00D7,0x00D7],[0x00D9,0x00D9],
  [0x00DE,0x00E1],[0x00E6,0x00E6],[0x00E8,0x00EA],[0x00EC,0x00ED],
  [0x00F0,0x00F0],[0x00F2,0x00F3],[0x00F7,0x00FA],[0x00FC,0x00FC],
  [0x00FE,0x00FE],
  // Latin extended / special
  [0x0101,0x0101],[0x0111,0x0111],[0x0113,0x0113],[0x011B,0x011B],
  [0x0126,0x0127],[0x012B,0x012B],[0x0131,0x0133],[0x0138,0x0138],
  [0x013F,0x0142],[0x0144,0x0144],[0x0148,0x014B],[0x014D,0x014D],
  [0x0152,0x0153],[0x0166,0x0167],[0x016B,0x016B],[0x01CE,0x01CE],
  [0x01D0,0x01D0],[0x01D2,0x01D2],[0x01D4,0x01D4],[0x01D6,0x01D6],
  [0x01D8,0x01D8],[0x01DA,0x01DA],[0x01DC,0x01DC],[0x0251,0x0251],
  [0x0261,0x0261],
  // Spacing modifiers
  [0x02C4,0x02C4],[0x02C7,0x02C7],[0x02C9,0x02CB],[0x02CD,0x02CD],
  [0x02D0,0x02D0],[0x02D8,0x02DB],[0x02DD,0x02DD],[0x02DF,0x02DF],
  // Greek
  [0x0391,0x03A1],[0x03A3,0x03A9],[0x03B1,0x03C1],[0x03C3,0x03C9],
  // Cyrillic
  [0x0401,0x0401],[0x0410,0x044F],[0x0451,0x0451],
  // General punctuation & misc
  [0x2010,0x2027],[0x2030,0x203E],[0x2041,0x2053],[0x2060,0x2063],
  [0x20AC,0x20AC],
  // Letterlike symbols & fractions
  [0x2100,0x2102],[0x2103,0x2109],[0x210A,0x2112],[0x2113,0x2113],
  [0x2115,0x2115],[0x2119,0x211D],[0x2124,0x2124],[0x2126,0x2126],
  [0x2128,0x2128],[0x212A,0x2130],[0x2135,0x2138],[0x2153,0x215E],
  [0x2160,0x216B],[0x2170,0x2179],
  // Mathematical operators (key subset)
  [0x2200,0x2200],[0x2202,0x2203],[0x2207,0x2208],[0x220B,0x220B],
  [0x220F,0x220F],[0x2211,0x2211],[0x2215,0x2215],[0x221A,0x221A],
  [0x221D,0x2220],[0x2223,0x2223],[0x2225,0x2225],[0x2227,0x222C],
  [0x222E,0x222E],[0x2234,0x2237],[0x223C,0x223D],[0x2248,0x2248],
  [0x224C,0x224C],[0x2252,0x2252],[0x2260,0x2261],[0x2264,0x2267],
  [0x226A,0x226B],[0x226E,0x226F],[0x2282,0x2283],[0x2286,0x2287],
  [0x2295,0x2295],[0x2299,0x2299],[0x22A5,0x22A5],[0x22BF,0x22BF],
  [0x2312,0x2312],
  // Enclosed alphanumerics (circled numbers/letters ①-ⓩ)
  [0x2460,0x24E9],[0x24EB,0x24FF],
  // NOTE: Arrows (U+2190-U+21E7), Box Drawing (U+2500-U+2573), Block Elements
  // (U+2580-U+2595), Geometric Shapes (U+25A0-U+25EF), and Miscellaneous Symbols
  // (U+2605-U+26C5) are intentionally excluded from EAW=A treatment.
  // These characters are used by TUI apps (Claude Code, vim, tmux, btop, fzf, etc.)
  // for layout: borders, bullets (●▲■), progress bars (▁▂▃█), arrows (←→↑↓).
  // Treating them as width=2 breaks app layout because the apps compute their output
  // assuming width=1 (the Unicode-standard default for EAW=A on Western systems).
  // Dingbats / supplemental misc
  [0x273D,0x273D],[0x2776,0x277F],
  [0x2B24,0x2B24],[0x2B2E,0x2B2F],[0x2B56,0x2B59],
];

// Flat Uint8Array lookup for O(1) ambiguous-width check across the BMP.
const _EAW_A = new Uint8Array(0x10000);
for (const [lo, hi] of EAW_A_RANGES) _EAW_A.fill(1, lo, hi + 1);
function isAmbiguousWidth(cp) { return cp < 0x10000 && _EAW_A[cp] === 1; }

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

let _cachedU11Provider = null;
function getU11Provider() {
  if (!_cachedU11Provider) _cachedU11Provider = buildU11Provider();
  return _cachedU11Provider;
}

export class GraphemeProvider {
  // getAmbiguousDouble: () => boolean — read live from settings each call so
  // the toggle takes effect without restarting the terminal.
  constructor(getAmbiguousDouble) {
    this.version = 'grapheme-v1';
    this._u11 = getU11Provider();
    this._lastWasZWJ = false;
    this._getAmbiguousDouble = getAmbiguousDouble || (() => false);
  }

  resetZWJState() {
    this._lastWasZWJ = false;
  }

  wcwidth(codepoint) {
    // In ambiguous-double mode, EAW=A chars must report width=2 here as well
    // so cursor arithmetic inside xterm matches what charProperties returns.
    if (this._getAmbiguousDouble() && isAmbiguousWidth(codepoint)) return 2;
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

    // Skin-tone modifiers (U+1F3FB–U+1F3FF) have wcwidth=2 but must be
    // combined with the preceding base emoji (e.g. 👋🏽). Only combine when
    // the preceding cell is plausibly an emoji base: a wide char, or a char
    // already joined into a cluster (ZWJ sequences like 👨‍👩🏽). A stranded
    // modifier (line start, after ASCII) renders standalone instead of
    // swallowing the previous cell.
    if (codepoint >= SKIN_TONE_START && codepoint <= SKIN_TONE_END
        && (extractWidth(preceding) === 2 || (preceding & 1) === 1)) {
      return encodeProperty(0, true);
    }

    const base = this._u11.charProperties(codepoint, preceding);

    // Ambiguous-double mode: promote EAW=A chars from width=1 to width=2 so
    // that SSH output from a CJK-locale remote aligns correctly.
    if (this._getAmbiguousDouble() && isAmbiguousWidth(codepoint) && extractWidth(base) === 1) {
      return encodeProperty(2, !!(base & 1));
    }

    return base;
  }
}

export class GraphemeUnicodeAddon {
  // getAmbiguousDouble: () => boolean — passed through to GraphemeProvider.
  constructor(getAmbiguousDouble) {
    this._getAmbiguousDouble = getAmbiguousDouble;
  }

  activate(terminal) {
    const provider = new GraphemeProvider(this._getAmbiguousDouble);
    terminal.unicode.register(provider);
    terminal.unicode.activeVersion = 'grapheme-v1';

    // Clear ZWJ state on terminal hard reset (ESC c) so a ZWJ stranded at the
    // end of a write chunk does not contaminate the first character after reset.
    terminal.parser.registerEscHandler({ final: 'c' }, () => {
      provider.resetZWJState();
      return false; // let xterm handle the reset normally
    });
    // Same for soft reset (DECSTR, CSI ! p) — vim and friends send it on exit.
    terminal.parser.registerCsiHandler({ intermediates: '!', final: 'p' }, () => {
      provider.resetZWJState();
      return false;
    });
  }

  dispose() {}
}
