import { describe, expect, it } from 'vitest';
import {
  findStrongestPeak, interpolatePeakFreq, peakProminenceDb,
  type ProminenceOptions,
} from './peaks.ts';

const OPTS: ProminenceOptions = {
  neighborRatio: 0.25,
  minNeighborBins: 24,
  guardBins: 6,
  minSideBins: 4,
  floorMinBin: 3,
  floorMaxBin: 511,
};

/** 平坦な床の上に、指定ビンへ山を置いたスペクトル */
function withPeak(size: number, bin: number, power: number, floor = 1): Float32Array {
  const s = new Float32Array(size).fill(floor);
  // メインローブのつもりで両隣も少し持ち上げる
  s[bin - 1] = power * 0.4;
  s[bin]     = power;
  s[bin + 1] = power * 0.4;
  return s;
}

describe('findStrongestPeak — 極大点だけを拾う', () => {
  it('範囲内で最も高い極大点を返す', () => {
    const s = new Float32Array(512).fill(1);
    s[100] = 5; s[200] = 9; s[300] = 7;
    expect(findStrongestPeak(s, 1, 400)).toBe(200);
  });

  it('範囲外の山は見ない', () => {
    const s = new Float32Array(512).fill(1);
    s[100] = 5; s[300] = 9;
    expect(findStrongestPeak(s, 50, 150)).toBe(100);
  });

  it('単調な斜面の途中は拾わない', () => {
    // 斜面を拾うと、広帯域の山を細いピークと取り違える
    const s = new Float32Array(64);
    for (let i = 0; i < 64; i++) s[i] = i;
    expect(findStrongestPeak(s, 1, 60)).toBe(-1);
  });

  it('極大点が無ければ -1', () => {
    expect(findStrongestPeak(new Float32Array(64).fill(1), 1, 60)).toBe(-1);
  });
});

describe('interpolatePeakFreq — ビンより細かい周波数', () => {
  it('左右対称な山では、そのビンの周波数になる', () => {
    const s = withPeak(512, 100, 1000);
    expect(interpolatePeakFreq(s, 100, 10)).toBeCloseTo(1000, 6);
  });

  it('山が右に寄っていれば、周波数も右に寄る', () => {
    const s = withPeak(512, 100, 1000);
    s[101] = 600; // 右隣のほうが高い
    const f = interpolatePeakFreq(s, 100, 10);
    expect(f).toBeGreaterThan(1000);
    expect(f).toBeLessThan(1005); // 半ビン(5Hz)を超えない
  });

  it('補間が半ビンを超える形でも暴れない', () => {
    const s = new Float32Array(512).fill(1);
    s[100] = 10; s[99] = 10; s[101] = 10; // 平坦 → 補間が定まらない
    expect(interpolatePeakFreq(s, 100, 10)).toBe(1000);
  });
});

describe('peakProminenceDb — 周辺からの持ち上がり', () => {
  it('床の10倍のピークは 10dB 持ち上がっている', () => {
    const s = withPeak(512, 200, 10, 1);
    expect(peakProminenceDb(s, 200, OPTS)).toBeCloseTo(10, 6);
  });

  it('床が上がれば突出度は下がる（飽和で歪みが乗った状態）', () => {
    const low  = peakProminenceDb(withPeak(512, 200, 100, 1), 200, OPTS);
    const high = peakProminenceDb(withPeak(512, 200, 100, 10), 200, OPTS);
    expect(high).toBeLessThan(low);
  });

  it('下側のビンが足りない周波数は 0 を返す（測れないと言う）', () => {
    // ここを「突出していない」と混同すると、下端の周波数だけが
    // いつも高い突出度を返す道具になる
    const s = withPeak(512, 8, 1000, 1);
    expect(peakProminenceDb(s, 8, OPTS)).toBe(0);
  });

  it('傾いた床では、高いほうの側を床とみなす', () => {
    // 片側だけで測ると、スペクトルの傾きが突出度に化ける
    const s = new Float32Array(512);
    for (let i = 0; i < 512; i++) s[i] = 100 / (i + 1); // 低域ほど大きい
    const bin = 60;
    s[bin] = 50;
    const both = peakProminenceDb(s, bin, OPTS);
    // 上側（小さい値）だけを床にしたら、これより大きく出るはず
    const aboveOnly = 10 * Math.log10(s[bin] / (100 / (bin + 24)));
    expect(both).toBeLessThan(aboveOnly);
  });

  it('近傍に別のピークが居ても引きずられない（平均ではなく中央値）', () => {
    const s = withPeak(512, 200, 100, 1);
    s[215] = 5000; // 近傍に巨大な別のピーク
    expect(peakProminenceDb(s, 200, OPTS)).toBeCloseTo(20, 6);
  });
});
