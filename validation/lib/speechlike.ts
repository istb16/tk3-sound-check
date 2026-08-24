/**
 * 音声に似た合成信号。
 *
 * 公開コーパスを取得していない状態でも検証パイプラインを一周させるための
 * ブートストラップ。実音声の代替ではない——DNSMOS との相関(知覚量)には
 * 使えない。ただし「既知の物理量を注入して復元できるか」という検証は
 * 算数なので、この信号でも成立する。
 *
 * 声帯パルス列を3つのフォルマント共振器に通す方式(Klatt型)。
 * 発話区間と無音区間を明確に持つので、SNR推定・残響推定の両方を試せる。
 */

import { makeRng } from './rng.ts';
import { normalizeSpeechLevel } from './degrade.ts';

interface Formant { freq: number; bw: number }

const BASE_FORMANTS: Formant[] = [
  { freq: 500,  bw: 80  },
  { freq: 1500, bw: 100 },
  { freq: 2500, bw: 150 },
];

/** 無音区間のノイズフロア[dBFS]。デジタル無音と誤検出されない現実的な値 */
const NOISE_FLOOR_DBFS = -55;



export function speechLike(
  durationSec: number,
  sampleRate: number,
  seed: number,
): Float32Array {
  const rnd = makeRng(seed);
  const total = Math.floor(durationSec * sampleRate);
  const out = new Float32Array(total);

  let pos = Math.floor(0.25 * sampleRate); // 冒頭に無音を置く

  while (pos < total) {
    const uttLen = Math.floor((0.6 + rnd() * 0.9) * sampleRate);
    const seg = synthUtterance(Math.min(uttLen, total - pos), sampleRate, rnd);
    out.set(seg, pos);
    pos += seg.length + Math.floor((0.25 + rnd() * 0.45) * sampleRate); // 息継ぎの間
  }

  // 全体を通した背景ノイズフロア（無音区間が完全な0にならないように）
  const floor = Math.pow(10, NOISE_FLOOR_DBFS / 20);
  for (let i = 0; i < total; i++) out[i] += (rnd() * 2 - 1) * floor * 1.7;

  // 発話区間のレベルを目標値に合わせる（音量という交絡を除くため）
  return normalizeSpeechLevel(out, sampleRate);
}

/** 1発話ぶんの合成 */
function synthUtterance(len: number, sampleRate: number, rnd: () => number): Float32Array {
  const f0Base = 100 + rnd() * 90;
  const shift  = 0.9 + rnd() * 0.25;   // 話者ごとの声道長の違い
  const formants = BASE_FORMANTS.map((f) => ({ freq: f.freq * shift, bw: f.bw }));

  // ---- 声帯パルス列 ----
  const pulses = new Float32Array(len);
  let phase = 0;
  for (let i = 0; i < len; i++) {
    // ゆるやかなピッチの揺れ
    const f0 = f0Base * (1 + 0.05 * Math.sin((2 * Math.PI * 1.3 * i) / sampleRate));
    phase += f0 / sampleRate;
    if (phase >= 1) { phase -= 1; pulses[i] = 1; }
  }

  // ---- スペクトル傾斜(-6dB/oct 相当)。声帯波形の性質を近似 ----
  let tilt = 0;
  for (let i = 0; i < len; i++) {
    tilt = 0.88 * tilt + pulses[i];
    pulses[i] = tilt;
  }

  // ---- フォルマント共振器 ----
  let sig = pulses;
  for (const f of formants) sig = resonate(sig, f, sampleRate);

  // ---- 音節レベルの振幅変調＋前後のフェード ----
  const sylHz = 3.5 + rnd() * 2.5;
  const fade  = Math.floor(0.02 * sampleRate);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const syl = 0.55 + 0.45 * Math.sin((2 * Math.PI * sylHz * i) / sampleRate);
    let env = syl;
    if (i < fade)           env *= i / fade;
    if (i > len - fade - 1) env *= (len - 1 - i) / fade;
    out[i] = sig[i] * env;
  }
  return out;
}

/** 2極共振器（Klatt型） */
function resonate(data: Float32Array, f: Formant, sampleRate: number): Float32Array {
  const r     = Math.exp((-Math.PI * f.bw) / sampleRate);
  const theta = (2 * Math.PI * f.freq) / sampleRate;
  const b     = 2 * r * Math.cos(theta);
  const c     = -r * r;
  const a     = 1 - b - c; // 定常ゲインを1に揃える

  const out = new Float32Array(data.length);
  let y1 = 0, y2 = 0;
  for (let i = 0; i < data.length; i++) {
    const y = a * data[i] + b * y1 + c * y2;
    out[i] = y;
    y2 = y1;
    y1 = y;
  }
  return out;
}
