/**
 * 1ファイルのスペクトルを覗くデバッグ用スクリプト。
 *
 *   node validation/inspect.ts <wavファイル> [開始バンド] [終了バンド] [刻み]
 *
 * バンド幅は100Hz。表示はピーク比[dB]。帯域上限の検出が期待どおり動かない
 * ときに、遷移域がどこにあるかを目で確認するために使う。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { decodeWav } from './lib/wav.ts';
import { averagePowerSpectrum, bandPowers, FFT_SIZE } from '../src/lib/signal.ts';
import { ROOT } from './lib/paths.ts';

const file = process.argv[2];
const bytes = readFileSync(resolve(ROOT, file));
const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
const wav = decodeWav(ab);
console.log(`file=${file} sr=${wav.sampleRate} n=${wav.samples.length} bits=${wav.sourceBitDepth} ch=${wav.sourceChannels}`);

const spec = averagePowerSpectrum(wav.samples, FFT_SIZE);
const { powers } = bandPowers(spec, wav.sampleRate, FFT_SIZE, 100);
const levels = Array.from(powers, (p) => 10 * Math.log10(p + 1e-20));
const max = Math.max(...levels);
console.log(`bands=${levels.length}`);
const from = Number(process.argv[3] ?? 0);
const to   = Number(process.argv[4] ?? levels.length);
const step = Number(process.argv[5] ?? 5);
for (let b = from; b < Math.min(to, levels.length); b += step) {
  console.log(`  band${String(b).padStart(3)}  ${String(b * 100).padStart(6)}Hz  ${(levels[b] - max).toFixed(1)}`);
}
