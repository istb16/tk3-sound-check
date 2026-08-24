/**
 * 残響推定のデバッグ用スクリプト。
 *
 *   node validation/rt60-diag.ts
 *
 * rt60条件のファイルごとに、検出できた減衰イベント数と、そのRT60分布の
 * パーセンタイルを並べる。どの統計量を採るべきか、閾値をどう動かすかを
 * 決めるために使う（中央値を採る判断はこの出力から出した）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { decodeWav } from './lib/wav.ts';
import { estimateReverb } from '../src/features/quality/estimators.ts';
import { MANIFEST, ROOT } from './lib/paths.ts';

const m = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const pct = (a: number[], p: number) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : NaN;
};
console.log('id             真値   件数   p25    p50    p75    p90');
for (const item of m.items.filter((x: any) => x.condition.type === 'rt60')) {
  const bytes = readFileSync(resolve(ROOT, item.file));
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const wav = decodeWav(ab);
  const e = estimateReverb(wav.samples, wav.sampleRate);
  const f = (v: number) => (Number.isFinite(v) ? v.toFixed(3) : '  -  ').padStart(6);
  console.log(
    '  ' + item.id.padEnd(13) + String(item.truth.rt60Sec).padStart(5) +
    String(e.perEventRt60.length).padStart(6) +
    f(pct(e.perEventRt60, 0.25)) + f(pct(e.perEventRt60, 0.5)) +
    f(pct(e.perEventRt60, 0.75)) + f(pct(e.perEventRt60, 0.9)),
  );
}
