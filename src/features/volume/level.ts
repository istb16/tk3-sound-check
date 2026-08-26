/**
 * ボリュームチェックの測定。DOM非依存。
 *
 * 会場でPAから流れている音を客席で拾い、ミキサーを調整するための相対レベル計。
 * **絶対音圧(dBA)は出さない。** ブラウザはマイクの感度を知らないので、dBFS からの
 * 換算は原理的に不可能である。したがってここが返すのは「フルスケールに対する
 * A特性重み付けレベル」であり、それ自体には意味が無い。意味を持つのは差だけ。
 */

import { dbfs } from '../../lib/signal.ts';

/** 表示とLeqの更新間隔。バーの手応えと計算量の折り合い */
export const FRAME_MS = 100;
/** 比較に使う等価レベルの窓。PAの音は瞬間ごとに10dB以上揺れるので平均で見る */
export const LEQ_WINDOW_SEC = 10;
/** 音割れ回数を数える窓。原因を取り除けば自動で消える長さ */
export const CLIP_WINDOW_SEC = 10;
/** ピークホールドの保持時間 */
export const PEAK_HOLD_SEC = 1;

/**
 * クリップとみなす振幅。音質チェックの estimateClipping と同じ値だが、
 * **定数は共有しない**——あちらは採点の尺度、こちらは会場での目安であり、
 * 片方を動かしたときにもう片方が黙って壊れるのを避ける。
 */
const CLIP_THRESHOLD = 0.98;

// ==========================================================================
// A特性
// ==========================================================================

/**
 * A特性フィルタ（IEC 61672）。アナログ伝達関数を双一次変換で離散化した
 * 6次IIR（biquad 3段）。
 *
 * FFTではなく時間領域のIIRにしている理由は2つ。フィルタ状態がチャンクをまたいで
 * 引き継がれるので連続監視に向くこと、出力がそのまま波形なので RMS→dBFS が
 * 重み無しの場合と同じ尺度で読めることである。
 *
 * 極（Hz）: 20.598997 / 107.65265 / 737.86223 / 12194.217
 * 1kHz で 0dB になるよう正規化する。
 */
const F1 = 20.598997;
const F2 = 107.65265;
const F3 = 737.86223;
const F4 = 12194.217;

interface Biquad {
  b0: number; b1: number; b2: number;
  a1: number; a2: number;
}

/**
 * s平面の2次区間を双一次変換で離散化する。
 *
 * プリワープはかけていない。そのぶん高域の応答が規格からずれる
 * （8kHz で約0.6dB、12.5kHz で約3dB）。相対比較しかしないので実害は無いが、
 * ずれの出どころはここである。直すならナイキストに近い極をプリワープする。
 */
