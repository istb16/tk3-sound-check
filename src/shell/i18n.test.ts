import { describe, expect, it, beforeEach } from 'vitest';
import { initLang, saveLang, SHELL } from './i18n.ts';

describe('initLang', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('localStorage に ja がある場合は ja を返す', () => {
    localStorage.setItem('aqc-lang', 'ja');
    expect(initLang()).toBe('ja');
  });

  it('localStorage に en がある場合は en を返す', () => {
    localStorage.setItem('aqc-lang', 'en');
    expect(initLang()).toBe('en');
  });

  it('localStorage が空の場合はブラウザ言語にフォールバックする', () => {
    const result = initLang();
    expect(['ja', 'en']).toContain(result);
  });

  it('localStorage に無効な値がある場合は ja または en を返す', () => {
    localStorage.setItem('aqc-lang', 'fr');
    expect(['ja', 'en']).toContain(initLang());
  });
});

describe('saveLang', () => {
  it('保存した言語を initLang が読み戻す', () => {
    saveLang('en');
    expect(initLang()).toBe('en');
    saveLang('ja');
    expect(initLang()).toBe('ja');
  });
});

describe('SHELL — シェルの文言', () => {
  it('ja と en が同じキーを持つ', () => {
    expect(Object.keys(SHELL.ja)).toEqual(Object.keys(SHELL.en));
  });

  it('全キーが空でない', () => {
    for (const lang of ['ja', 'en'] as const) {
      for (const [key, value] of Object.entries(SHELL[lang])) {
        expect(value, `${lang}.${key}`).toBeTruthy();
      }
    }
  });

  it('英語側に日本語が混ざっていない', () => {
    for (const value of Object.values(SHELL.en)) {
      expect(/[ぁ-ゟ゠-ヿ一-鿿]/.test(value), value).toBe(false);
    }
  });
});
