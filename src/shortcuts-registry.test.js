import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_SHORTCUTS,
  getActiveKeymap,
  getKeyboardShortcuts,
  updateKeyboardShortcut,
  shortcutsConflict,
  findConflict,
  resetShortcutsToDefaults,
  loadShortcutsFromSettings,
  getShortcutsForSave,
  formatShortcut,
  parseShortcutEvent,
} from './shortcuts-registry.js';

beforeEach(() => {
  resetShortcutsToDefaults();
});

describe('DEFAULT_SHORTCUTS', () => {
  it('contains entries for customizable actions', () => {
    expect(Object.keys(DEFAULT_SHORTCUTS).length).toBeGreaterThan(0);
  });

  it('each entry has key, modifiers, action, platform', () => {
    for (const [, s] of Object.entries(DEFAULT_SHORTCUTS)) {
      expect(typeof s.key).toBe('string');
      expect(Array.isArray(s.modifiers)).toBe(true);
      expect(typeof s.action).toBe('string');
      expect(s.platform).toBe('all');
    }
  });

  it('includes well-known actions', () => {
    const actions = Object.values(DEFAULT_SHORTCUTS).map(s => s.action);
    expect(actions).toContain('copyTerminalSelection');
    expect(actions).toContain('pasteIntoTerminal');
    expect(actions).toContain('newPane');
  });

  it('single-letter keys are stored lowercase', () => {
    for (const s of Object.values(DEFAULT_SHORTCUTS)) {
      if (s.key.length === 1) {
        expect(s.key).toBe(s.key.toLowerCase());
      }
    }
  });
});

describe('getKeyboardShortcuts', () => {
  it('returns all customizable shortcuts with mode field', () => {
    const shortcuts = getKeyboardShortcuts();
    expect(Object.keys(shortcuts).length).toBeGreaterThan(0);
    for (const [, s] of Object.entries(shortcuts)) {
      expect(typeof s.key).toBe('string');
      expect(Array.isArray(s.modifiers)).toBe(true);
    }
  });

  it('reflects defaults when no overrides', () => {
    const shortcuts = getKeyboardShortcuts();
    for (const [id, def] of Object.entries(DEFAULT_SHORTCUTS)) {
      expect(shortcuts[id]?.key).toBe(def.key);
      expect(shortcuts[id]?.modifiers).toEqual(def.modifiers);
    }
  });
});

describe('updateKeyboardShortcut', () => {
  it('overrides a shortcut', () => {
    updateKeyboardShortcut('copy', { key: 'y', modifiers: ['ctrl'] });
    const shortcuts = getKeyboardShortcuts();
    expect(shortcuts['copy'].key).toBe('y');
    expect(shortcuts['copy'].modifiers).toEqual(['ctrl']);
  });

  it('ignores unknown ids', () => {
    expect(() => updateKeyboardShortcut('nonexistent', { key: 'a', modifiers: [] })).not.toThrow();
  });

  it('updates activeKeymap when overrides are applied', () => {
    const before = getActiveKeymap();
    updateKeyboardShortcut('copy', { key: 'y', modifiers: ['ctrl'] });
    const after = getActiveKeymap();
    expect(after).not.toBe(before);
  });

  it('stores a copy of modifiers array', () => {
    const mods = ['ctrl'];
    updateKeyboardShortcut('copy', { key: 'y', modifiers: mods });
    mods.push('shift');
    expect(getKeyboardShortcuts()['copy'].modifiers).toEqual(['ctrl']);
  });
});

describe('shortcutsConflict', () => {
  it('same key and modifiers → conflict', () => {
    expect(shortcutsConflict(
      { key: 'c', modifiers: ['meta'] },
      { key: 'c', modifiers: ['meta'] },
    )).toBe(true);
  });

  it('different key → no conflict', () => {
    expect(shortcutsConflict(
      { key: 'c', modifiers: ['meta'] },
      { key: 'v', modifiers: ['meta'] },
    )).toBe(false);
  });

  it('different modifiers → no conflict', () => {
    expect(shortcutsConflict(
      { key: 'c', modifiers: ['meta'] },
      { key: 'c', modifiers: ['ctrl'] },
    )).toBe(false);
  });

  it('case-insensitive key comparison', () => {
    expect(shortcutsConflict(
      { key: 'C', modifiers: ['meta'] },
      { key: 'c', modifiers: ['meta'] },
    )).toBe(true);
  });

  it('modifier order does not matter', () => {
    expect(shortcutsConflict(
      { key: 'c', modifiers: ['shift', 'meta'] },
      { key: 'c', modifiers: ['meta', 'shift'] },
    )).toBe(true);
  });

  it('extra modifier breaks match', () => {
    expect(shortcutsConflict(
      { key: 'c', modifiers: ['meta'] },
      { key: 'c', modifiers: ['meta', 'shift'] },
    )).toBe(false);
  });
});

