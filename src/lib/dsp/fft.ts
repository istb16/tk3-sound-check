/**
 * 窓関数と高速フーリエ変換。DOM非依存。
 *
 * 測定可能なダイナミックレンジは窓で決まるので、窓の選択は精度の問題である。
 * 何を測るかによって選ぶ窓が変わるため、既定値はここでは決めない。
 */

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
