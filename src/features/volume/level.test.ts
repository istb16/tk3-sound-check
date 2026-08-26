import { describe, expect, it } from 'vitest';
import {
  AWeightingFilter, VolumeMeter, aWeightingGainDb, barRatio, formatDiff,
  FLOOR_DB, FRAME_MS, LEQ_WINDOW_SEC, CLIP_WINDOW_SEC,
} from './level.ts';
import { dbfs, rms } from '../../lib/signal.ts';

const SR = 48000;

function sine(freqHz: number, seconds: number, amplitude: number, sampleRate = SR): Float32Array {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  return out;
}

function silence(seconds: number, sampleRate = SR): Float32Array {
  return new Float32Array(Math.round(seconds * sampleRate));
}

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

describe('VolumeMeter — フレーム化', () => {
  it('1フレーム分たまるまで更新しない', () => {
    const meter = new VolumeMeter(SR);
    const frameSize = (SR * FRAME_MS) / 1000;

    expect(meter.push(sine(1000, 0.05, 0.5))).toBe(false);
    expect(meter.state.frames).toBe(0);

    expect(meter.push(new Float32Array(frameSize / 2))).toBe(true);
    expect(meter.state.frames).toBe(1);
  });

  it('チャンク境界がフレーム境界と揃っていなくても数が合う', () => {
    const meter = new VolumeMeter(SR);
    const total = sine(1000, 1, 0.5);
    for (let i = 0; i < total.length; i += 1000) {
      meter.push(total.subarray(i, Math.min(i + 1000, total.length)));
    }
    expect(meter.state.frames).toBe(1000 / FRAME_MS);
  });

  it('無音では下限を返す（-Infinity を画面に出さない）', () => {
    const meter = new VolumeMeter(SR);
    meter.push(silence(0.5));
    expect(meter.state.instantDb).toBe(FLOOR_DB);
    expect(meter.state.leqDb).toBe(FLOOR_DB);
  });
});

describe('VolumeMeter — レベル', () => {
  it('1kHz 正弦波の Leq が実効値と一致する（A特性の利得0の周波数）', () => {
    const meter = new VolumeMeter(SR);
    const input = sine(1000, 2, 0.5);
    meter.push(input);
    // 振幅0.5の正弦波の実効値は 0.3536 → -9.03dBFS
    expect(meter.state.leqDb).toBeCloseTo(-9.03, 1);
  });

  it('Leq はdBの平均ではなくパワーの平均（大きいほうに引かれる）', () => {
    const meter = new VolumeMeter(SR);
    meter.push(sine(1000, LEQ_WINDOW_SEC / 2, 0.5));   // -9.03dB
    meter.push(sine(1000, LEQ_WINDOW_SEC / 2, 0.05));  // -29.0dB

    const leq = meter.state.leqDb;
    // dBの単純平均なら -19dB 付近になるが、パワー平均では -12dB 付近に寄る
    expect(leq).toBeGreaterThan(-13);
    expect(leq).toBeLessThan(-11);
  });

  it('窓が埋まるまで leqReady は false', () => {
    const meter = new VolumeMeter(SR);
    meter.push(sine(1000, LEQ_WINDOW_SEC - 1, 0.5));
    expect(meter.state.leqReady).toBe(false);

    meter.push(sine(1000, 1, 0.5));
    expect(meter.state.leqReady).toBe(true);
  });

  it('ピークホールドは直近1秒の最大値', () => {
    const meter = new VolumeMeter(SR);
    meter.push(sine(1000, 0.2, 0.5));
    const afterLoud = meter.state.peakHoldDb;

    meter.push(sine(1000, 0.5, 0.01));
    // まだ1秒たっていないので大きいほうを保持している
    expect(meter.state.peakHoldDb).toBeCloseTo(afterLoud, 5);

    meter.push(sine(1000, 1.0, 0.01));
    expect(meter.state.peakHoldDb).toBeLessThan(afterLoud - 20);
  });
});

