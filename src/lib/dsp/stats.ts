/**
 * 数値と統計のプリミティブ。DOM非依存。
 *
 * ここに置くのは「音そのものの知識を持たない計算」だけ——丸め、実効値、
 * パーセンタイル、直線あてはめ。周波数やスペクトルの概念が入るものは
 * spectrum.ts / peaks.ts へ置く。
 *
 * DOM・Web Audio API への依存を持ち込まないこと。持ち込むと
 * `node validation/validate.ts` が動かなくなる。
 */

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

/**
 * パワー（振幅の二乗）→ dB変換。
 *
 * 下限の 1e-20（=-200dB）は**動かしてはいけない定数**である。この値を使う側
 * （provenance.ts の帯域上限、estimators.ts の周波数傾斜）は、`CLIFF_DB` や
 * `EMPTY_BAND_GAP_DB` のような**絶対dBの閾値で較正されている**。
 * 一度 1e-30 にしたところ、パワーが厳密に0のバンドが -300dB を返し、
 * 走査範囲の最大最小差が100dB広がって「帯域上限にナイキストを返す」経路が開いた。
 */
export function powerDb(power: number): number {
  return 10 * Math.log10(power + 1e-20);
}

/**
 * 標準偏差（母集団・÷n）。
 *
 * 標本標準偏差(÷n-1)ではない。ここでの用途は「観測した列がどれだけ散らばって
 * いるか」の記述であって、母集団の推定ではないため。
 */
export function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  let sum = 0;
  for (const v of values) sum += (v - mean) * (v - mean);
  return Math.sqrt(sum / values.length);
}

/** 移動平均。窓は中央合わせ、端は詰める */
export function movingAverage(values: number[], window: number): number[] {
  const half = Math.floor(window / 2);
  const out = new Array<number>(values.length);
  for (let i = 0; i < values.length; i++) {
    const from = Math.max(0, i - half);
    const to   = Math.min(values.length, i + half + 1);
    let sum = 0;
    for (let j = from; j < to; j++) sum += values[j];
    out[i] = sum / (to - from);
  }
  return out;
}

export interface LineFit {
  /** 傾き（yの単位 / xの単位） */
  slope: number;
  intercept: number;
  /** 決定係数。あてはまりの良さ */
  r2: number;
}

/**
 * 最小二乗による直線あてはめ。xが等間隔でない場合はこちらを使う。
 * 傾きが定まらない（xがすべて同じ）場合は null を返す。
 */
export function linearRegression(xs: number[], ys: number[]): LineFit | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;

  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n, my = sy / n;

  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (sxx === 0) return null;

  const slope = sxy / sxx;
  return {
    slope,
    intercept: my - slope * mx,
    // yが動かない列に「あてはまりの良さ」は定義できない。0 とする
    r2: syy === 0 ? 0 : (sxy * sxy) / (sxx * syy),
  };
}

/**
 * `values[from, to)` を y、`(index - from) * xStep` を x として直線をあてはめる。
 * 等間隔にサンプルされた列（時間軸のレベル列など）用の薄い包み。
 */
export function linearFit(
  values: number[], from: number, to: number, xStep: number,
): LineFit {
  const n = to - from;
  const xs = new Array<number>(Math.max(0, n));
  const ys = new Array<number>(Math.max(0, n));
  for (let k = 0; k < n; k++) { xs[k] = k * xStep; ys[k] = values[from + k]; }
  return linearRegression(xs, ys) ?? { slope: 0, intercept: values[from] ?? 0, r2: 0 };
}

/**
 * chunk[offset, offset+length) に、絶対値が threshold 以上のサンプルがあるか。
 *
 * 「割れているか」の判定はこれ1つで済むが、**閾値は呼び出し側が持つ**。
 * 音質チェックは採点の尺度、ボリュームは会場の目安、ハウリングは
 * 「この道具がいま正しく動いていない」の自己申告で、すべて尺度が違う。
 * 定数を共有すると、片方を動かしたときにもう片方が黙って壊れる。
 */
export function anyAbove(
  data: Float32Array, offset: number, length: number, threshold: number,
): boolean {
  const end = Math.min(offset + length, data.length);
  for (let i = offset; i < end; i++) {
    const v = data[i];
    if (v >= threshold || v <= -threshold) return true;
  }
  return false;
}

/**
 * `data[offset, offset+length)` の絶対値の最大。
 *
 * `anyAbove` を閾値ごとに何度も走らせる代わりに使う。呼び出し側が
 * 「割れている」「限界に近い」「波高はいくつか」を**同じ一度の走査**から
 * 導けるようにするためで、閾値を増やしても走査は増えない。
 */
export function maxAbs(data: Float32Array, offset: number, length: number): number {
  const end = Math.min(offset + length, data.length);
  let m = 0;
  for (let i = offset; i < end; i++) {
    const v = data[i] < 0 ? -data[i] : data[i];
    if (v > m) m = v;
  }
  return m;
}
