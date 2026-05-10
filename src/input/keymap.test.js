import { describe, it, expect } from 'vitest';
import { KEYMAP, parseChord, matchesChord, formatChord } from './keymap.js';

// Helpers
function evt(key, { ctrl = false, meta = false, shift = false, alt = false, code = '', repeat = false } = {}) {
  return { key, ctrlKey: ctrl, metaKey: meta, shiftKey: shift, altKey: alt, code, repeat };
}

describe('KEYMAP', () => {
  it('has at least one entry per primary mode', () => {
    const modes = new Set(KEYMAP.map(r => r.mode));
    expect(modes.has('*')).toBe(true);
    expect(modes.has('nav')).toBe(true);
  });

  it('entries with id have non-empty chord and action', () => {
    for (const row of KEYMAP.filter(r => r.id)) {
      expect(typeof row.chord).toBe('string');
      expect(row.chord.length).toBeGreaterThan(0);
      expect(typeof row.action).toBe('string');
    }
  });

  it('all ids are unique', () => {
    const ids = KEYMAP.filter(r => r.id).map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('parseChord', () => {
  it('parses single key', () => {
    expect(parseChord('a')).toEqual([{ key: 'a', ctrl: false, meta: false, shift: false, alt: false }]);
  });

  it('parses Ctrl modifier', () => {
    const [alt] = parseChord('Ctrl+C');
    expect(alt.ctrl).toBe(true);
    expect(alt.key).toBe('C');
    expect(alt.meta).toBe(false);
  });

  it('parses Cmd/meta modifier', () => {
    const [alt] = parseChord('Cmd+T');
    expect(alt.meta).toBe(true);
    expect(alt.ctrl).toBe(false);
    expect(alt.key).toBe('T');
  });

  it('parses Shift modifier', () => {
    const [alt] = parseChord('Shift+A');
    expect(alt.shift).toBe(true);
    expect(alt.key).toBe('A');
  });

  it('parses Alt modifier', () => {
    const [alt] = parseChord('Alt+F');
    expect(alt.alt).toBe(true);
    expect(alt.key).toBe('F');
  });

  it('parses Option as alt', () => {
    const [alt] = parseChord('Option+F');
    expect(alt.alt).toBe(true);
  });

  it('parses combined modifiers', () => {
    const [alt] = parseChord('Cmd+Shift+D');
    expect(alt.meta).toBe(true);
    expect(alt.shift).toBe(true);
    expect(alt.ctrl).toBe(false);
    expect(alt.key).toBe('D');
  });

  it('parses multi-alternative chord', () => {
    const alts = parseChord('Cmd+[|Cmd+ArrowLeft');
    expect(alts).toHaveLength(2);
    expect(alts[0].key).toBe('[');
    expect(alts[1].key).toBe('ArrowLeft');
    expect(alts[0].meta).toBe(true);
    expect(alts[1].meta).toBe(true);
  });

  it('parses digit range 1..9', () => {
    const [alt] = parseChord('1..9');
    expect(alt._digitRange).toEqual({ lo: 1, hi: 9 });
    expect(alt.key).toBe('?');
  });

  it('throws on unknown modifier', () => {
    expect(() => parseChord('Win+T')).toThrow();
  });

  it('throws on empty chord', () => {
    expect(() => parseChord('')).toThrow();
  });
});

describe('matchesChord', () => {
  it('matches a simple key', () => {
    const alts = parseChord('a');
    expect(matchesChord(evt('a'), alts)).toBe(true);
    expect(matchesChord(evt('b'), alts)).toBe(false);
  });

  it('case-insensitive single-char key', () => {
    const alts = parseChord('a');
    expect(matchesChord(evt('A'), alts)).toBe(true);
  });

  it('requires correct modifiers', () => {
    const alts = parseChord('Cmd+T');
    expect(matchesChord(evt('T', { meta: true }), alts)).toBe(true);
    expect(matchesChord(evt('T', { ctrl: true }), alts)).toBe(false);
    expect(matchesChord(evt('T'), alts)).toBe(false);
  });

  it('Ctrl and Cmd are independent', () => {
    const ctrlAlts = parseChord('Ctrl+B');
    const cmdAlts = parseChord('Cmd+B');
    expect(matchesChord(evt('B', { ctrl: true }), ctrlAlts)).toBe(true);
    expect(matchesChord(evt('B', { meta: true }), ctrlAlts)).toBe(false);
    expect(matchesChord(evt('B', { meta: true }), cmdAlts)).toBe(true);
    expect(matchesChord(evt('B', { ctrl: true }), cmdAlts)).toBe(false);
  });

  it('matches Tab by code', () => {
    const alts = parseChord('Ctrl+Tab');
    expect(matchesChord(evt('Tab', { ctrl: true, code: 'Tab' }), alts)).toBe(true);
    expect(matchesChord(evt('Tab', { ctrl: true, code: 'NumpadEnter' }), alts)).toBe(false);
  });

  it('ignores Tab auto-repeat', () => {
    const alts = parseChord('Ctrl+Tab');
    expect(matchesChord(evt('Tab', { ctrl: true, code: 'Tab', repeat: true }), alts)).toBe(false);
  });

  it('matches [ and ] by code to avoid Shift remapping', () => {
    const bracketLeft = parseChord('Cmd+[');
    // Matches when code is BracketLeft, regardless of which character was produced
    expect(matchesChord(evt('[', { meta: true, code: 'BracketLeft' }), bracketLeft)).toBe(true);
    // Wrong code → no match
    expect(matchesChord(evt('[', { meta: true, code: 'BracketRight' }), bracketLeft)).toBe(false);
    // Missing meta → no match
    expect(matchesChord(evt('[', { code: 'BracketLeft' }), bracketLeft)).toBe(false);

    const bracketRight = parseChord('Cmd+]');
    expect(matchesChord(evt(']', { meta: true, code: 'BracketRight' }), bracketRight)).toBe(true);
    expect(matchesChord(evt(']', { meta: true, code: 'BracketLeft' }), bracketRight)).toBe(false);
  });

  it('matches digit range', () => {
    const alts = parseChord('1..9');
    expect(matchesChord(evt('1'), alts)).toBe(true);
    expect(matchesChord(evt('5'), alts)).toBe(true);
    expect(matchesChord(evt('9'), alts)).toBe(true);
    expect(matchesChord(evt('0'), alts)).toBe(false);
    expect(matchesChord(evt('1', { ctrl: true }), alts)).toBe(false);
    expect(matchesChord(evt('a'), alts)).toBe(false);
  });

  it('matches first of multiple alternatives', () => {
    const alts = parseChord('Cmd+[|Cmd+ArrowLeft');
    expect(matchesChord(evt('[', { meta: true, code: 'BracketLeft' }), alts)).toBe(true);
    expect(matchesChord(evt('ArrowLeft', { meta: true }), alts)).toBe(true);
    expect(matchesChord(evt('ArrowRight', { meta: true }), alts)).toBe(false);
  });
});

describe('formatChord', () => {
  it('formats single key', () => {
    expect(formatChord('a', 'linux')).toBe('a');
  });

  it('formats Ctrl on Linux', () => {
    expect(formatChord('Ctrl+C', 'linux')).toBe('Ctrl+C');
  });

  it('formats Cmd+Shift on Linux', () => {
    expect(formatChord('Cmd+Shift+D', 'linux')).toBe('Cmd+Shift+D');
  });

  it('formats Cmd as ⌘ on darwin', () => {
    expect(formatChord('Cmd+T', 'darwin')).toBe('⌘T');
  });

  it('formats Cmd+Shift on darwin', () => {
    expect(formatChord('Cmd+Shift+D', 'darwin')).toBe('⌘⇧D');
  });

  it('formats Ctrl as ^ on darwin', () => {
    expect(formatChord('Ctrl+B', 'darwin')).toBe('^B');
  });

  it('formats Alt as ⌥ on darwin', () => {
    expect(formatChord('Alt+F', 'darwin')).toBe('⌥F');
  });

  it('only shows first alternative of multi-alt chord', () => {
    const result = formatChord('Cmd+[|Cmd+ArrowLeft', 'linux');
    expect(result).not.toContain('|');
    expect(result).toBe('Cmd+[');
  });

  it('defaults to linux when platform omitted', () => {
    expect(formatChord('Cmd+T')).toBe('Cmd+T');
  });

  it('formats Space key', () => {
    expect(formatChord('Cmd+Shift+O', 'linux')).toBe('Cmd+Shift+O');
  });
});
