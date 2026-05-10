// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { generateItermcolors, parseItermcolors } from './itermcolors.js';

const SAMPLE_PALETTE = {
  background: '#111111',
  foreground: '#d9d4c7',
  selectionBg: '#2a2a2a',
  ansi: [
    '#111111', '#ff6b57', '#98c379', '#e5c07b',
    '#61afef', '#c678dd', '#56b6c2', '#d9d4c7',
    '#5a6374', '#ff8578', '#b0d98b', '#f0d58a',
    '#7eb7ff', '#d9a5e8', '#7fd8e6', '#ffffff',
  ],
};

describe('generateItermcolors', () => {
  it('produces valid XML plist preamble', () => {
    const xml = generateItermcolors(SAMPLE_PALETTE);
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<plist version="1.0">');
    expect(xml).toContain('<dict>');
    expect(xml).toContain('</dict>');
    expect(xml).toContain('</plist>');
  });

  it('includes DOCTYPE declaration', () => {
    const xml = generateItermcolors(SAMPLE_PALETTE);
    expect(xml).toContain('<!DOCTYPE plist');
    expect(xml).toContain('Apple');
  });

  it('includes all 16 ANSI color entries', () => {
    const xml = generateItermcolors(SAMPLE_PALETTE);
    for (let i = 0; i <= 15; i++) {
      expect(xml).toContain(`Ansi ${i} Color`);
    }
  });

  it('includes Background, Foreground, and Selection Color entries', () => {
    const xml = generateItermcolors(SAMPLE_PALETTE);
    expect(xml).toContain('Background Color');
    expect(xml).toContain('Foreground Color');
    expect(xml).toContain('Selection Color');
  });

  it('encodes RGB components as reals in 0..1 range', () => {
    const xml = generateItermcolors({ background: '#ffffff', foreground: '#000000', selectionBg: '#808080', ansi: Array(16).fill('#000000') });
    expect(xml).toContain('<real>1.0000000000</real>');
    expect(xml).toContain('<real>0.0000000000</real>');
  });

  it('includes Alpha Component = 1 and sRGB Color Space', () => {
    const xml = generateItermcolors(SAMPLE_PALETTE);
    expect(xml).toContain('<key>Alpha Component</key><real>1</real>');
    expect(xml).toContain('<string>sRGB</string>');
  });

  it('encodes #ff0000 correctly as red=1, green=0, blue=0', () => {
    const palette = { ...SAMPLE_PALETTE, background: '#ff0000' };
    const xml = generateItermcolors(palette);
    // The background entry should have red=1.0, green=0.0, blue=0.0
    expect(xml).toMatch(/Background Color[\s\S]*?Red Component[\s\S]*?1\.0000/);
  });

  it('BUG: does not crash when palette.ansi has fewer than 16 entries', () => {
    // ANSI_KEYS.map((k,i) => entry(k, palette.ansi[i])) passes undefined to hexToComps
    // when the array is short, causing TypeError: Cannot read properties of undefined (reading 'slice')
    const shortPalette = { ...SAMPLE_PALETTE, ansi: ['#ff0000'] };
    expect(() => generateItermcolors(shortPalette)).not.toThrow();
  });
});

describe('parseItermcolors', () => {
  it('returns null for empty string', () => {
    expect(parseItermcolors('')).toBeNull();
  });

  it('returns null for invalid XML', () => {
    expect(parseItermcolors('not xml at all')).toBeNull();
  });

  it('returns null when plist dict is missing', () => {
    expect(parseItermcolors('<?xml version="1.0"?><plist version="1.0"><array/></plist>')).toBeNull();
  });

  it('parses background, foreground, selectionBg', () => {
    const xml = generateItermcolors(SAMPLE_PALETTE);
    const result = parseItermcolors(xml);
    expect(result).not.toBeNull();
    expect(result.background).toBe('#111111');
    expect(result.foreground).toBe('#d9d4c7');
    expect(result.selectionBg).toBe('#2a2a2a');
  });

  it('parses all 16 ANSI colors', () => {
    const xml = generateItermcolors(SAMPLE_PALETTE);
    const result = parseItermcolors(xml);
    expect(result.ansi).toHaveLength(16);
    expect(result.ansi[0]).toBe('#111111');
    expect(result.ansi[15]).toBe('#ffffff');
  });

  it('roundtrip: parse(generate(palette)) returns same palette', () => {
    const xml = generateItermcolors(SAMPLE_PALETTE);
    const result = parseItermcolors(xml);
    expect(result.background).toBe(SAMPLE_PALETTE.background);
    expect(result.foreground).toBe(SAMPLE_PALETTE.foreground);
    expect(result.selectionBg).toBe(SAMPLE_PALETTE.selectionBg);
    for (let i = 0; i < 16; i++) {
      expect(result.ansi[i], `ansi[${i}]`).toBe(SAMPLE_PALETTE.ansi[i]);
    }
  });

  it('roundtrip preserves all 6 presets', async () => {
    const { COLOR_PRESETS } = await import('./color-presets.js');
    const { generateItermcolors: gen, parseItermcolors: parse } = await import('./itermcolors.js');
    for (const [name, preset] of Object.entries(COLOR_PRESETS)) {
      for (const mode of ['dark', 'light']) {
        const palette = preset[mode];
        const xml = gen(palette);
        const result = parse(xml);
        expect(result, `${name}.${mode}`).not.toBeNull();
        expect(result.background, `${name}.${mode} background`).toBe(palette.background);
        expect(result.ansi[0], `${name}.${mode} ansi[0]`).toBe(palette.ansi[0]);
      }
    }
  });
});
