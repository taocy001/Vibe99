import { describe, it, expect, beforeEach } from 'vitest';
import { GraphemeProvider, encodeProperty, extractWidth } from './grapheme-unicode.js';

function extractCombined(prop) { return (prop & 1) !== 0; }

describe('GraphemeProvider', () => {
  let p;

  beforeEach(() => { p = new GraphemeProvider(); });

  // ── wcwidth ───────────────────────────────────────────────────────────────

  it('ASCII: width 1', () => {
    expect(p.wcwidth(0x41)).toBe(1); // 'A'
  });

  it('CJK: width 2', () => {
    expect(p.wcwidth(0x4E2D)).toBe(2); // '中'
    expect(p.wcwidth(0x65E5)).toBe(2); // '日'
  });

  it('ZWJ: width 0', () => {
    expect(p.wcwidth(0x200D)).toBe(0);
  });

  it('base emoji: width 2', () => {
    expect(p.wcwidth(0x1F468)).toBe(2); // 👨
    expect(p.wcwidth(0x1F469)).toBe(2); // 👩
  });

  // ── ZWJ grapheme cluster ──────────────────────────────────────────────────

  it('standalone wide emoji has width 2, not combined', () => {
    const prop = p.charProperties(0x1F600, 0); // 😀
    expect(extractWidth(prop)).toBe(2);
    expect(extractCombined(prop)).toBe(false);
  });

  it('character after ZWJ is combined with width 0', () => {
    const propMan  = p.charProperties(0x1F468, 0);        // 👨 — base
    const propZWJ  = p.charProperties(0x200D, propMan);   // ZWJ
    const propWoman = p.charProperties(0x1F469, propZWJ); // 👩 — must be combined

    expect(extractCombined(propWoman)).toBe(true);
    expect(extractWidth(propWoman)).toBe(0);
  });

  it('full family emoji 👨‍👩‍👧‍👦 collapses all members after ZWJ', () => {
    const codepoints = [
      0x1F468, // 👨
      0x200D,  // ZWJ
      0x1F469, // 👩
      0x200D,  // ZWJ
      0x1F467, // 👧
      0x200D,  // ZWJ
      0x1F466, // 👦
    ];

    let prev = 0;
    const props = codepoints.map(cp => {
      const r = p.charProperties(cp, prev);
      prev = r;
      return r;
    });

    // First character (👨) takes 2 cells
    expect(extractWidth(props[0])).toBe(2);
    expect(extractCombined(props[0])).toBe(false);

    // All characters after ZWJ must be combined (width 0)
    expect(extractCombined(props[2])).toBe(true); // 👩
    expect(extractWidth(props[2])).toBe(0);
    expect(extractCombined(props[4])).toBe(true); // 👧
    expect(extractWidth(props[4])).toBe(0);
    expect(extractCombined(props[6])).toBe(true); // 👦
    expect(extractWidth(props[6])).toBe(0);
  });

  it('ZWJ state resets: wide emoji after non-ZWJ is NOT combined', () => {
    p.charProperties(0x1F468, 0); // 👨 — no ZWJ follows
    const prop = p.charProperties(0x1F469, encodeProperty(2, false)); // 👩 standalone
    expect(extractCombined(prop)).toBe(false);
    expect(extractWidth(prop)).toBe(2);
  });

  it('narrow character (ASCII) after ZWJ is NOT combined', () => {
    // Malformed sequence: ZWJ followed by a width-1 character.
    // Must not silently combine 'A' — that would corrupt rendering.
    const propEmoji = p.charProperties(0x1F468, 0);      // 👨
    const propZWJ   = p.charProperties(0x200D, propEmoji); // ZWJ
    const propA     = p.charProperties(0x41, propZWJ);    // 'A'

    expect(extractCombined(propA)).toBe(false);
    expect(extractWidth(propA)).toBe(1);
  });

  it('resetZWJState() clears pending ZWJ flag', () => {
    p.charProperties(0x1F468, 0); // 👨
    p.charProperties(0x200D, 0);  // ZWJ — _lastWasZWJ is now true
    p.resetZWJState();             // simulate ESC c terminal reset
    const prop = p.charProperties(0x1F469, 0); // 👩 after reset
    expect(extractCombined(prop)).toBe(false);
    expect(extractWidth(prop)).toBe(2);
  });

  // ── CJK combining marks still work ───────────────────────────────────────

  it('zero-width combining mark after CJK character is combined', () => {
    const propCJK  = p.charProperties(0x4E2D, 0);   // 中
    const propMark = p.charProperties(0x0308, propCJK); // combining diaeresis
    expect(extractWidth(propCJK)).toBe(2);
    expect(extractCombined(propMark)).toBe(true);
  });
});
