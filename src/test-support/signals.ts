/**
 * 検証用の合成信号。**テスト専用**（製品コードからは import しない）。
 *
 * 推定器の検証に人手のラベル付けが要らないのは、ここで注入した物理量が
 * そのまま真値になるからである。したがってここに置くのは
 * 「測りたいものが入っている信号」と「入っていないが紛らわしい信号」の両方で、
 * 後者のほうが重要になる——空振りを重く見る以上、測るべきは再現率より適合率だから。
 *
 * 置き場所が `src/lib/` ではなく `src/test-support/` なのは、製品に載る層と
 * 載らない層を物理的に分けておくためである。
 */

/** 既定のサンプルレート。製品のマイク録音に合わせる */
export const DEFAULT_SAMPLE_RATE = 48000;

/** 素の正弦波。包絡もノイズも無い */
export function sine(
  freqHz: number, seconds: number, amplitude: number,
  sampleRate = DEFAULT_SAMPLE_RATE,
): Float32Array {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  }
  return out;
}

/** 線形合同法。テストの再現性のため乱数を固定する */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function gaussian(rand: () => number): number {
  // Box-Muller。片方だけ使う
  const u = Math.max(1e-12, rand());
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * ピンクノイズ。Voss-McCartney ではなく一次のIIR近似で足りる——
 * ここで欲しいのは「低域が持ち上がった広帯域のノイズ」であって、
 * 正確な -3dB/oct ではない。
 */
export function pinkNoise(n: number, rms: number, seed: number): Float32Array {
  const rand = rng(seed);
  const out = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < n; i++) {
    const w = gaussian(rand);
    b0 = 0.99765 * b0 + w * 0.0990460;
    b1 = 0.96300 * b1 + w * 0.2965164;
    b2 = 0.57000 * b2 + w * 1.0526913;
    out[i] = b0 + b1 + b2 + w * 0.1848;
  }
  return scaleToRms(out, rms);
}

/** 白色ノイズ */
export function whiteNoise(n: number, rms: number, seed: number): Float32Array {
  const rand = rng(seed);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = gaussian(rand);
  return scaleToRms(out, rms);
}

function scaleToRms(data: Float32Array, target: number): Float32Array {
  let sum = 0;
  for (const v of data) sum += v * v;
  const cur = Math.sqrt(sum / data.length);
  if (cur === 0) return data;
  const g = target / cur;
  for (let i = 0; i < data.length; i++) data[i] *= g;
  return data;
}

export interface ToneOptions {
  /** 鳴き始め[秒] */
  startSec?: number;
  /** 鳴っている長さ[秒]。省略すると最後まで */
  durationSec?: number;
  /** 立ち上がり・立ち下がりの時間[秒]。ハウリングは瞬間には立たない */
  rampSec?: number;
}

/** 正弦波を既存の波形に足す */
export function addTone(
  data: Float32Array,
  sampleRate: number,
  freqHz: number,
  amplitude: number,
  opts: ToneOptions = {},
): Float32Array {
  const start = Math.round((opts.startSec ?? 0) * sampleRate);
  const len = opts.durationSec === undefined
    ? data.length - start
    : Math.round(opts.durationSec * sampleRate);
  const ramp = Math.max(1, Math.round((opts.rampSec ?? 0.02) * sampleRate));
  const end = Math.min(data.length, start + len);

  for (let i = start; i < end; i++) {
    const t = i - start;
    const fadeIn  = Math.min(1, t / ramp);
    const fadeOut = Math.min(1, (end - i) / ramp);
    const env = Math.min(fadeIn, fadeOut);
    data[i] += amplitude * env * Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  }
  return data;
}

/**
 * 倍音列を足す。歌声・楽器・電源ハムの代わり。
 *
 * ハウリングとの違いはここにしか無い——どちらも細いピークとして持続する。
 * 倍音を伴うかどうかだけが分かれ目である。
 */
export function addHarmonicStack(
  data: Float32Array,
  sampleRate: number,
  fundamentalHz: number,
  amplitude: number,
  partials: number,
  opts: ToneOptions & { vibratoHz?: number; vibratoCents?: number } = {},
): Float32Array {
  const start = Math.round((opts.startSec ?? 0) * sampleRate);
  const len = opts.durationSec === undefined
    ? data.length - start
    : Math.round(opts.durationSec * sampleRate);
  const ramp = Math.max(1, Math.round((opts.rampSec ?? 0.03) * sampleRate));
  const end = Math.min(data.length, start + len);
  const vibHz = opts.vibratoHz ?? 0;
  const vibCents = opts.vibratoCents ?? 0;

  for (let n = 1; n <= partials; n++) {
    const f = fundamentalHz * n;
    if (f >= sampleRate / 2) break;
    const a = amplitude / n; // 1/n の倍音列。声にも楽器にも近い
    let phase = 0;
    for (let i = start; i < end; i++) {
      const t = (i - start) / sampleRate;
      const cents = vibCents * Math.sin(2 * Math.PI * vibHz * t);
      const inst = f * Math.pow(2, cents / 1200);
      phase += (2 * Math.PI * inst) / sampleRate;
      const fadeIn  = Math.min(1, (i - start) / ramp);
      const fadeOut = Math.min(1, (end - i) / ramp);
      data[i] += a * Math.min(fadeIn, fadeOut) * Math.sin(phase);
    }
  }
  return data;
}

/** 拍手・机を叩く音。突出はするが持続しない */
export function addImpulses(
  data: Float32Array,
  sampleRate: number,
  timesSec: number[],
  amplitude: number,
  seed: number,
): Float32Array {
  const rand = rng(seed);
  const decay = Math.round(0.012 * sampleRate); // 12ms で減衰
  for (const t of timesSec) {
    const start = Math.round(t * sampleRate);
    for (let i = 0; i < decay; i++) {
      const k = start + i;
      if (k >= data.length) break;
      data[k] += amplitude * Math.exp(-i / (decay / 4)) * (rand() * 2 - 1);
    }
  }
  return data;
}

/** 端末のマイクの飽和。大きなハウリングで実際に起きる */
export function clipHard(data: Float32Array, ceiling = 1): Float32Array {
  for (let i = 0; i < data.length; i++) {
    data[i] = Math.max(-ceiling, Math.min(ceiling, data[i]));
  }
  return data;
}

/** 秒数ぶんの無音バッファ */
export function silence(seconds: number, sampleRate = DEFAULT_SAMPLE_RATE): Float32Array {
  return new Float32Array(Math.round(sampleRate * seconds));
}