describe('findConflict', () => {
  it('finds an existing conflict', () => {
    const copyDefault = DEFAULT_SHORTCUTS['copy'];
    const id = findConflict({ key: copyDefault.key, modifiers: copyDefault.modifiers });
    expect(id).toBe('copy');
  });

  it('returns null when no conflict', () => {
    expect(findConflict({ key: 'z', modifiers: ['ctrl', 'shift', 'meta'] })).toBeNull();
  });

  it('respects excludeId', () => {
    const copyDefault = DEFAULT_SHORTCUTS['copy'];
    const id = findConflict(
      { key: copyDefault.key, modifiers: copyDefault.modifiers },
      'copy',
    );
    expect(id).toBeNull();
  });

  it('detects conflict with user override', () => {
    updateKeyboardShortcut('paste', { key: 'y', modifiers: ['ctrl'] });
    const id = findConflict({ key: 'y', modifiers: ['ctrl'] });
    expect(id).toBe('paste');
  });
});

describe('resetShortcutsToDefaults', () => {
  it('clears overrides', () => {
    updateKeyboardShortcut('copy', { key: 'y', modifiers: ['ctrl'] });
    resetShortcutsToDefaults();
    const shortcuts = getKeyboardShortcuts();
    const copyDefault = DEFAULT_SHORTCUTS['copy'];
    expect(shortcuts['copy'].key).toBe(copyDefault.key);
    expect(shortcuts['copy'].modifiers).toEqual(copyDefault.modifiers);
  });

  it('getShortcutsForSave returns empty after reset', () => {
    updateKeyboardShortcut('copy', { key: 'y', modifiers: ['ctrl'] });
    resetShortcutsToDefaults();
    expect(getShortcutsForSave()).toEqual({});
  });
});

describe('loadShortcutsFromSettings', () => {
  it('loads valid overrides', () => {
    loadShortcutsFromSettings({
      shortcuts: { copy: { key: 'y', modifiers: ['ctrl'] } },
    });
    expect(getKeyboardShortcuts()['copy'].key).toBe('y');
  });

  it('skips entries that match current defaults (stale saves)', () => {
    const copyDefault = DEFAULT_SHORTCUTS['copy'];
    loadShortcutsFromSettings({
      shortcuts: { copy: { key: copyDefault.key, modifiers: [...copyDefault.modifiers] } },
    });
    expect(getShortcutsForSave()).not.toHaveProperty('copy');
  });

  it('ignores unknown ids', () => {
    loadShortcutsFromSettings({
      shortcuts: { 'nonexistent-id': { key: 'a', modifiers: [] } },
    });
    expect(getShortcutsForSave()).toEqual({});
  });

  it('ignores entries without modifiers array', () => {
    expect(() => loadShortcutsFromSettings({
      shortcuts: { copy: { key: 'y' } },
    })).not.toThrow();
    expect(getShortcutsForSave()).toEqual({});
  });

  it('handles null settings gracefully', () => {
    expect(() => loadShortcutsFromSettings(null)).not.toThrow();
    expect(() => loadShortcutsFromSettings({})).not.toThrow();
    expect(() => loadShortcutsFromSettings({ shortcuts: null })).not.toThrow();
  });

  it('clears previous overrides on load', () => {
    updateKeyboardShortcut('copy', { key: 'y', modifiers: ['ctrl'] });
    loadShortcutsFromSettings({});
    expect(getShortcutsForSave()).toEqual({});
  });
});

describe('getShortcutsForSave', () => {
  it('returns empty when no overrides', () => {
    expect(getShortcutsForSave()).toEqual({});
  });

  it('returns only overrides', () => {
    updateKeyboardShortcut('copy', { key: 'y', modifiers: ['ctrl'] });
    const saved = getShortcutsForSave();
    expect(Object.keys(saved)).toEqual(['copy']);
    expect(saved.copy).toEqual({ key: 'y', modifiers: ['ctrl'] });
  });

  it('returns copies of modifiers arrays', () => {
    updateKeyboardShortcut('copy', { key: 'y', modifiers: ['ctrl'] });
    const saved = getShortcutsForSave();
    saved.copy.modifiers.push('shift');
    expect(getShortcutsForSave().copy.modifiers).toEqual(['ctrl']);
  });
});

describe('parseShortcutEvent', () => {
  it('extracts key and modifiers from event', () => {
    const event = { key: 'c', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false };
    const result = parseShortcutEvent(event);
    expect(result.key).toBe('c');
    expect(result.modifiers).toContain('ctrl');
    expect(result.modifiers).not.toContain('meta');
  });

  it('includes all active modifiers', () => {
    const event = { key: 'D', ctrlKey: false, metaKey: true, shiftKey: true, altKey: false };
    const { modifiers } = parseShortcutEvent(event);
    expect(modifiers).toContain('meta');
    expect(modifiers).toContain('shift');
    expect(modifiers).not.toContain('ctrl');
    expect(modifiers).not.toContain('alt');
  });
});

describe('formatShortcut', () => {
  it('formats on linux platform', () => {
    const s = { key: 'c', modifiers: ['meta'] };
    expect(formatShortcut(s, 'linux')).toContain('c');
  });

  it('formats on darwin platform with symbols', () => {
    const s = { key: 'c', modifiers: ['meta'] };
    expect(formatShortcut(s, 'darwin')).toContain('⌘');
  });
});
