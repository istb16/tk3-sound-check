/**
 * 既知の物理量を注入する劣化処理。
 *
 * 検証の要点は「自分で決めたパラメータを、推定器が復元できるか」を測ること。
 * 人間のラベル付けは一切発生しない。各関数は劣化後の音声と、
 * 構成上わかっている真の値(truth)を返す。
 */

import { makeNoiseRng } from './rng.ts';
import { separateActiveFrames } from '../../src/lib/estimators.ts';
import { fftConvolve, lowpass, normalizePeak, rmsAll } from './dsp.ts';
import { ifft } from '../../src/lib/signal.ts';

const FRAME_SEC = 0.02;
/** 有音と見なす閾値（フレームレベルのp95から何dB下まで） */
const ACTIVITY_RANGE_DB = 25;

/**
 * 有音区間のRMS。ITU-T P.56 の有効音声レベルの考え方に倣い、
 * 無音を含めた全体RMSではなく発話しているフレームだけを対象にする。
 * SNRの真値の分子はこれで定義する。
 */
export function activeSpeechRms(data: Float32Array, sampleRate: number): number {
  const frameSize = Math.max(1, Math.floor(sampleRate * FRAME_SEC));
  const frames: number[] = [];
  for (let i = 0; i + frameSize <= data.length; i += frameSize) {
    let s = 0;
    for (let j = i; j < i + frameSize; j++) s += data[j] * data[j];
    frames.push(Math.sqrt(s / frameSize));
  }
  if (frames.length === 0) return rmsAll(data);

  const sorted = [...frames].sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  const threshold = p95 * Math.pow(10, -ACTIVITY_RANGE_DB / 20);

  let sum = 0, n = 0;
  for (const f of frames) {
    if (f >= threshold) { sum += f * f; n++; }
  }
  return n === 0 ? rmsAll(data) : Math.sqrt(sum / n);
}

// ==========================================================================
// ノイズ付加（既知SNR）
// ==========================================================================

export type NoiseColor = 'white' | 'pink';

export interface NoiseResult {
  out: Float32Array;
  /**
   * 真のSNR[dB]。素材が元々持っているノイズフロアも分母に含める。
   *
   * 「注入した量」をそのまま真値にしてはいけない。素材自体にノイズフロアが
   * あるため、高いSNRを狙って注入しても実際のSNRはそこで飽和する。
   * これを無視すると、推定器が正しいのに 40dB 条件で -3.8dB の誤差が出ているように
   * 見える（実際に起きた）。実音声コーパスでも同じ問題が起きる。
   */
  trueSnrDb: number;
  /** 指定した注入量[dB]。真値との差が素材のノイズフロアの寄与 */
  requestedSnrDb: number;
  activeSpeechRms: number;
  /** 注入したノイズのRMS */
  noiseRms: number;
  /** 素材が元々持っていたノイズフロアのRMS */
  sourceNoiseRms: number;
}

/**
 * 発話区間の目標レベル[dBFS]。
 * 音量判定の理想帯域(-20〜-14dBFS)の中央に置く。素材のレベルを揃えておかないと、
 * すべての条件に音量という交絡が混ざる（実測で clean 条件の音量が 9/15 だった）。
 */
export const TARGET_SPEECH_DBFS = -17;
/** クリッピングを避けるためのピーク上限 */
export const PEAK_CEILING = 0.95;

/**
 * 発話区間のレベルを目標値に合わせる。ピークが天井を超える場合はピークを優先し、
 * クリッピングという別の劣化を混入させない。
 */
export function normalizeSpeechLevel(data: Float32Array, sampleRate: number): Float32Array {
  const speech = activeSpeechRms(data, sampleRate);
  if (speech <= 0) return data;

  let peak = 0;
  for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
  if (peak === 0) return data;

  let g = Math.pow(10, TARGET_SPEECH_DBFS / 20) / speech;
  if (peak * g > PEAK_CEILING) g = PEAK_CEILING / peak;

  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] * g;
  return out;
}

/**
 * 素材自身のノイズフロア（無音区間のRMS）。
 *
 * 固定パーセンタイル(p10)で取ってはいけない。無音の短い素材では小さな声を
 * 拾ってフロアを過大評価し、真値のSNRが実際より低く出る。推定器と同じ
 * 有音/無音分離を使う。
 */