function bilinear2(
  bs: [number, number, number],
  as: [number, number, number],
  sampleRate: number,
): Biquad {
  const k = 2 * sampleRate;
  const kk = k * k;
  const [b2s, b1s, b0s] = bs; // s^2, s^1, s^0 の係数
  const [a2s, a1s, a0s] = as;

  const b0 = b2s * kk + b1s * k + b0s;
  const b1 = 2 * (b0s - b2s * kk);
  const b2 = b2s * kk - b1s * k + b0s;

  const a0 = a2s * kk + a1s * k + a0s;
  const a1 = 2 * (a0s - a2s * kk);
  const a2 = a2s * kk - a1s * k + a0s;

  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** biquad 1段の周波数応答（振幅） */
function biquadMagnitude(q: Biquad, freqHz: number, sampleRate: number): number {
  const w = (2 * Math.PI * freqHz) / sampleRate;
  const cos1 = Math.cos(-w), sin1 = Math.sin(-w);
  const cos2 = Math.cos(-2 * w), sin2 = Math.sin(-2 * w);
  const nRe = q.b0 + q.b1 * cos1 + q.b2 * cos2;
  const nIm = q.b1 * sin1 + q.b2 * sin2;
  const dRe = 1 + q.a1 * cos1 + q.a2 * cos2;
  const dIm = q.a1 * sin1 + q.a2 * sin2;
  return Math.hypot(nRe, nIm) / Math.hypot(dRe, dIm);
}

function designAWeighting(sampleRate: number): { sections: Biquad[]; gain: number } {
  const w1 = 2 * Math.PI * F1;
  const w2 = 2 * Math.PI * F2;
  const w3 = 2 * Math.PI * F3;
  const w4 = 2 * Math.PI * F4;

  // H(s) = (w4^2 * s^4) / ((s+w1)^2 (s+w2)(s+w3) (s+w4)^2)
  // 分子の s^4 と分母の重根を、2次区間3つに割り振る。
  const sections = [
    // s^2 / (s+w1)^2
    bilinear2([1, 0, 0], [1, 2 * w1, w1 * w1], sampleRate),
    // s^2 / (s+w4)^2 に w4^2 を掛ける
    bilinear2([w4 * w4, 0, 0], [1, 2 * w4, w4 * w4], sampleRate),
    // 1 / ((s+w2)(s+w3))
    bilinear2([0, 0, 1], [1, w2 + w3, w2 * w3], sampleRate),
  ];

  // 1kHz で 0dB になるよう正規化する
  let mag = 1;
  for (const s of sections) mag *= biquadMagnitude(s, 1000, sampleRate);
  return { sections, gain: mag === 0 ? 1 : 1 / mag };
}

/** 設計はサンプルレートごとに1回で足りる */
const designCache = new Map<number, { sections: Biquad[]; gain: number }>();

function aWeightingDesign(sampleRate: number): { sections: Biquad[]; gain: number } {
  const cached = designCache.get(sampleRate);
  if (cached) return cached;
  const design = designAWeighting(sampleRate);
  designCache.set(sampleRate, design);
  return design;
}

/**
 * A特性フィルタ。状態を持つのでチャンクをまたいで連続して流せる。
 */
export class AWeightingFilter {
  private readonly sections: Biquad[];
  private readonly gain: number;
  /** 各段の [x1, x2, y1, y2] */
  private readonly state: Float64Array;

  constructor(sampleRate: number) {
    const design = aWeightingDesign(sampleRate);
    this.sections = design.sections;
    this.gain = design.gain;
    this.state = new Float64Array(this.sections.length * 4);
  }

  /** in-place ではなく新しい配列を返す */
  process(input: Float32Array): Float32Array {
    const out = new Float32Array(input.length);
    const st = this.state;

    for (let i = 0; i < input.length; i++) {
      let v = input[i];
      for (let s = 0; s < this.sections.length; s++) {
        const q = this.sections[s];
        const o = s * 4;
        const x1 = st[o], x2 = st[o + 1], y1 = st[o + 2], y2 = st[o + 3];
        const y = q.b0 * v + q.b1 * x1 + q.b2 * x2 - q.a1 * y1 - q.a2 * y2;
        st[o] = v; st[o + 1] = x1; st[o + 2] = y; st[o + 3] = y1;
        v = y;
      }
      out[i] = v * this.gain;
    }
    return out;
  }
}

/** 定常正弦波に対するA特性の利得[dB]。設計の検証用 */
export function aWeightingGainDb(freqHz: number, sampleRate: number): number {
  const { sections, gain } = aWeightingDesign(sampleRate);
  let mag = gain;
  for (const s of sections) mag *= biquadMagnitude(s, freqHz, sampleRate);
  return 20 * Math.log10(mag);
}

// ==========================================================================
// メーター
// ==========================================================================

export interface MeterState {
  /** 直近フレームのA特性レベル[dBFS]。バーを動かすための瞬時値 */
  instantDb: number;
  /** 直近 LEQ_WINDOW_SEC の等価レベル[dBFS]。比較に使うのはこちら */
  leqDb: number;
  /** 直近 PEAK_HOLD_SEC の最大瞬時値[dBFS] */
  peakHoldDb: number;
  /**
 * 直近 CLIP_WINDOW_SEC のうち、音割れが含まれていた時間[秒]。
 *
 * 「回数」では数えられない。クリップした波形は半周期ごとに閾値を下回るので、
 * 閾値の再突入を数えると 1kHz の正弦波を3dB突っ込んだだけで10秒間に20000回になる。
 * かといって近接した突入をまとめて「1回」にすると、鳴りっぱなしのときに
 * 移動窓が始点を通り過ぎた時点で0に戻ってしまう。
 * フレーム単位の時間で持てば、単発は 0.1秒、鳴りっぱなしは 10.0秒 と素直に出る。
 */
  clipSeconds: number;
  /** Leq の窓が埋まったか。埋まる前の値は参考値 */
  leqReady: boolean;
  /** 更新されたフレーム数。テストと「まだ測っていない」の判定に使う */
  frames: number;
  /** Leq の窓が埋まるまでの残り秒数。0 なら埋まっている */
  warmupRemainingSec: number;
}

/** 無音（完全な0）のときに返す下限。-Infinity を画面に出さないため */
export const FLOOR_DB = -120;

/**
 * 流れてくるPCMを受け取り、100msごとに測定値を更新する。
 *
 * 設計上の要点は「バーは瞬時値、比較は平均」。PAから流れる音楽や話し声は
 * 瞬間ごとに10dB以上揺れるので、瞬時値どうしを引き算してもフェーダーを
 * 何dB動かせばよいか決まらない。
 */
export class VolumeMeter {
  private readonly filter: AWeightingFilter;
  private readonly frameSize: number;

  /** フレーム未満の端数。波形そのものは要らないので二乗和だけ持つ */
  private pendingLen = 0;
  private pendingSum = 0;
  private pendingClipped = false;

  /** フレームごとのA特性パワー（振幅の二乗平均）。Leq の窓 */
  private readonly powers: number[] = [];
  /** フレームごとの瞬時dB。ピークホールドの窓 */
  private readonly instants: number[] = [];
  /** フレームごとに、そのフレームが音割れを含んでいたか。クリップの窓 */
  private readonly clips: boolean[] = [];

  private readonly leqFrames: number;
  private readonly peakFrames: number;
  private readonly clipFrames: number;

  private frames = 0;

  constructor(sampleRate: number) {
    this.filter = new AWeightingFilter(sampleRate);
    this.frameSize = Math.max(1, Math.round((sampleRate * FRAME_MS) / 1000));
    this.leqFrames = Math.round((LEQ_WINDOW_SEC * 1000) / FRAME_MS);
    this.peakFrames = Math.round((PEAK_HOLD_SEC * 1000) / FRAME_MS);
    this.clipFrames = Math.round((CLIP_WINDOW_SEC * 1000) / FRAME_MS);
  }

  /**
   * PCMチャンクを流し込む。フレームが1つ以上完成したら true を返す
   * （呼び出し側が画面を更新すべきタイミング）。
   */
  push(chunk: Float32Array): boolean {
    // A特性は生の波形にかける。クリップ判定は重み付け前の値で見る——
    // 割れているかどうかは入力段の話であって、聞こえ方の話ではない。
    const weighted = this.filter.process(chunk);
    let completed = false;

    let offset = 0;
    while (offset < chunk.length) {
      const room = this.frameSize - this.pendingLen;
      const take = Math.min(room, chunk.length - offset);

      let sum = 0;
      let clipped = false;
      for (let i = 0; i < take; i++) {
        const w = weighted[offset + i];
        sum += w * w;
        // クリップは重み付け前の値で見る。割れているかどうかは入力段の話であって
        // 聞こえ方の話ではない
        if (Math.abs(chunk[offset + i]) >= CLIP_THRESHOLD) clipped = true;
      }
      this.pendingSum += sum;
      this.pendingClipped = this.pendingClipped || clipped;
      this.pendingLen += take;
      offset += take;

      if (this.pendingLen === this.frameSize) {
        this.commitFrame();
        completed = true;
      }
    }
    return completed;
  }

  private commitFrame(): void {
    const power = this.pendingSum / this.frameSize;
    this.powers.push(power);
    if (this.powers.length > this.leqFrames) this.powers.shift();

    const instant = power > 0 ? dbfs(Math.sqrt(power)) : FLOOR_DB;
    this.instants.push(instant);
    if (this.instants.length > this.peakFrames) this.instants.shift();

    this.clips.push(this.pendingClipped);
    if (this.clips.length > this.clipFrames) this.clips.shift();

    this.pendingSum = 0;
    this.pendingClipped = false;
    this.pendingLen = 0;
    this.frames++;
  }

  get state(): MeterState {
    if (this.frames === 0) {
      return {
        instantDb: FLOOR_DB, leqDb: FLOOR_DB, peakHoldDb: FLOOR_DB,
        clipSeconds: 0, leqReady: false, frames: 0,
        warmupRemainingSec: LEQ_WINDOW_SEC,
      };
    }
    // Leq はパワーの平均を dB にする（dB の平均ではない）
    let sum = 0;
    for (const p of this.powers) sum += p;
    const meanPower = sum / this.powers.length;

    return {
      instantDb:  this.instants[this.instants.length - 1],
      leqDb:      meanPower > 0 ? dbfs(Math.sqrt(meanPower)) : FLOOR_DB,
      peakHoldDb: Math.max(...this.instants),
      clipSeconds: (this.clips.reduce((n, c) => n + (c ? 1 : 0), 0) * FRAME_MS) / 1000,
      leqReady:   this.powers.length >= this.leqFrames,
      frames:     this.frames,
      warmupRemainingSec:
        Math.max(0, (this.leqFrames - this.powers.length) * FRAME_MS) / 1000,
    };
  }
}

/**
 * バーの表示位置(0..1)。
 *
 * 会場では絶対的な「適正位置」が無いので、目盛りは意味を持たない。
 * -70dBFS を左端、0dBFS を右端に置いて、動きが見えることだけを目的にする。
 */
export function barRatio(db: number): number {
  const lo = -70;
  if (!Number.isFinite(db)) return 0;
  return Math.min(1, Math.max(0, (db - lo) / (0 - lo)));
}

/** 差の表示。符号を必ず付ける（+ が無いと上がったのか下がったのか読み違える） */
export function formatDiff(diffDb: number): string {
  const rounded = Math.round(diffDb * 10) / 10;
  // -0.0 を避ける
  const v = Object.is(rounded, -0) ? 0 : rounded;
  return `${v > 0 ? '+' : v < 0 ? '' : '±'}${v.toFixed(1)}`;
}
