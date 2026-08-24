/**
 * DOM非依存の信号処理プリミティブ。
 *
 * AudioAnalyzer / provenance / Node側の検証スクリプト(validation/)の三者で共有する。
 * ここに Web Audio API や DOM への依存を持ち込まないこと。持ち込むと
 * `node validation/validate.ts` が動かなくなる。
 */

export const FFT_SIZE = 2048;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** RMS(振幅) → dBFS変換 */
export function dbfs(amplitude: number): number {
  return 20 * Math.log10(amplitude + 1e-12);
}

export function rms(data: Float32Array, offset: number, len: number): number {
  let sum = 0;
  const end = Math.min(offset + len, data.length);
  const n = end - offset;
  if (n <= 0) return 0;
  for (let i = offset; i < end; i++) sum += data[i] * data[i];
  return Math.sqrt(sum / n);
}

/** frameSize サンプルごとのRMSリスト */
export function frameRmsList(data: Float32Array, frameSize: number): number[] {
  const frames: number[] = [];
  for (let i = 0; i + frameSize <= data.length; i += frameSize) {
    frames.push(rms(data, i, frameSize));
  }
  return frames;
}

/** ソート済み配列からパーセンタイル値を取る (p は 0..1) */
export function percentileSorted(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = clamp(Math.floor(sorted.length * p), 0, sorted.length - 1);
  return sorted[idx];
}

export function percentile(values: number[], p: number): number {
  return percentileSorted([...values].sort((a, b) => a - b), p);
}

// ---- 窓関数 (サイズごとにキャッシュ) ----
const hammingCache = new Map<number, Float32Array>();
const blackmanHarrisCache = new Map<number, Float32Array>();

export function hammingWindow(size: number): Float32Array {
  const cached = hammingCache.get(size);
  if (cached) return cached;
  const win = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    win[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (size - 1));
  }
  hammingCache.set(size, win);
  return win;
}

/**
 * 4項 Blackman-Harris 窓。遠方サイドローブが約 -92dB。
 *
 * 帯域上限の実測にはこちらを使う。ハミング窓(-43dB)ではリーク床が
 * 約 -70dB に居座り、コーデックが削った領域と窓のリークを区別できない。
 * 測定可能なダイナミックレンジは窓で決まる。
 */
export function blackmanHarrisWindow(size: number): Float32Array {
  const cached = blackmanHarrisCache.get(size);
  if (cached) return cached;
  const a0 = 0.35875, a1 = 0.48829, a2 = 0.14128, a3 = 0.01168;
  const win = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const x = (2 * Math.PI * i) / (size - 1);
    win[i] = a0 - a1 * Math.cos(x) + a2 * Math.cos(2 * x) - a3 * Math.cos(3 * x);
  }
  blackmanHarrisCache.set(size, win);
  return win;
}

/**
 * Cooley-Tukey Radix-2 FFT（in-place）。N は2の冪乗であること。
 */
export function fft(re: Float32Array, im: Float32Array): void {
  const N = re.length;

  // ビット反転並べ替え
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }

  // バタフライ演算
  for (let len = 2; len <= N; len <<= 1) {
    const half    = len >> 1;
    const ang     = (2 * Math.PI) / len;
    const wBaseRe = Math.cos(ang);
    const wBaseIm = -Math.sin(ang);

    for (let i = 0; i < N; i += len) {
      let wRe = 1, wIm = 0;
      for (let j = 0; j < half; j++) {
        const uRe = re[i + j];
        const uIm = im[i + j];
        const vRe = re[i + j + half] * wRe - im[i + j + half] * wIm;
        const vIm = re[i + j + half] * wIm + im[i + j + half] * wRe;
        re[i + j]        = uRe + vRe;
        im[i + j]        = uIm + vIm;
        re[i + j + half] = uRe - vRe;
        im[i + j + half] = uIm - vIm;
        const tmp = wRe * wBaseRe - wIm * wBaseIm;
        wIm = wRe * wBaseIm + wIm * wBaseRe;
        wRe = tmp;
      }
    }
  }
}

/**
 * 平均パワースペクトル（Welch法・50%オーバーラップ）。
 * 戻り値は長さ fftSize/2 のビンごとの平均パワー。
 */
