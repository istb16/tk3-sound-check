/**
 * スペクトル上のピークを扱う。DOM非依存。
 *
 * 「そこにピークがあるか」「周辺と比べてどれだけ立っているか」「本当の周波数は
 * ビンのどこか」の3つ。**どれだけ立っていれば何と呼ぶかは決めない**——
 * 閾値は用途ごとに意味が違うので、各機能が絶対値で持つ。
 */

import { powerDb } from './stats.ts';

/**
 * `[lo, hi]` の範囲で最もパワーの大きい極大点のビン番号。無ければ -1。
 *
 * 極大点だけを見るのは、斜面の途中を拾うと広帯域の山を細いピークと
 * 取り違えるためである。
 */
export function findStrongestPeak(
  spectrum: Float32Array, lo: number, hi: number,
): number {
  const from = Math.max(1, lo);
  const to   = Math.min(spectrum.length - 2, hi);

  let best = -1;
  let bestPower = 0;
  for (let k = from; k <= to; k++) {
    if (spectrum[k] <= spectrum[k - 1]) continue;
    if (spectrum[k] < spectrum[k + 1]) continue;
    if (spectrum[k] > bestPower) { bestPower = spectrum[k]; best = k; }
  }
  return best;
}

/**
 * 最大ビンとその両隣の3点で放物線補間し、真の周波数[Hz]を返す。
 * ビン幅より細かい値が出る。
 *
 * dB（対数）で補間する——窓のメインローブは対数軸で放物線に近い。
 */
export function interpolatePeakFreq(
  spectrum: Float32Array, k: number, binHz: number,
): number {
  if (k < 1 || k >= spectrum.length - 1) return k * binHz;
  const d0 = powerDb(spectrum[k - 1]);
  const d1 = powerDb(spectrum[k]);
  const d2 = powerDb(spectrum[k + 1]);
  const denom = d0 - 2 * d1 + d2;
  let delta = denom === 0 ? 0 : (0.5 * (d0 - d2)) / denom;
  if (!Number.isFinite(delta) || delta < -0.5 || delta > 0.5) delta = 0;
  return (k + delta) * binHz;
}

export interface ProminenceOptions {
  /** 近傍の幅をビン番号の何倍にするか（対数軸で一定幅にするため） */
  neighborRatio: number;
  /** 近傍の最小幅[ビン]。高域で痩せないよう下支えする */
  minNeighborBins: number;
  /** ピーク自身とその裾を中央値から外す幅[ビン] */
  guardBins: number;
  /** 片側で最低限必要なビン数。これを割ったら「測れない」とする */
  minSideBins: number;
  /** 近傍に含める最下ビン。これより下は直流と超低域の暴れ */
  floorMinBin: number;
  /** 近傍に含める最上ビン */
  floorMaxBin: number;
}

/**
 * ピークが周辺の中央値から何dB持ち上がっているか。**測れない場合は 0 を返す。**
 *
 * 平均ではなく中央値を使うのは、近傍に別のピークが居ても引きずられないため。
 *
 * **上下それぞれで中央値を取り、大きいほうを床にする。** 片側だけで取ると、
 * スペクトルの傾き（低域ほど大きい）が突出度に化ける。両側の大きいほうを採ると、
 * 傾きの効果は必ず「突出度を小さく見積もる」方向にしか働かなくなる。
 *
 * 片側のビンが足りないときに 0 を返すのは、**その周波数は測れない**のであって
 * 突出していないのではないからである。区別せずに片側だけで測ると、
 * 下端の周波数だけがいつも高い突出度を返すことになる。
 */
export function peakProminenceDb(
  spectrum: Float32Array, k: number, opts: ProminenceOptions,
  scratch?: Float32Array,
): number {
  const buf = scratch && scratch.length >= spectrum.length
    ? scratch
    : new Float32Array(spectrum.length);

  const half = Math.max(opts.minNeighborBins, Math.round(k * opts.neighborRatio));
  const below = sideMedian(
    spectrum, buf,
    Math.max(opts.floorMinBin, k - half), k - opts.guardBins - 1, opts.minSideBins,
  );
  const above = sideMedian(
    spectrum, buf,
    k + opts.guardBins + 1, Math.min(opts.floorMaxBin, k + half), opts.minSideBins,
  );
  if (below === null || above === null) return 0;

  const floor = Math.max(below, above);
  if (floor <= 0) return 0;
  return 10 * Math.log10(spectrum[k] / floor);
}

/** ビン [lo, hi] のパワーの中央値。本数が足りなければ null */
function sideMedian(
  spectrum: Float32Array, buf: Float32Array,
  lo: number, hi: number, minBins: number,
): number | null {
  let n = 0;
  for (let i = lo; i <= hi; i++) buf[n++] = spectrum[i];
  if (n < minBins) return null;
  const sorted = buf.slice(0, n).sort();
  return sorted[n >> 1];
}
