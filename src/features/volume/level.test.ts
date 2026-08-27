import { describe, expect, it } from 'vitest';
import {
  VolumeMeter, barRatio,
  FLOOR_DB, FRAME_MS, LEQ_WINDOW_SEC, CLIP_WINDOW_SEC,
} from './level.ts';
import { silence, sine } from '../../test-support/signals.ts';

const SR = 48000;

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
  it('バーは 0..1 に収まる', () => {
    expect(barRatio(-120)).toBe(0);
    expect(barRatio(0)).toBe(1);
    expect(barRatio(10)).toBe(1);
    expect(barRatio(-35)).toBeGreaterThan(0);
    expect(barRatio(-35)).toBeLessThan(1);
  });
});
