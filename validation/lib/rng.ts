/**
 * 決定的な乱数生成器 (mulberry32)。
 *
 * 検証セットは再現可能でなければならない。同じ manifest.json から誰でも
 * 同じ劣化音声を再生成できるよう、Math.random は使わない。
 */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** -1..1 の一様乱数 */
export function makeNoiseRng(seed: number): () => number {
  const r = makeRng(seed);
  return () => r() * 2 - 1;
}