export function sourceNoiseRms(data: Float32Array, sampleRate: number): number {
  const frameSize = Math.max(1, Math.floor(sampleRate * FRAME_SEC));
  const frames: number[] = [];
  for (let i = 0; i + frameSize <= data.length; i += frameSize) {
    let s = 0;
    for (let j = i; j < i + frameSize; j++) s += data[j] * data[j];
    frames.push(Math.sqrt(s / frameSize));
  }
  if (frames.length === 0) return 0;

  const active = separateActiveFrames(frames);
  let sum = 0, n = 0;
  for (let i = 0; i < frames.length; i++) {
    if (!active[i]) { sum += frames[i] * frames[i]; n++; }
  }
  if (n > 0) return Math.sqrt(sum / n);

  // 分離できない（無音が無い）素材では最も静かなフレームで代替する
  const sorted = [...frames].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.02)];
}

export function addNoise(
  clean: Float32Array,
  sampleRate: number,
  targetSnrDb: number,
  seed: number,
  color: NoiseColor = 'pink',
  /**
   * ノイズを帯域制限する上限[Hz]（省略時は制限しない）。
   *
   * 暗騒音は音声と同じマイクを通って入るので、素材の帯域上限を超えた
   * ところにノイズだけが乗ることは現実には起きない。制限しないと、
   * 帯域制限された素材にノイズを足しただけで「広帯域の録音」に見えて
   * しまい、加工痕跡の検出が意味をなさなくなる。
   */
  contentHz?: number,
): NoiseResult {
  const raw = color === 'white'
    ? whiteNoise(clean.length, seed)
    : pinkNoise(clean.length, seed);
  const noise = contentHz != null && contentHz < sampleRate / 2
    ? lowpass(raw, contentHz, sampleRate)
    : raw;

  const speech = activeSpeechRms(clean, sampleRate);
  const wantNoiseRms = speech / Math.pow(10, targetSnrDb / 20);
  const g = wantNoiseRms / (rmsAll(noise) || 1);

  const out = new Float32Array(clean.length);
  for (let i = 0; i < clean.length; i++) out[i] = clean[i] + noise[i] * g;

  // 素材が元々持っているノイズフロアも分母に入れて真値を出す
  const srcNoise = sourceNoiseRms(clean, sampleRate);
  const srcNoisePower = srcNoise * srcNoise;
  const speechPower = Math.max(speech * speech - srcNoisePower, 1e-20);
  const totalNoisePower = srcNoisePower + wantNoiseRms * wantNoiseRms;

  return {
    out,
    trueSnrDb: 10 * Math.log10(speechPower / totalNoisePower),
    requestedSnrDb: targetSnrDb,
    activeSpeechRms: speech,
    noiseRms: wantNoiseRms,
    sourceNoiseRms: srcNoise,
  };
}

function whiteNoise(len: number, seed: number): Float32Array {
  const rnd = makeNoiseRng(seed);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) out[i] = rnd();
  return out;
}

/** ピンクノイズ (Paul Kellet の近似フィルタ)。実際の室内暗騒音に近い傾き */
function pinkNoise(len: number, seed: number): Float32Array {
  const rnd = makeNoiseRng(seed);
  const out = new Float32Array(len);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < len; i++) {
    const w = rnd();
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.96900 * b2 + w * 0.1538520;
    b3 = 0.86650 * b3 + w * 0.3104856;
    b4 = 0.55000 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.0168980;
    out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return out;
}

// ==========================================================================
// 残響付加（既知RT60）
// ==========================================================================

/**
 * 指数減衰するノイズをインパルス応答として合成する。
 * 振幅エンベロープが rt60 秒で -60dB に達するので、RT60 の真値は構成上既知。
 */
export function makeRir(
  rt60Sec: number,
  sampleRate: number,
  seed: number,
  directToReverb = 0.45,
): Float32Array {
  const len = Math.max(Math.ceil(rt60Sec * 1.2 * sampleRate), Math.ceil(0.1 * sampleRate));
  const ir = new Float32Array(len);
  const rnd = makeNoiseRng(seed);

  // 振幅が rt60 秒で 1/1000 (=-60dB) になる減衰率
  const decay = Math.log(1000) / rt60Sec;
  const predelay = Math.floor(0.005 * sampleRate); // 初期反射までの5ms

  for (let i = predelay; i < len; i++) {
    const t = (i - predelay) / sampleRate;
    ir[i] = rnd() * Math.exp(-decay * t) * directToReverb;
  }
  ir[0] += 1; // 直接音

  return ir;
}

export interface ReverbResult {
  out: Float32Array;
  /** 注入したRT60[秒] */
  trueRt60Sec: number;
  /**
   * インパルス応答から計算した直接音対残響比[dB]。
   *
   * RT60は部屋の性質だが、マイクに届く残響の量はマイク位置（口元からの距離、
   * 壁からの距離）で決まる。了解度に効くのはRT60よりこの比のほうで、同じ部屋でも
   * 近接マイクなら残響はほとんど乗らない。実録音（6畳・近め）でRT60が0.23秒と
   * 部屋の一般値(0.3〜0.5秒)より短く出たのはこれが原因と見られる。
   */
  trueDrrDb: number;
}

