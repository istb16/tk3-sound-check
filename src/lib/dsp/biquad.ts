/**
 * 2次IIR（biquad）フィルタ。DOM非依存。
 *
 * FFTではなく時間領域のIIRを持つ理由は2つ。フィルタ状態がチャンクをまたいで
 * 引き継がれるので**終わりの無い監視**に向くこと、出力がそのまま波形なので
 * RMS→dBFS が重み無しの場合と同じ尺度で読めることである。
 *
 * ここにあるのは「アナログの伝達関数を離散化して縦続接続で流す」ための道具だけで、
 * どんな特性を作るか（A特性など）は weighting.ts が持つ。
 */

export interface Biquad {
  b0: number; b1: number; b2: number;
  a1: number; a2: number;
}

/**
 * s平面の2次区間を双一次変換で離散化する。
 * 係数は s^2, s^1, s^0 の順で与える。
 *
 * プリワープはかけていない。そのぶんナイキストに近い極の応答が規格からずれる。
 * 直すならナイキストに近い極をプリワープする。
 */
export function bilinear2(
  bs: [number, number, number],
  as: [number, number, number],
  sampleRate: number,
): Biquad {
  const k = 2 * sampleRate;
  const kk = k * k;
  const [b2s, b1s, b0s] = bs;
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
export function biquadMagnitude(q: Biquad, freqHz: number, sampleRate: number): number {
  const w = (2 * Math.PI * freqHz) / sampleRate;
  const cos1 = Math.cos(-w), sin1 = Math.sin(-w);
  const cos2 = Math.cos(-2 * w), sin2 = Math.sin(-2 * w);
  const nRe = q.b0 + q.b1 * cos1 + q.b2 * cos2;
  const nIm = q.b1 * sin1 + q.b2 * sin2;
  const dRe = 1 + q.a1 * cos1 + q.a2 * cos2;
  const dIm = q.a1 * sin1 + q.a2 * sin2;
  return Math.hypot(nRe, nIm) / Math.hypot(dRe, dIm);
}

/** 縦続接続した全段の周波数応答（振幅）。設計の検証用 */
export function cascadeMagnitude(
  sections: readonly Biquad[], gain: number, freqHz: number, sampleRate: number,
): number {
  let mag = gain;
  for (const s of sections) mag *= biquadMagnitude(s, freqHz, sampleRate);
  return mag;
}

/**
 * biquad の縦続接続。**状態を持つのでチャンクをまたいで連続して流せる。**
 * 受動リアルタイム機能では、これが無いとチャンク境界で不連続が乗る。
 */
export class BiquadCascade {
  private readonly sections: readonly Biquad[];
  private readonly gain: number;
  /** 各段の [x1, x2, y1, y2] */
  private readonly state: Float64Array;

  constructor(sections: readonly Biquad[], gain = 1) {
    this.sections = sections;
    this.gain = gain;
    this.state = new Float64Array(sections.length * 4);
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
