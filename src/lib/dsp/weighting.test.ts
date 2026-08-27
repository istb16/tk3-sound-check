import { describe, expect, it } from 'vitest';
import { AWeightingFilter, aWeightingGainDb } from './weighting.ts';
import { dbfs, rms } from './stats.ts';
import { sine } from '../../test-support/signals.ts';

const SR = 48000;

describe('A特性 — 規格値との一致', () => {
  // IEC 61672 の A特性（1kHz を 0dB とした相対値）
  const STANDARD: [freq: number, db: number, tolerance: number][] = [
    [31.5, -39.4, 0.3],
    [63,   -26.2, 0.3],
    [125,  -16.1, 0.3],
    [250,   -8.6, 0.3],
    [500,   -3.2, 0.3],
    [1000,   0.0, 0.01],
    [2000,   1.2, 0.3],
    [4000,   1.0, 0.3],
    // 双一次変換の周波数歪みで高域ほどずれる。会場での相対比較には影響しないが、
    // 「規格どおり」と誤解しないよう許容差を明示しておく。
    [8000,  -1.1, 1.0],
  ];

  for (const sampleRate of [44100, 48000]) {
    for (const [freq, want, tol] of STANDARD) {
      it(`fs=${sampleRate} / ${freq}Hz が ${want}dB ±${tol}`, () => {
        expect(Math.abs(aWeightingGainDb(freq, sampleRate) - want)).toBeLessThanOrEqual(tol);
      });
    }
  }

  it('1kHz はちょうど 0dB（正規化点）', () => {
    expect(aWeightingGainDb(1000, SR)).toBeCloseTo(0, 6);
  });
});

describe('AWeightingFilter — 実波形での利得', () => {
  /** 立ち上がりの過渡を捨ててから実効値を測る */
  function steadyDb(input: Float32Array, filter: AWeightingFilter): number {
    const out = filter.process(input);
    const skip = Math.round(SR * 0.2);
    return dbfs(rms(out, skip, out.length - skip));
  }

  it('1kHz の正弦波は素通しになる', () => {
    const input = sine(1000, 1, 0.5);
    const inDb = dbfs(rms(input, 0, input.length));
    expect(steadyDb(input, new AWeightingFilter(SR))).toBeCloseTo(inDb, 1);
  });

  it('125Hz は約 -16dB 落ちる', () => {
    const input = sine(125, 1, 0.5);
    const inDb = dbfs(rms(input, 0, input.length));
    const gain = steadyDb(input, new AWeightingFilter(SR)) - inDb;
    expect(gain).toBeGreaterThan(-16.6);
    expect(gain).toBeLessThan(-15.6);
  });

  it('チャンクに分けても連続して流したのと同じ結果になる', () => {
    const input = sine(500, 0.5, 0.4);
    const whole = new AWeightingFilter(SR).process(input);

    const chunked = new AWeightingFilter(SR);
    const parts: number[] = [];
    for (let i = 0; i < input.length; i += 4096) {
      const out = chunked.process(input.subarray(i, Math.min(i + 4096, input.length)));
      for (const v of out) parts.push(v);
    }

    for (let i = 0; i < whole.length; i += 997) {
      expect(parts[i]).toBeCloseTo(whole[i], 6);
    }
  });
});
