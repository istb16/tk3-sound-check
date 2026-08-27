/**
 * 画面に出す数値の整形。
 *
 * 単位や語順は機能によって違うので、ここに置くのは「数値をどう見せるか」だけで、
 * ラベルや単位語は各機能の i18n が持つ。
 */

/**
 * 周波数の表示。1kHz以上は kHz にする。
 *
 * 有効数字はビン幅より細かい桁を出さない程度に留める。実際より精密に見える
 * 数字を出すと、それを信じてEQのQを絞りすぎることになる。
 */
export function formatFrequency(freqHz: number): string {
  if (freqHz >= 1000) return `${(freqHz / 1000).toFixed(2)} kHz`;
  return `${Math.round(freqHz)} Hz`;
}

/**
 * 符号つきの固定小数。**符号を必ず付ける**——「+」が無いと、上がったのか
 * 下がったのかを読み違える。0 は「±0.0」にして、符号が抜けたのではなく
 * 変化が無いことを示す。
 */
export function formatSigned(value: number, digits = 1): string {
  const scale = Math.pow(10, digits);
  const rounded = Math.round(value * scale) / scale;
  // -0.0 を避ける
  const v = Object.is(rounded, -0) ? 0 : rounded;
  return `${v > 0 ? '+' : v < 0 ? '' : '±'}${v.toFixed(digits)}`;
}

/** 0〜1 に丸めた比率。バーの長さに使う */
export function ratio(value: number, full: number): number {
  if (!Number.isFinite(value) || value <= 0 || full <= 0) return 0;
  return Math.min(1, value / full);
}
