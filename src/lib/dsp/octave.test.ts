import { describe, expect, it } from 'vitest';
import {
  OCTAVE_CENTERS_HZ, formatOctaveBand, octaveBandEdges, octaveBandOf,
} from './octave.ts';

describe('octaveBandEdges — バンドの上下端', () => {
  it('中心の 1/√2 倍と √2 倍', () => {
    const { lowHz, highHz } = octaveBandEdges(1000);
    expect(lowHz).toBeCloseTo(707.1, 1);
    expect(highHz).toBeCloseTo(1414.2, 1);
  });

  it('隣のバンドと隙間なく接する', () => {
    expect(octaveBandEdges(1000).highHz).toBeCloseTo(octaveBandEdges(2000).lowHz, 9);
  });
});

describe('octaveBandOf — 周波数がどのバンドか', () => {
  it('境界で隣のバンドに移る', () => {
    expect(octaveBandOf(2827)).toBe(2000);  // 2000 * √2 = 2828.4
    expect(octaveBandOf(2829)).toBe(4000);
  });

  it('バンド表を絞ると、その外は null になる', () => {
    // 「どのバンドを扱うか」は機能ごとに違う。測れないバンドを外せるようにする
    const narrow = [250, 500, 1000] as const;
    expect(octaveBandOf(220, narrow)).toBe(250);
    expect(octaveBandOf(110, narrow)).toBeNull();
    expect(octaveBandOf(110)).toBe(125); // 既定の表なら 125Hz帯に入る
  });

  it('可聴域の外は null', () => {
    expect(octaveBandOf(5)).toBeNull();
    expect(octaveBandOf(30000)).toBeNull();
  });

  it('既定の表は ISO の中心周波数', () => {
    expect(OCTAVE_CENTERS_HZ).toContain(1000);
    expect(OCTAVE_CENTERS_HZ).toContain(31.5);
  });
});

describe('formatOctaveBand — グライコの目盛りに合わせた表記', () => {
  it('1000以上は kHz にする', () => {
    expect(formatOctaveBand(8000)).toBe('8k');
    expect(formatOctaveBand(1000)).toBe('1k');
    expect(formatOctaveBand(250)).toBe('250');
    expect(formatOctaveBand(31.5)).toBe('31.5');
  });
});