/**
 * インパルス応答の直接音対残響比[dB]。
 * 直接音は先頭 predelay サンプルぶん、残響はそれ以降。
 */
export function drrOf(ir: Float32Array, sampleRate: number): number {
  const predelay = Math.floor(0.005 * sampleRate);
  let direct = 0;
  let late = 0;
  for (let i = 0; i < ir.length; i++) {
    if (i < predelay) direct += ir[i] * ir[i];
    else late += ir[i] * ir[i];
  }
  return 10 * Math.log10((direct + 1e-20) / (late + 1e-20));
}

/**
 * インパルス応答の既定の直接音対残響比[dB]。
 *
 * **以前は振幅比 0.45 を既定にしていた。これは DRR で -17〜-19dB に相当し、
 * 大聖堂並みに湿っている。** 実際の録音の DRR は次のあたり:
 *   近接マイク(10〜30cm)          +15 〜 +25 dB
 *   卓上・ノートPCのマイク(50cm〜1m) +5 〜 +15 dB
 *   部屋の向こうのマイク(2〜3m)     -5 〜 +5 dB
 *
 * 振幅比で指定すると、同じ値でもRT60によってDRRが変わってしまう（尾の長さが
 * 変わるため）。物理量で指定して、合成後に実測したDRRを真値にする。
 */
export const DEFAULT_DRR_DB = 10;

/**
 * 目標のDRRになるよう残響成分の振幅を求める。
 * 振幅を2倍にすると残響エネルギーは4倍（=6dB）なので解析的に解ける。
 */
function amplitudeForDrr(
  rt60Sec: number,
  sampleRate: number,
  seed: number,
  targetDrrDb: number,
): number {
  const probeAmp = 0.45;
  const probe = makeRir(rt60Sec, sampleRate, seed, probeAmp);
  const probeDrr = drrOf(probe, sampleRate);
  // DRR は振幅の2乗に反比例する → 必要な倍率は 10^((probeDrr - target)/20)
  return probeAmp * Math.pow(10, (probeDrr - targetDrrDb) / 20);
}

export function applyReverb(
  clean: Float32Array,
  sampleRate: number,
  rt60Sec: number,
  seed: number,
  /** 目標の直接音対残響比[dB]。マイク位置に相当する */
  targetDrrDb = DEFAULT_DRR_DB,
): ReverbResult {
  const amp = amplitudeForDrr(rt60Sec, sampleRate, seed, targetDrrDb);
  const ir = makeRir(rt60Sec, sampleRate, seed, amp);
  const wet = fftConvolve(clean, ir).subarray(0, clean.length).slice();
  // 残響を足すとレベルが上がるので、元のピークに揃えてレベル要因を排除する
  let peak = 0;
  for (let i = 0; i < clean.length; i++) peak = Math.max(peak, Math.abs(clean[i]));
  return {
    out: normalizePeak(wet, peak),
    trueRt60Sec: rt60Sec,
    trueDrrDb: drrOf(ir, sampleRate),
  };
}

// ==========================================================================
// クリッピング（既知のクリップ率）
// ==========================================================================

export interface ClipResult {
  out: Float32Array;
  /** 全サンプルに対するクリップ率（注入の定義） */
  trueClipRateAll: number;
  /** 有音サンプル(|x|>0.01)に対するクリップ率（推定器の定義） */
  trueClipRateActive: number;
  gain: number;
}

export function applyClipping(data: Float32Array, targetRateAll: number): ClipResult {
  // 目標の割合だけがしきい値を超えるようにゲインを決める
  const abs = Float32Array.from(data, Math.abs).sort();
  const idx = Math.min(abs.length - 1, Math.max(0, Math.floor(abs.length * (1 - targetRateAll))));
  const pivot = abs[idx] || 1;
  const gain = 1 / pivot;

  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = Math.max(-1, Math.min(1, data[i] * gain));
  }

  // 実際に達成された割合を数え直して真値とする
  let clipped = 0, active = 0;
  for (let i = 0; i < out.length; i++) {
    const a = Math.abs(out[i]);
    if (a > 0.01) active++;
    if (a >= 0.98) clipped++;
  }

  return {
    out,
    trueClipRateAll: clipped / out.length,
    trueClipRateActive: active === 0 ? 0 : clipped / active,
    gain,
  };
}

// ==========================================================================
// 帯域制限（既知のカットオフ）
// ==========================================================================

export interface LowpassResult {
  out: Float32Array;
  trueCutoffHz: number;
}

export function applyLowpass(
  data: Float32Array,
  sampleRate: number,
  cutoffHz: number,
): LowpassResult {
  return { out: lowpass(data, cutoffHz, sampleRate), trueCutoffHz: cutoffHz };
}

