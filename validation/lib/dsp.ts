/**
 * 検証スクリプト側の重い信号処理。
 * src/lib/signal.ts の FFT を再利用し、製品コードには持ち込まない。
 */

import { fft, ifft } from '../../src/lib/signal.ts';

/**
 * FFT による高速畳み込み（オーバーラップ加算法）。
 * 残響のインパルス応答は数万タップになるため、直接畳み込みでは終わらない。
 */
export function fftConvolve(signal: Float32Array, ir: Float32Array): Float32Array {
  const irLen = ir.length;
  let fftSize = 1;
  while (fftSize < irLen * 4) fftSize <<= 1;
  const blockLen = fftSize - irLen + 1;

  // インパルス応答のスペクトルを1度だけ求める
  const irRe = new Float32Array(fftSize);
  const irIm = new Float32Array(fftSize);
  irRe.set(ir);
  fft(irRe, irIm);

  const out = new Float32Array(signal.length + irLen - 1);
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);

  for (let start = 0; start < signal.length; start += blockLen) {
    const len = Math.min(blockLen, signal.length - start);
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < len; i++) re[i] = signal[start + i];
    fft(re, im);

    for (let k = 0; k < fftSize; k++) {
      const a = re[k], b = im[k], c = irRe[k], d = irIm[k];
      re[k] = a * c - b * d;
      im[k] = a * d + b * c;
    }
    ifft(re, im);

    const upto = Math.min(fftSize, out.length - start);
    for (let i = 0; i < upto; i++) out[start + i] += re[i];
  }

  return out;
}

/** 窓関数付き sinc によるローパスFIR係数 */
export function firLowpass(cutoffHz: number, sampleRate: number, taps = 1023): Float32Array {
  const n = taps % 2 === 0 ? taps + 1 : taps; // 奇数タップで対称に
  const h = new Float32Array(n);
  const fc = cutoffHz / sampleRate;           // 正規化カットオフ (0..0.5)
  const mid = (n - 1) / 2;

  let sum = 0;
  for (let i = 0; i < n; i++) {
    const m = i - mid;
    const sinc = m === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * m) / (Math.PI * m);
    // Blackman窓（サイドローブ -58dB。人工的なカットオフの崖を作るのに十分）
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (n - 1));
    h[i] = sinc * w;
    sum += h[i];
  }
  for (let i = 0; i < n; i++) h[i] /= sum; // DCゲインを1に揃える
  return h;
}

/** 群遅延を補正しつつローパスを適用する */
export function lowpass(data: Float32Array, cutoffHz: number, sampleRate: number): Float32Array {
  const h = firLowpass(cutoffHz, sampleRate);
  const full = fftConvolve(data, h);
  const delay = (h.length - 1) / 2;
  return full.subarray(delay, delay + data.length).slice();
}

/** ピーク正規化（クリッピングの混入を避けるため target は1未満にする） */
export function normalizePeak(data: Float32Array, target = 0.9): Float32Array {
  let peak = 0;
  for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
  if (peak === 0) return data;
  const g = target / peak;
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] * g;
  return out;
}

/** 全体のRMS */
export function rmsAll(data: Float32Array): number {
  let s = 0;
  for (let i = 0; i < data.length; i++) s += data[i] * data[i];
  return Math.sqrt(s / data.length);
}

/**
 * サンプルレート変換。アンチエイリアス用のローパスを掛けてから線形補間で
 * 間引く。MOSモデルへの入力(16kHz固定)を作るためだけに使う。
 */
/**
 * サンプルレート変換。
 *
 * 線形補間だけでは折り返し（下げ変換）も鏡像（上げ変換）も消えないので、
 * どちら向きでも帯域制限を掛ける。上げ変換で鏡像を残すと、元素材には無い
 * 高域成分が乗って帯域上限の検出を狂わせ、検証そのものが無意味になる。
 */
export function resample(data: Float32Array, fromSr: number, toSr: number): Float32Array {
  if (fromSr === toSr) return data;
  const src = toSr < fromSr ? lowpass(data, toSr * 0.45, fromSr) : data;
  const outLen = Math.floor((data.length * toSr) / fromSr);
  const out = new Float32Array(outLen);
  const step = fromSr / toSr;
  for (let i = 0; i < outLen; i++) {
    const x = i * step;
    const i0 = Math.floor(x);
    const i1 = Math.min(i0 + 1, src.length - 1);
    const f = x - i0;
    out[i] = src[i0] * (1 - f) + src[i1] * f;
  }
  return toSr > fromSr ? lowpass(out, fromSr * 0.45, toSr) : out;
}

/** resample() 後に実際に中身が入っている上限周波数 */
export function resampledContentHz(fromSr: number, toSr: number): number {
  return Math.min(fromSr, toSr) * 0.45;
}
