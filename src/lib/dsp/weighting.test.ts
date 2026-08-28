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

/**
 * 規格表の丸めた値ではなく、アナログ伝達関数の厳密値と比べる。
 *
 * 上の表は規格の丸め（-39.4 に対し厳密値 -39.52）を吸収するため許容差 0.3dB を
 * 置いているが、それでは**設計が 0.2dB ずれても気づけない**。ここでは実際の
 * 一致度（〜3.15kHz で 0.02dB 以内）を固定して、リグレッションを捕まえる。
 */
describe('A特性 — アナログ厳密値との一致', () => {
  const F1 = 20.598997, F2 = 107.65265, F3 = 737.86223, F4 = 12194.217;

  /** IEC 61672 のA特性を s=jω で評価したもの。1kHz を 0dB に正規化する */
  function exactDb(freqHz: number): number {
    const ratio = (f: number): number => {
      const f2 = f * f;
      return (F4 * F4 * f2 * f2)
        / ((f2 + F1 * F1) * Math.sqrt((f2 + F2 * F2) * (f2 + F3 * F3)) * (f2 + F4 * F4));
    };
    return 20 * Math.log10(ratio(freqHz) / ratio(1000));
  }

  const LOW = [10, 20, 31.5, 63, 125, 250, 500, 1000, 2000, 3150];

  for (const sampleRate of [44100, 48000]) {
    for (const freq of LOW) {
      it(`fs=${sampleRate} / ${freq}Hz が厳密値と 0.02dB 以内`, () => {
        expect(Math.abs(aWeightingGainDb(freq, sampleRate) - exactDb(freq)))
          .toBeLessThanOrEqual(0.02);
      });
    }
  }
});

/**
 * ナイキストに近い側は双一次変換の周波数歪みで規格から大きく外れる。
 *
 * **相対比較には効かないが「規格どおり」ではない。** 規格値を許容差で包むと
 * 差が大きすぎて意味のあるテストにならないので、設計の実測値のほうを固定して、
 * 意図しない変化だけを捕まえる。プリワープをかければ縮む差である。
 */
describe('A特性 — 高域のずれ（規格ではなく設計値を固定する）', () => {
  const DESIGN: [sampleRate: number, freq: number, standard: number, design: number][] = [
    [44100, 12500, -4.25,  -7.62],
    [44100, 16000, -6.71, -15.24],
    [44100, 20000, -9.35, -33.89],
    [48000, 12500, -4.25,  -6.92],
    [48000, 16000, -6.71, -13.14],
    [48000, 20000, -9.35, -25.19],
  ];

  for (const [sampleRate, freq, standard, design] of DESIGN) {
    it(`fs=${sampleRate} / ${freq}Hz は規格 ${standard}dB に対し ${design}dB`, () => {
      expect(aWeightingGainDb(freq, sampleRate)).toBeCloseTo(design, 1);
    });
  }
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
