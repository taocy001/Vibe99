import { describe, it, expect } from 'vitest';
import { COLOR_PRESETS, DEFAULT_PRESET_ID, getPreset } from './color-presets.js';

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function isValidHex(s) {
  return HEX_RE.test(s);
}

describe('COLOR_PRESETS', () => {
  it('contains exactly the expected presets', () => {
    const keys = Object.keys(COLOR_PRESETS);
    expect(keys).toContain('vibe');
    expect(keys).toContain('dracula');
    expect(keys).toContain('one-dark');
    expect(keys).toContain('solarized');
    expect(keys).toContain('nord');
    expect(keys).toContain('gruvbox');
    expect(keys).toHaveLength(6);
  });

  it('each preset has a label', () => {
    for (const [name, preset] of Object.entries(COLOR_PRESETS)) {
      expect(typeof preset.label, name).toBe('string');
      expect(preset.label.length, name).toBeGreaterThan(0);
    }
  });

  it('each preset has dark and light variants', () => {
    for (const [name, preset] of Object.entries(COLOR_PRESETS)) {
      expect(preset.dark, `${name}.dark`).toBeDefined();
      expect(preset.light, `${name}.light`).toBeDefined();
    }
  });

  it('each variant has background, foreground, selectionBg, ansi', () => {
    for (const [name, preset] of Object.entries(COLOR_PRESETS)) {
      for (const mode of ['dark', 'light']) {
        const v = preset[mode];
        expect(typeof v.background, `${name}.${mode}.background`).toBe('string');
        expect(typeof v.foreground, `${name}.${mode}.foreground`).toBe('string');
        expect(typeof v.selectionBg, `${name}.${mode}.selectionBg`).toBe('string');
        expect(Array.isArray(v.ansi), `${name}.${mode}.ansi`).toBe(true);
      }
    }
  });

  it('each ansi array has exactly 16 entries', () => {
    for (const [name, preset] of Object.entries(COLOR_PRESETS)) {
      for (const mode of ['dark', 'light']) {
        expect(preset[mode].ansi, `${name}.${mode}`).toHaveLength(16);
      }
    }
  });

  it('all color values are valid #rrggbb hex strings', () => {
    for (const [name, preset] of Object.entries(COLOR_PRESETS)) {
      for (const mode of ['dark', 'light']) {
        const v = preset[mode];
        expect(isValidHex(v.background), `${name}.${mode}.background`).toBe(true);
        expect(isValidHex(v.foreground), `${name}.${mode}.foreground`).toBe(true);
        expect(isValidHex(v.selectionBg), `${name}.${mode}.selectionBg`).toBe(true);
        for (let i = 0; i < 16; i++) {
          expect(isValidHex(v.ansi[i]), `${name}.${mode}.ansi[${i}]`).toBe(true);
        }
      }
    }
  });
});

describe('DEFAULT_PRESET_ID', () => {
  it('is a string', () => {
    expect(typeof DEFAULT_PRESET_ID).toBe('string');
  });

  it('refers to an existing preset', () => {
    expect(COLOR_PRESETS[DEFAULT_PRESET_ID]).toBeDefined();
  });
});

describe('getPreset', () => {
  it('returns the correct preset by id', () => {
    for (const id of Object.keys(COLOR_PRESETS)) {
      expect(getPreset(id)).toBe(COLOR_PRESETS[id]);
    }
  });

  it('falls back to default preset for unknown id', () => {
    expect(getPreset('nonexistent')).toBe(COLOR_PRESETS[DEFAULT_PRESET_ID]);
  });

  it('falls back for undefined id', () => {
    expect(getPreset(undefined)).toBe(COLOR_PRESETS[DEFAULT_PRESET_ID]);
  });

  it('falls back for empty string', () => {
    expect(getPreset('')).toBe(COLOR_PRESETS[DEFAULT_PRESET_ID]);
  });
});
