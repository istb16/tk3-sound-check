import { describe, expect, it, beforeEach } from 'vitest';
import { initLang, T } from './i18n.ts';

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

describe('T — 翻訳データの完整性', () => {
  it('ja と en が同じキーを持つ', () => {
    expect(Object.keys(T.ja)).toEqual(Object.keys(T.en));
  });

  it('categoryNames が両言語で volume/frequency/clip/noise を持つ', () => {
    const keys = ['volume', 'frequency', 'clip', 'noise'] as const;
    for (const k of keys) {
      expect(T.ja.categoryNames[k]).toBeTruthy();
      expect(T.en.categoryNames[k]).toBeTruthy();
    }
  });

  it('grades が両言語で good/ok/warn/bad を持つ', () => {
    const keys = ['good', 'ok', 'warn', 'bad'] as const;
    for (const k of keys) {
      expect(T.ja.grades[k]).toBeTruthy();
      expect(T.en.grades[k]).toBeTruthy();
    }
  });

  it('radarLabels が両言語で 4 要素を持つ', () => {
    expect(T.ja.radarLabels).toHaveLength(4);
    expect(T.en.radarLabels).toHaveLength(4);
  });

  it('micBtn は秒数を受け取って文字列を返す', () => {
    expect(T.ja.micBtn(15)).toContain('15');
    expect(T.en.micBtn(15)).toContain('15');
  });
});
