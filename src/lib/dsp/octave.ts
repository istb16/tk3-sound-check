/**
 * オクターブバンド（ISO 266 の中心周波数）。DOM非依存。
 *
 * ここが知っているのは「オクターブバンドとは何か」だけである。
 * **どのバンドを表示するかは各機能が決める**——測れるかどうかはFFT長と
 * サンプルレートで決まるので、測れないバンドの箱だけを並べないためには
 * 機能側が絞り込む必要がある。
 */

/** ISO のオクターブ中心周波数[Hz]。可聴域ぶん */
export const OCTAVE_CENTERS_HZ = [
  16, 31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000,
] as const;

/** 中心周波数に対する下端の比（1/√2） */
export const OCTAVE_LOWER_RATIO = Math.pow(2, -0.5);
/** 中心周波数に対する上端の比（√2） */
export const OCTAVE_UPPER_RATIO = Math.pow(2, 0.5);

export interface BandEdges {
  lowHz: number;
  highHz: number;
}

export function octaveBandEdges(centerHz: number): BandEdges {
  return {
    lowHz:  centerHz * OCTAVE_LOWER_RATIO,
    highHz: centerHz * OCTAVE_UPPER_RATIO,
  };
}

/**
 * 周波数が属するバンドの中心[Hz]。与えたバンド表の外なら null。
 *
 * バンド表を引数に取るのは、機能ごとに扱う範囲が違うためである。
 */
export function octaveBandOf(
  freqHz: number, centers: readonly number[] = OCTAVE_CENTERS_HZ,
): number | null {
  for (const c of centers) {
    if (freqHz >= c * OCTAVE_LOWER_RATIO && freqHz < c * OCTAVE_UPPER_RATIO) return c;
  }
  return null;
}

/** バンド名の表示。1000以上は kHz にする（グライコの目盛りに合わせる） */
export function formatOctaveBand(centerHz: number): string {
  return centerHz >= 1000 ? `${centerHz / 1000}k` : `${centerHz}`;
}