// ==========================================================================
// スペクトルの傾き（こもり）
// ==========================================================================

/**
 * スペクトルの傾きを注入する（帯域は削らない）。
 *
 * 帯域制限（applyLowpass）とは別の劣化。マイクを服の下に入れた、机の下に置いた、
 * 口から遠いといった「こもり」は、帯域上限を切るのではなく高域を緩やかに落とす。
 * 周波数軸の「明瞭度」内訳はこれを捉えるためにあるが、検証条件が無かった。
 *
 * ヒンジ周波数より上を dbPerOct[dB/oct] で落とす直線位相FIRを、目標振幅特性の
 * 逆FFTから作る。真値は注入した傾きそのものなので、構成上既知。
 */
export function tiltFilter(
  dbPerOct: number,
  sampleRate: number,
  hingeHz: number,
  taps = 1023,
): Float32Array {
  const n = 4096; // 特性を作るFFT長（タップ数より十分大きく取る）
  const re = new Float32Array(n);
  const im = new Float32Array(n);

  for (let k = 0; k <= n / 2; k++) {
    const f = (k * sampleRate) / n;
    const gainDb = f <= hingeHz ? 0 : dbPerOct * Math.log2(f / hingeHz);
    const g = Math.pow(10, gainDb / 20);
    re[k] = g;
    if (k > 0 && k < n / 2) { re[n - k] = g; }
  }

  ifft(re, im);

  // 中心に寄せて窓を掛け、奇数タップの直線位相FIRにする
  const m = taps % 2 === 0 ? taps + 1 : taps;
  const half = (m - 1) / 2;
  const h = new Float32Array(m);
  for (let i = 0; i < m; i++) {
    const idx = (i - half + n) % n;
    // Blackman窓
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (m - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (m - 1));
    h[i] = re[idx] * w;
  }
  return h;
}

export interface TiltResult {
  out: Float32Array;
  /** 注入した傾き[dB/oct]。負なら高域が落ちる */
  trueTiltDbPerOct: number;
  hingeHz: number;
}

/** ヒンジ周波数。これより下は触らない（母音の基本帯域を保つ） */
export const TILT_HINGE_HZ = 1000;

export function applyTilt(
  clean: Float32Array,
  sampleRate: number,
  dbPerOct: number,
): TiltResult {
  const h = tiltFilter(dbPerOct, sampleRate, TILT_HINGE_HZ);
  const full = fftConvolve(clean, h);
  const delay = (h.length - 1) / 2;
  const wet = full.subarray(delay, delay + clean.length).slice();
  // 傾きを掛けると全体レベルが下がるので、発話レベルを戻して音量要因を混ぜない
  return {
    out: normalizeSpeechLevel(wet, sampleRate),
    trueTiltDbPerOct: dbPerOct,
    hingeHz: TILT_HINGE_HZ,
  };
}

// ==========================================================================
// 音量レベル
// ==========================================================================

export interface LevelResult {
  out: Float32Array;
  /** 実際に到達した有効音声レベル[dBFS]。要求値とはピーク制限でずれる */
  trueActiveSpeechDbfs: number;
  requestedDbfs: number;
  /** ピーク上限に当たって要求値に届かなかったか */
  peakLimited: boolean;
}

/**
 * 有効音声レベルを指定値に合わせる。
 *
 * 音量軸には検証条件が無く、周波数軸で見つけたのと同じ穴だった（採点はあるのに
 * それを動かす条件が生成されていない）。真値は「実際に到達したレベル」——
 * 高いレベルを要求してもピーク上限に当たって届かないため、要求値ではなく実測値。
 */
export function applyLevel(
  clean: Float32Array,
  sampleRate: number,
  targetDbfs: number,
): LevelResult {
  const speech = activeSpeechRms(clean, sampleRate);
  if (speech <= 0) {
    return { out: clean, trueActiveSpeechDbfs: -Infinity, requestedDbfs: targetDbfs, peakLimited: false };
  }

  let peak = 0;
  for (let i = 0; i < clean.length; i++) peak = Math.max(peak, Math.abs(clean[i]));

  let g = Math.pow(10, targetDbfs / 20) / speech;
  let peakLimited = false;
  if (peak * g > PEAK_CEILING) { g = PEAK_CEILING / peak; peakLimited = true; }

  const out = new Float32Array(clean.length);
  for (let i = 0; i < clean.length; i++) out[i] = clean[i] * g;

  return {
    out,
    trueActiveSpeechDbfs: 20 * Math.log10(activeSpeechRms(out, sampleRate)),
    requestedDbfs: targetDbfs,
    peakLimited,
  };
}