export function averagePowerSpectrum(
  data: Float32Array,
  fftSize = FFT_SIZE,
  window: 'hamming' | 'blackman-harris' = 'blackman-harris',
): Float32Array {
  const halfN = fftSize >> 1;
  const spectrum = new Float32Array(halfN);
  const win = window === 'hamming' ? hammingWindow(fftSize) : blackmanHarrisWindow(fftSize);
  const hop = fftSize >> 1;

  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);

  let blocks = 0;
  for (let start = 0; start + fftSize <= data.length; start += hop) {
    for (let i = 0; i < fftSize; i++) {
      re[i] = data[start + i] * win[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < halfN; k++) {
      spectrum[k] += re[k] * re[k] + im[k] * im[k];
    }
    blocks++;
  }

  if (blocks > 0) {
    for (let k = 0; k < halfN; k++) spectrum[k] /= blocks;
  }
  return spectrum;
}

/**
 * パワースペクトルを固定幅(Hz)のバンドに集約し、各バンドの平均パワーを返す。
 */
export function bandPowers(
  spectrum: Float32Array,
  sampleRate: number,
  fftSize: number,
  bandWidthHz: number,
): { powers: Float32Array; bandWidthHz: number } {
  const freqPerBin = sampleRate / fftSize;
  const nyquist    = sampleRate / 2;
  const nBands     = Math.max(1, Math.floor(nyquist / bandWidthHz));
  const powers     = new Float32Array(nBands);
  const counts     = new Int32Array(nBands);

  for (let k = 1; k < spectrum.length; k++) {
    const b = Math.floor((k * freqPerBin) / bandWidthHz);
    if (b >= nBands) break;
    powers[b] += spectrum[k];
    counts[b]++;
  }
  for (let b = 0; b < nBands; b++) {
    if (counts[b] > 0) powers[b] /= counts[b];
  }
  return { powers, bandWidthHz };
}

/**
 * 逆FFT（in-place）。共役を使って順方向FFTを再利用する。
 * 検証スクリプト側の高速畳み込み（残響の注入）で使う。
 */
export function ifft(re: Float32Array, im: Float32Array): void {
  const N = re.length;
  for (let i = 0; i < N; i++) im[i] = -im[i];
  fft(re, im);
  for (let i = 0; i < N; i++) {
    re[i] /= N;
    im[i] = -im[i] / N;
  }
}

/** 有音と見なすレベル範囲。フレームレベルのp95から何dB下までを有音とするか */
export const ACTIVITY_RANGE_DB = 25;

/**
 * 有音フレームだけを対象にした平均パワースペクトル。
 *
 * 無音区間を含めると、そこのノイズフロア（広帯域でほぼ平坦）が帯域バランスの
 * 分母に混ざる。間の多い録音ほど「低音も高音も均等にある」ように見えてしまうため、
 * 帯域バランスの評価には発話しているフレームだけを使う。
 *
 * 有音の判定はフレームレベルのp95から ACTIVITY_RANGE_DB 下まで（ITU-T P.56 の
 * 有効音声レベルの考え方）。有音フレームが無い場合は全フレームで代替する。
 */
export function activePowerSpectrum(
  data: Float32Array,
  fftSize = FFT_SIZE,
  windowKind: 'hamming' | 'blackman-harris' = 'hamming',
): Float32Array | null {
  const halfN = fftSize >> 1;
  const hop = fftSize >> 1;
  if (data.length < fftSize) return null;

  // ---- 1周目: フレームごとのレベルから有音の閾値を決める ----
  const starts: number[] = [];
  const levels: number[] = [];
  for (let start = 0; start + fftSize <= data.length; start += hop) {
    starts.push(start);
    levels.push(rms(data, start, fftSize));
  }
  if (starts.length === 0) return null;

  const p95 = percentile(levels, 0.95);
  const threshold = p95 * Math.pow(10, -ACTIVITY_RANGE_DB / 20);

  // ---- 2周目: 有音フレームだけを加算する ----
  const spectrum = new Float32Array(halfN);
  const win = windowKind === 'hamming' ? hammingWindow(fftSize) : blackmanHarrisWindow(fftSize);
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);

  let blocks = 0;
  for (let f = 0; f < starts.length; f++) {
    if (levels[f] < threshold) continue;
    const start = starts[f];
    for (let i = 0; i < fftSize; i++) {
      re[i] = data[start + i] * win[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < halfN; k++) spectrum[k] += re[k] * re[k] + im[k] * im[k];
    blocks++;
  }

  if (blocks === 0) return averagePowerSpectrum(data, fftSize, windowKind);
  for (let k = 0; k < halfN; k++) spectrum[k] /= blocks;
  return spectrum;
}

