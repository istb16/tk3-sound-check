/**
 * 開発時のMOSオラクル（任意）。
 *
 * 位置づけ: **製品には載せない。** 判定を丸ごとモデルに委ねると、アドバイス機能の
 * 根拠と説明可能性が失われる。ここでの用途は「自分のスコアの並び順が、人間の
 * 主観評価で学習されたモデルの並び順とどれだけ一致しているか」を測り、
 * 係数を調整する方向を得ることだけ。
 *
 * これにより、自分で音声にラベル付けをしなくても「精度が上がった」を数値で
 * 言えるようになる。正解は公開コーパスで学習済みのモデル側が持っている。
 *
 * 必要なもの（どちらも既定のインストールには含めない）:
 *   1. モデル: npm run fetch-mos-model
 *   2. ランタイム: npm i -D onnxruntime-node
 *
 * どちらか欠けていれば MOS 相関の算出をスキップし、理由を報告する。
 * 検証の主軸（既知の物理量の復元誤差）はモデル無しで成立する。
 *
 * 入出力の仕様は DNS-Challenge の dnsmos_local.py に合わせている:
 *   - 16kHz モノラル
 *   - 1回の推論に 9.01秒 (144160サンプル) を入れる。入力名は input_1、形状 [1, N]
 *   - 出力は [SIG, BAK, OVRL] の生値。1秒ホップで窓を進めて平均する
 *   - 生値には多項式補正をかける（順位相関には影響しないが、値を読めるようにする）
 */

import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { MODELS_DIR } from './lib/paths.ts';
import { resample } from './lib/dsp.ts';

/** DNSMOS は16kHzのモノラルを前提とする */
const MODEL_SR = 16000;
/** 1回の推論に入れる長さ[秒]。DNSMOS の学習時のセグメント長 */
const SEGMENT_SEC = 9.01;
/** 窓を進める間隔[秒] */
const HOP_SEC = 1;
/** OVRL の多項式補正係数（非パーソナライズ版） */
const OVRL_POLY = [-0.06766283, 1.11546468, 0.04602535];

export interface MosOracle {
  note: string;
  score: (samples: Float32Array, sampleRate: number) => Promise<number | null>;
}

function findModel(): string | null {
  const fromEnv = process.env.MOS_MODEL;
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : null;
  if (!existsSync(MODELS_DIR)) return null;
  const onnx = readdirSync(MODELS_DIR).filter((f) => f.endsWith('.onnx')).sort();
  return onnx.length > 0 ? resolve(MODELS_DIR, onnx[0]) : null;
}

/** 多項式を評価する（係数は次数の高い順） */
function polyval(coeffs: number[], x: number): number {
  return coeffs.reduce((acc, c) => acc * x + c, 0);
}

/**
 * 9.01秒に足りない音声は、元の音声を繰り返して埋める。
 * dnsmos_local.py と同じ扱い（ゼロ埋めではない——無音はモデルの入力分布から外れる）。
 */
function padByRepeat(data: Float32Array, needed: number): Float32Array {
  if (data.length >= needed) return data;
  const out = new Float32Array(needed);
  for (let i = 0; i < needed; i++) out[i] = data[i % data.length];
  return out;
}

async function prepare(): Promise<MosOracle | null> {
  const modelPath = findModel();
  if (!modelPath) {
    console.warn('MOSオラクル無効: モデルが見つかりません。npm run fetch-mos-model を実行してください。');
    return null;
  }

  let ort: typeof import('onnxruntime-node');
  try {
    ort = await import('onnxruntime-node');
  } catch {
    console.warn('MOSオラクル無効: onnxruntime-node が未インストールです（npm i -D onnxruntime-node）。');
    return null;
  }

  let session: Awaited<ReturnType<typeof ort.InferenceSession.create>>;
  try {
    session = await ort.InferenceSession.create(modelPath);
  } catch (e) {
    console.warn(`MOSオラクル無効: モデルの読み込みに失敗しました (${String(e)})`);
    return null;
  }

  const inputName  = session.inputNames[0];
  const outputName = session.outputNames[0];
  const segLen = Math.floor(MODEL_SR * SEGMENT_SEC);
  const hopLen = Math.floor(MODEL_SR * HOP_SEC);

  return {
    note: `${modelPath} (入力 ${inputName} / 出力 ${outputName} / ${SEGMENT_SEC}秒 ${MODEL_SR}Hz)`,
    score: async (samples, sampleRate) => {
      const mono = padByRepeat(resample(samples, sampleRate, MODEL_SR), segLen);
      const scores: number[] = [];

      for (let start = 0; start + segLen <= mono.length; start += hopLen) {
        const seg = mono.slice(start, start + segLen);
        try {
          const feeds = { [inputName]: new ort.Tensor('float32', seg, [1, segLen]) };
          const out = await session.run(feeds);
          const data = out[outputName].data as Float32Array | Float64Array;
          // 出力は [SIG, BAK, OVRL]。総合(OVRL)を使う。
          const ovrRaw = Number(data[2]);
          scores.push(polyval(OVRL_POLY, ovrRaw));
        } catch (e) {
          console.warn(`MOS推論に失敗: ${String(e)}`);
          return null;
        }
      }

      if (scores.length === 0) return null;
      return scores.reduce((s, v) => s + v, 0) / scores.length;
    },
  };
}

export const scoreMos = { prepare };