describe('VolumeMeter — 音割れ', () => {
  /** 前後を無音で挟んだクリップの塊を1つ作る */
  function burst(clipSamples: number): Float32Array {
    const out = new Float32Array(clipSamples + 200);
    for (let i = 0; i < clipSamples; i++) out[100 + i] = 0.99;
    return out;
  }

  /** amplitude 倍に振り切らせた正弦波（実機の過大入力に近い形） */
  function overdriven(freqHz: number, seconds: number, drive: number): Float32Array {
    const raw = sine(freqHz, seconds, drive);
    const out = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = Math.max(-1, Math.min(1, raw[i]));
    return out;
  }

  it('単発のクリップは1フレーム分の時間として出る', () => {
    const meter = new VolumeMeter(SR);
    meter.push(burst(50));
    meter.push(silence(0.5));
    expect(meter.state.clipSeconds).toBeCloseTo(FRAME_MS / 1000, 6);
  });

  it('割れっぱなしなら窓いっぱいの時間になる', () => {
    // 「回数」で数えると、クリップした波形は半周期ごとに閾値を下回るため
    // 1kHz を3dB突っ込んだだけで10秒間に20000回になってしまう。
    // 時間で持てば「10秒のうち10秒」と素直に出る。
    const meter = new VolumeMeter(SR);
    meter.push(overdriven(1000, CLIP_WINDOW_SEC, 1.41));
    expect(meter.state.clipSeconds).toBeCloseTo(CLIP_WINDOW_SEC, 1);
  });

  it('割れている時間が長いほど大きい値になる', () => {
    const light = new VolumeMeter(SR);
    light.push(overdriven(1000, 1, 1.41));
    light.push(silence(4));

    const heavy = new VolumeMeter(SR);
    heavy.push(overdriven(1000, 5, 1.41));

    expect(heavy.state.clipSeconds).toBeGreaterThan(light.state.clipSeconds);
    expect(light.state.clipSeconds).toBeCloseTo(1, 1);
    expect(heavy.state.clipSeconds).toBeCloseTo(5, 1);
  });

  it('チャンクをまたいだクリップを二重に数えない', () => {
    const meter = new VolumeMeter(SR);
    const frameSize = (SR * FRAME_MS) / 1000;
    const half = new Float32Array(frameSize / 2).fill(0.99);
    meter.push(half);
    meter.push(half);
    meter.push(silence(0.5));
    expect(meter.state.clipSeconds).toBeCloseTo(FRAME_MS / 1000, 6);
  });

  it('窓を過ぎると自動的に消える（直したことが伝わる）', () => {
    const meter = new VolumeMeter(SR);
    meter.push(burst(50));
    meter.push(silence(1));
    expect(meter.state.clipSeconds).toBeGreaterThan(0);

    meter.push(silence(CLIP_WINDOW_SEC));
    expect(meter.state.clipSeconds).toBe(0);
  });

  it('A特性の重み付け前の値でクリップを見る', () => {
    // 60Hz はA特性で30dB以上落ちるが、入力段では割れている。
    // 重み付け後の波形で判定していたら見逃す。
    const meter = new VolumeMeter(SR);
    meter.push(sine(60, 0.3, 1.0));
    expect(meter.state.clipSeconds).toBeGreaterThan(0);
  });
});

describe('VolumeMeter — 窓が埋まるまで', () => {
  it('残り時間が減っていき、埋まるとゼロになる', () => {
    const meter = new VolumeMeter(SR);
    expect(meter.state.warmupRemainingSec).toBe(LEQ_WINDOW_SEC);

    meter.push(sine(1000, 4, 0.5));
    expect(meter.state.warmupRemainingSec).toBeCloseTo(LEQ_WINDOW_SEC - 4, 5);

    meter.push(sine(1000, LEQ_WINDOW_SEC, 0.5));
    expect(meter.state.warmupRemainingSec).toBe(0);
    expect(meter.state.leqReady).toBe(true);
  });
});

describe('表示の整形', () => {
  it('差には必ず符号が付く', () => {
    expect(formatDiff(4.23)).toBe('+4.2');
    expect(formatDiff(-3.0)).toBe('-3.0');
  });

  it('ゼロは ± で表す（+0.0 とも -0.0 とも書かない）', () => {
    expect(formatDiff(0)).toBe('±0.0');
    expect(formatDiff(-0.01)).toBe('±0.0');
  });

  it('バーは 0..1 に収まる', () => {
    expect(barRatio(-120)).toBe(0);
    expect(barRatio(0)).toBe(1);
    expect(barRatio(10)).toBe(1);
    expect(barRatio(-35)).toBeGreaterThan(0);
    expect(barRatio(-35)).toBeLessThan(1);
  });
});
