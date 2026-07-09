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
  it('good スコアはティール色', () => expect(scoreColor(80)).toBe('#006E80'));
  it('ok スコアはアンバー色',   () => expect(scoreColor(60)).toBe('#B86000'));
  it('warn スコアはオリーブ色', () => expect(scoreColor(40)).toBe('#5A7800'));
  it('bad スコアはレッド色',    () => expect(scoreColor(10)).toBe('#BF0009'));

  it('境界値 70 は good カラー', () => expect(scoreColor(70)).toBe('#006E80'));
  it('境界値 50 は ok カラー',   () => expect(scoreColor(50)).toBe('#B86000'));
  it('境界値 35 は warn カラー', () => expect(scoreColor(35)).toBe('#5A7800'));
});

describe('segColor', () => {
  it('セグメント 0〜6 はレッド',   () => expect(segColor(0)).toBe('#BF0009'));
  it('セグメント 6 はレッド',      () => expect(segColor(6)).toBe('#BF0009'));
  it('セグメント 7 はアンバー',    () => expect(segColor(7)).toBe('#B86000'));
  it('セグメント 9 はアンバー',    () => expect(segColor(9)).toBe('#B86000'));
  it('セグメント 10 はオリーブ',   () => expect(segColor(10)).toBe('#5A7800'));
  it('セグメント 13 はオリーブ',   () => expect(segColor(13)).toBe('#5A7800'));
  it('セグメント 14 はティール',   () => expect(segColor(14)).toBe('#006E80'));
  it('セグメント 19 はティール',   () => expect(segColor(19)).toBe('#006E80'));
});

describe('SEGMENTS', () => {
  it('20 である', () => expect(SEGMENTS).toBe(20));
});
