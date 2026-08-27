/**
 * パワースペクトル。DOM非依存。
 *
 * 「波形の並び」から「周波数ごとのパワー」へ移す層。ここから先（ピークを探す、
 * 帯域に束ねる、傾きを測る）は peaks.ts と各機能が受け持つ。
 */

import { blackmanHarrisWindow, fft, hammingWindow } from './fft.ts';
import { percentile, rms } from './stats.ts';

/**
 * 解析の既定FFT長。音質チェックと検証スクリプトが使う。
 *
 * ハウリングチェックはこれを使わず 4096 を持つ——48kHz でビン幅 23.4Hz だと、
 * 低域で「周辺との差」を測るためのビンが足りないからである。
 * **既定値であって、全機能の共通値ではない。**
 */
export const FFT_SIZE = 2048;

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
