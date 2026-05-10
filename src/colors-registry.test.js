import { describe, it, expect } from 'vitest';
import { PRESET_PANE_COLORS, ACCENT_PALETTE } from './colors-registry.js';

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

describe('PRESET_PANE_COLORS', () => {
  it('has exactly 16 entries', () => {
    expect(PRESET_PANE_COLORS).toHaveLength(16);
  });

  it('all entries are valid #rrggbb hex strings', () => {
    for (const color of PRESET_PANE_COLORS) {
      expect(HEX_RE.test(color), color).toBe(true);
    }
  });

  it('all entries are distinct colors', () => {
    expect(new Set(PRESET_PANE_COLORS).size).toBe(16);
  });
});

describe('ACCENT_PALETTE', () => {
  it('is the same reference as PRESET_PANE_COLORS', () => {
    expect(ACCENT_PALETTE).toBe(PRESET_PANE_COLORS);
  });

  it('has 16 entries', () => {
    expect(ACCENT_PALETTE).toHaveLength(16);
  });
});
