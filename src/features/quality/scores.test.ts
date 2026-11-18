import { describe, expect, it } from 'vitest';
import { gradeCls, scoreColor, segColor, SEGMENTS } from './scores.ts';

describe('gradeCls', () => {
  it('70 以上は good', () => {
    expect(gradeCls(70)).toBe('good');
    expect(gradeCls(100)).toBe('good');
  });

  it('50〜69 は ok', () => {
    expect(gradeCls(50)).toBe('ok');
    expect(gradeCls(69)).toBe('ok');
  });

  it('35〜49 は warn', () => {
    expect(gradeCls(35)).toBe('warn');
    expect(gradeCls(49)).toBe('warn');
  });

  it('34 以下は bad', () => {
    expect(gradeCls(0)).toBe('bad');
    expect(gradeCls(34)).toBe('bad');
  });
});

describe('scoreColor', () => {
  it('good スコアはティール色', () => expect(scoreColor(80)).toBe('var(--score-good)'));
  it('ok スコアはアンバー色',   () => expect(scoreColor(60)).toBe('var(--score-ok)'));
  it('warn スコアはオリーブ色', () => expect(scoreColor(40)).toBe('var(--score-warn)'));
  it('bad スコアはレッド色',    () => expect(scoreColor(10)).toBe('var(--score-bad)'));

  it('境界値 70 は good カラー', () => expect(scoreColor(70)).toBe('var(--score-good)'));
  it('境界値 50 は ok カラー',   () => expect(scoreColor(50)).toBe('var(--score-ok)'));
  it('境界値 35 は warn カラー', () => expect(scoreColor(35)).toBe('var(--score-warn)'));
});

describe('segColor', () => {
  it('セグメント 0〜6 はレッド',   () => expect(segColor(0)).toBe('var(--score-bad)'));
  it('セグメント 6 はレッド',      () => expect(segColor(6)).toBe('var(--score-bad)'));
  it('セグメント 7 はアンバー',    () => expect(segColor(7)).toBe('var(--score-ok)'));
  it('セグメント 9 はアンバー',    () => expect(segColor(9)).toBe('var(--score-ok)'));
  it('セグメント 10 はオリーブ',   () => expect(segColor(10)).toBe('var(--score-warn)'));
  it('セグメント 13 はオリーブ',   () => expect(segColor(13)).toBe('var(--score-warn)'));
  it('セグメント 14 はティール',   () => expect(segColor(14)).toBe('var(--score-good)'));
  it('セグメント 19 はティール',   () => expect(segColor(19)).toBe('var(--score-good)'));
});

describe('SEGMENTS', () => {
  it('20 である', () => expect(SEGMENTS).toBe(20));
});
