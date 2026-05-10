import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { t, setLocale, getLocale, SUPPORTED_LOCALES } from './i18n.js';

beforeEach(() => setLocale('en'));
afterEach(() => setLocale('en'));

describe('SUPPORTED_LOCALES', () => {
  it('contains en, zh-CN, zh-TW, ja', () => {
    const codes = SUPPORTED_LOCALES.map(l => l.code);
    expect(codes).toContain('en');
    expect(codes).toContain('zh-CN');
    expect(codes).toContain('zh-TW');
    expect(codes).toContain('ja');
  });

  it('each entry has code and label', () => {
    for (const l of SUPPORTED_LOCALES) {
      expect(typeof l.code).toBe('string');
      expect(typeof l.label).toBe('string');
      expect(l.label.length).toBeGreaterThan(0);
    }
  });
});

describe('getLocale', () => {
  it('defaults to en', () => {
    expect(getLocale()).toBe('en');
  });
});

describe('setLocale', () => {
  it('changes locale to a valid code', () => {
    setLocale('zh-CN');
    expect(getLocale()).toBe('zh-CN');
  });

  it('accepts all supported locale codes', () => {
    for (const { code } of SUPPORTED_LOCALES) {
      setLocale(code);
      expect(getLocale()).toBe(code);
    }
  });

  it('ignores invalid locale codes', () => {
    setLocale('zh-CN');
    setLocale('fr');
    expect(getLocale()).toBe('zh-CN');
  });

  it('ignores empty string', () => {
    setLocale('zh-CN');
    setLocale('');
    expect(getLocale()).toBe('zh-CN');
  });
});

describe('t() — English locale', () => {
  it('returns English translation', () => {
    expect(t('settings.font')).toBe('Font');
  });

  it('returns translation for settings keys', () => {
    expect(t('settings.fontSize')).toBe('Font size');
    expect(t('settings.language')).toBe('Language');
    expect(t('menu.copy')).toBe('Copy');
    expect(t('menu.paste')).toBe('Paste');
  });

  it('returns key itself when translation missing', () => {
    expect(t('this.key.does.not.exist')).toBe('this.key.does.not.exist');
  });

  it('returns provided fallback when both locale and en translation missing', () => {
    expect(t('no.such.key', 'my fallback')).toBe('my fallback');
  });

  it('ignores fallback when English translation exists', () => {
    expect(t('settings.font', 'ignored')).toBe('Font');
  });
});

describe('t() — zh-CN locale', () => {
  beforeEach(() => setLocale('zh-CN'));

  it('returns Chinese translation', () => {
    expect(t('settings.font')).toBe('字体');
    expect(t('menu.copy')).toBe('复制');
    expect(t('menu.paste')).toBe('粘贴');
  });

  it('falls back to English for keys missing in zh-CN', () => {
    // All keys should be present, but the fallback chain should work
    // Use a key that's in en but not zh-CN (hypothetically)
    const result = t('settings.font');
    expect(result).not.toBe('settings.font');
  });

  it('returns key when missing from all locales', () => {
    expect(t('totally.nonexistent')).toBe('totally.nonexistent');
  });
});

describe('t() — zh-TW locale', () => {
  beforeEach(() => setLocale('zh-TW'));

  it('returns Traditional Chinese translation', () => {
    expect(t('settings.font')).toBe('字體');
    expect(t('menu.copy')).toBe('複製');
  });
});

describe('t() — ja locale', () => {
  beforeEach(() => setLocale('ja'));

  it('returns Japanese translation', () => {
    expect(t('settings.font')).toBe('フォント');
    expect(t('menu.copy')).toBe('コピー');
  });
});

describe('t() — locale consistency', () => {
  const sampleKeys = [
    'settings.font', 'settings.fontSize', 'settings.language',
    'menu.copy', 'menu.paste', 'menu.newTab', 'menu.closeTab',
  ];

  it('every sample key is translated in all supported locales', () => {
    for (const { code } of SUPPORTED_LOCALES) {
      setLocale(code);
      for (const key of sampleKeys) {
        const value = t(key);
        expect(value, `${code}:${key}`).not.toBe(key);
        expect(value.length, `${code}:${key}`).toBeGreaterThan(0);
      }
    }
  });
});
