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
 * プリワープをかけていないぶん高域の応答が規格からずれる
 * （8kHz で約0.6dB、12.5kHz で約3dB）。相対比較しかしない用途では実害は無いが、
 * ずれの出どころはここである。
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
