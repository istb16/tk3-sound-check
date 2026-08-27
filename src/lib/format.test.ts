import { describe, expect, it } from 'vitest';
import { formatFrequency, formatSigned, ratio } from './format.ts';

describe('formatSigned — 符号つきの数値', () => {
  it('プラスには + を付ける', () => {
    // 「+」が無いと、上がったのか下がったのかを読み違える
    expect(formatSigned(4.23)).toBe('+4.2');
    expect(formatSigned(-3.0)).toBe('-3.0');
  });

  it('ゼロは ± で表す（+0.0 とも -0.0 とも書かない）', () => {
    expect(formatSigned(0)).toBe('±0.0');
    expect(formatSigned(-0.01)).toBe('±0.0');
  });

  it('小数桁を指定できる', () => {
    expect(formatSigned(1.234, 2)).toBe('+1.23');
    expect(formatSigned(0, 0)).toBe('±0');
  });
});

describe('formatFrequency — 周波数の表示', () => {
  it('1kHz 以上は kHz にする', () => {
    expect(formatFrequency(3204.2)).toBe('3.20 kHz');
    expect(formatFrequency(1000)).toBe('1.00 kHz');
  });

  it('1kHz 未満は Hz を整数で出す', () => {
    // ビン幅より細かい桁を出すと、実際より精密に見えてEQのQを絞りすぎる
    expect(formatFrequency(221.6)).toBe('222 Hz');
    expect(formatFrequency(999.4)).toBe('999 Hz');
  });
});

describe('ratio — バーの長さ', () => {
  it('0..1 に収まる', () => {
    expect(ratio(-5, 10)).toBe(0);
    expect(ratio(0, 10)).toBe(0);
    expect(ratio(5, 10)).toBe(0.5);
    expect(ratio(20, 10)).toBe(1);
  });

  it('満点が 0 以下なら 0 を返す（0除算にしない）', () => {
    expect(ratio(5, 0)).toBe(0);
    expect(ratio(Number.NaN, 10)).toBe(0);
  });
});
