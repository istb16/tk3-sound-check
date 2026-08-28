/**
 * 聴感補正（周波数重み付け）。DOM非依存。
 *
 * 「人の耳がどう聞くか」に合わせて測るための層。いまあるのはA特性だけだが、
 * C特性やITU-R 468 を足すならここに並べる。
 */

import { BiquadCascade, bilinear2, cascadeMagnitude, type Biquad } from './biquad.ts';

/**
 * A特性（IEC 61672）の極[Hz]。
 * アナログ伝達関数 H(s) = (w4^2 * s^4) / ((s+w1)^2 (s+w2)(s+w3) (s+w4)^2)
 */
const F1 = 20.598997;
const F2 = 107.65265;
const F3 = 737.86223;
const F4 = 12194.217;

interface Design {
  sections: Biquad[];
  gain: number;
}

function designAWeighting(sampleRate: number): Design {
  const w1 = 2 * Math.PI * F1;
  const w2 = 2 * Math.PI * F2;
  const w3 = 2 * Math.PI * F3;
  const w4 = 2 * Math.PI * F4;

  // 分子の s^4 と分母の重根を、2次区間3つに割り振る
  const sections = [
    // s^2 / (s+w1)^2
    bilinear2([1, 0, 0], [1, 2 * w1, w1 * w1], sampleRate),
    // s^2 / (s+w4)^2 に w4^2 を掛ける
    bilinear2([w4 * w4, 0, 0], [1, 2 * w4, w4 * w4], sampleRate),
    // 1 / ((s+w2)(s+w3))
    bilinear2([0, 0, 1], [1, w2 + w3, w2 * w3], sampleRate),
  ];

  // 1kHz で 0dB になるよう正規化する
  const mag = cascadeMagnitude(sections, 1, 1000, sampleRate);
  return { sections, gain: mag === 0 ? 1 : 1 / mag };
}

/** 設計はサンプルレートごとに1回で足りる */
const designCache = new Map<number, Design>();

function aWeightingDesign(sampleRate: number): Design {
  const cached = designCache.get(sampleRate);
  if (cached) return cached;
  const design = designAWeighting(sampleRate);
  designCache.set(sampleRate, design);
  return design;
}

/**
 * A特性フィルタ。状態を持つのでチャンクをまたいで連続して流せる。
 *
 * プリワープをかけていないぶん高域の応答が規格からずれる。アナログ伝達関数の
 * 厳密値との差の実測値は、fs=48000 / 44100 の順に:
 *
 *   〜3.15kHz  0.01 / 0.02dB      8kHz   0.54 / 0.66dB
 *   4kHz       0.04 / 0.05dB     12.5kHz 2.67 / 3.37dB
 *   5kHz       0.09 / 0.11dB     16kHz   6.43 / 8.53dB
 *   6.3kHz     0.22 / 0.27dB     20kHz  15.84 / 24.54dB
 *
 * 可聴帯域の主要部（〜4kHz）は実質誤差ゼロ、**外れるのはナイキストに近い側だけ**
 * である。プログラム素材のA特性合計に 12kHz 以上が効くことはまず無いので相対比較
 * への実害は無いが、「規格どおり」ではない。直すならナイキストに近い極を
 * プリワープする。
 */
export class AWeightingFilter extends BiquadCascade {
  constructor(sampleRate: number) {
    const { sections, gain } = aWeightingDesign(sampleRate);
    super(sections, gain);
  }
}

/** 定常正弦波に対するA特性の利得[dB]。設計の検証用 */
export function aWeightingGainDb(freqHz: number, sampleRate: number): number {
  const { sections, gain } = aWeightingDesign(sampleRate);
  return 20 * Math.log10(cascadeMagnitude(sections, gain, freqHz, sampleRate));
}
