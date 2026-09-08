/**
 * ボリュームチェックの有音ゲートと、基準スペクトルの照合を実測する。
 *
 *   node validation/volume-gate.ts
 *
 * 測るものは4つ。
 *
 * 1. **喋りの密度によるバイアス** — 同じレベルの声を、密に喋る区間で基準に取り、
 *    間の多い区間と比べたときに出る差。フェーダーには触れていないので真値は 0dB。
 *    これが issue の症状そのものであり、ゲートを入れる理由である。
 * 2. **ゲート幅の走査** — 幅を振って「発話を取り落とす率」と「間を有音と誤る率」を
 *    出す。BGM を敷いた条件も並べる（会場では声の下に BGM が鳴っている）。
 * 3. **スペクトル距離** — 基準（ある話者の声）と、別の発話・別の話者・BGM・拍手の
 *    距離。**同じ話者の別発話と話者交代では超えず、拍手と BGM では超える**幅を探す。
 * 4. **レベル不変性** — 同じ音源のままフェーダーを動かしても形が変わらないこと。
 *    変わるようならスペクトル照合はフェーダー操作で誤爆する。
 *
 * **拍手と BGM は合成の代用である。** 実会場の録音（声＋BGM＋拍手）は持っていない。
 * 代用は本物より分離しやすい側に外れるので、しきい値は検出する側（黙る側）に倒して
 * 置くこと。実素材が手に入ったら測り直す。声だけは実音声（CMU Arctic）を使うので、
 * ゲートの数字は代用の影響を受けない。
 *
 * 出力: validation/volume-gate.md （git管理下）
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { decodeWav } from './lib/wav.ts';
import { resample } from './lib/dsp.ts';
import { makeNoiseRng } from './lib/rng.ts';
import { speechLike } from './lib/speechlike.ts';
import { ROOT } from './lib/paths.ts';
import { AWeightingFilter } from '../src/lib/dsp/weighting.ts';
import { blackmanHarrisWindow, fft } from '../src/lib/dsp/fft.ts';
import { dbfs } from '../src/lib/dsp/stats.ts';
import {
  FRAME_MS, GATE_HISTORY_SEC, ACTIVE_RANGE_DB, SHAPE_DISTANCE_DB,
  gateThresholdDb, shapeOf, shapeDistanceDb,
} from '../src/features/volume/level.ts';

const SR = 48000;
const FRAME = (SR * FRAME_MS) / 1000;
const CORPUS = resolve(ROOT, 'fixtures/corpus');
const OUT = resolve(ROOT, 'validation/volume-gate.md');

const SHAPE_FFT = 2048;
const SHAPE_BANDS_HZ = [250, 500, 1000, 2000, 4000, 8000];

// ==========================================================================
// 素材
// ==========================================================================

function corpusFiles(speaker: string): string[] {
  if (!existsSync(CORPUS)) return [];
  return readdirSync(CORPUS)
    .filter((f) => f.startsWith(`cmu-arctic-files-${speaker}-`) && f.endsWith('.wav'))
    .sort();
}

function loadUtterance(name: string): Float32Array {
  const buf = readFileSync(join(CORPUS, name));
  const wav = decodeWav(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  return wav.sampleRate === SR ? wav.samples : resample(wav.samples, wav.sampleRate, SR);
}

/**
 * 発話の前後にある無音を落とす。**真値を正直にするための処理である。**
 *
 * コーパスの1本には前後に無音が付いている。それを「発話」と数えると、ゲートが
 * 正しく無音を外しても「取り落とし」に見える。落とす基準はその発話自身のピークから
 * 30dB 下——**素材そのものに対する操作**であって、判定の規則ではない。
 */
function trimSilence(data: Float32Array): Float32Array {
  const win = Math.round(SR * 0.02);
  const levels: number[] = [];
  for (let f = 0; f + win <= data.length; f += win) {
    let s = 0;
    for (let k = f; k < f + win; k++) s += data[k] * data[k];
    levels.push(Math.sqrt(s / win));
  }
  const peak = Math.max(...levels, 0);
  if (peak === 0) return data;
  const floor = peak * Math.pow(10, -30 / 20);
  let lo = levels.findIndex((v) => v >= floor);
  let hi = levels.length - 1;
  while (hi > lo && levels[hi] < floor) hi--;
  if (lo < 0) return data;
  return data.subarray(lo * win, Math.min(data.length, (hi + 1) * win));
}

/**
 * 発話と間を並べた「話し声」。**どこが間かを真値として返す。**
 *
 * 有音／無音の真値を推定器から取ると、規則が近いぶん自分で自分を採点することになる。
 * 素材をこちらで組み立てれば、挿入した間の位置は疑いようがない。
 *
 * **間はデジタルの無音にしない。** 会場の間には暗騒音がある。完全な無音で埋めると
 * パワー平均は間をほとんど無視するので（0を足しても平均はほぼ動かない）、
 * **ゲートが無くても症状が出ない素材**になる。実際そう作って測ったら、ゲートの
 * 有無で差が出なかった。
 */
interface Talk {
  samples: Float32Array;
  /** フレームごとに、そこが「挿入した間」か */
  gapFrame: boolean[];
}

function buildTalk(
  speaker: string, gapSec: number, seconds: number,
  opts: { rms?: number; roomBelowDb?: number; seed?: number } = {},
): Talk {
  const rms = opts.rms ?? 0.05;
  const roomBelowDb = opts.roomBelowDb ?? -20;
  const files = corpusFiles(speaker);
  const parts: Array<{ data: Float32Array; gap: boolean }> = [];
  let total = 0;
  let i = 0;
  while (total < seconds * SR && files.length > 0) {
    const utt = trimSilence(loadUtterance(files[i % files.length]));
    parts.push({ data: utt, gap: false });
    total += utt.length;
    const gap = new Float32Array(Math.round(gapSec * SR));
    parts.push({ data: gap, gap: true });
    total += gap.length;
    i++;
  }

  const n = Math.min(total, Math.round(seconds * SR));
  const samples = new Float32Array(n);
  const gapAt = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    for (let k = 0; k < p.data.length && at < n; k++, at++) {
      samples[at] = p.data[k];
      gapAt[at] = p.gap ? 1 : 0;
    }
  }

  // 発話部分の実効値を揃える。間の長さで全体の実効値が変わるのを避ける
  let sum = 0;
  let cnt = 0;
  for (let k = 0; k < n; k++) if (!gapAt[k]) { sum += samples[k] * samples[k]; cnt++; }
  const cur = cnt > 0 ? Math.sqrt(sum / cnt) : 0;
  const g = cur === 0 ? 0 : rms / cur;
  for (let k = 0; k < n; k++) samples[k] *= g;

  // フレームは「半分以上が間なら間」とする
  const gapFrame: boolean[] = [];
  for (let f = 0; f + FRAME <= n; f += FRAME) {
    let gaps = 0;
    for (let k = f; k < f + FRAME; k++) gaps += gapAt[k];
    gapFrame.push(gaps * 2 >= FRAME);
  }

  // 暗騒音を全体に敷く。間だけに入れると境目が不自然になるので全域に足す。
  //
  // **客席のざわめき（音声に似た信号）を使う。** ピンクノイズだとA特性で大きく
  // 削られてしまい、どれだけ上げてもゲートを脅かさない——ゲート幅を選ぶための
  // 試験にならない。会場の間に鳴っているのも、実際そちらである。
  const dry = { samples, gapFrame };
  const speechDb = speechADb(dry);
  const murmur = atAWeightedLevel(
    speechLike(n / SR, SR, opts.seed ?? 101).subarray(0, n), speechDb, roomBelowDb,
  );
  for (let k = 0; k < n; k++) samples[k] += murmur[k] ?? 0;

  return { samples, gapFrame };
}

/** ピンクノイズ。BGM の代用 */
function pinkNoise(n: number, rms: number, seed: number): Float32Array {
  const rnd = makeNoiseRng(seed);
  const out = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < n; i++) {
    const w = rnd() * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.0990460;
    b1 = 0.96300 * b1 + w * 0.2965164;
    b2 = 0.57000 * b2 + w * 1.0526913;
    out[i] = b0 + b1 + b2 + w * 0.1848;
  }
  return scaleToRms(out, rms);
}

/**
 * 拍手の代用。密なインパルスに短い減衰を付けたもの。
 *
 * 本物の拍手は残響で埋まってもっと連続音に近い。**代用は本物より「声と違う」側に
 * 外れる**ので、ここで出る距離は上振れとして読むこと。
 */
function applause(n: number, rms: number, seed: number): Float32Array {
  const rnd = makeNoiseRng(seed);
  const out = new Float32Array(n);
  const decay = Math.round(SR * 0.006);
  for (let i = 0; i < n; i++) {
    // 毎秒 40 発ほど
    if (rnd() < 40 / SR) {
      const amp = 0.5 + rnd();
      for (let k = 0; k < decay && i + k < n; k++) {
        out[i + k] += amp * (1 - k / decay) * (rnd() * 2 - 1);
      }
    }
  }
  return scaleToRms(out, rms);
}

/**
 * A特性をかけた実効値[dBFS]。**レベルを合わせるのはこの尺度で行う。**
 *
 * 広帯域の実効値で「声より15dB下の BGM」を作ると、A特性をかけた後には
 * はるかに下に落ちる（ピンクノイズはエネルギーが低域に寄っており、A特性は
 * そこを大きく削る）。**測っているのはA特性のレベルなので、素材の側も
 * A特性で揃えないと、条件の名前と実際の条件が食い違う。** 実際そう作って
 * 測ったとき、BGM を声と同じレベルまで上げても表示誤差が 0.00dB のままだった。
 */
function aWeightedDb(data: Float32Array): number {
  const w = new AWeightingFilter(SR).process(data);
  let s = 0;
  for (const v of w) s += v * v;
  return dbfs(Math.sqrt(s / w.length));
}

/** `reference` のA特性レベルから `belowDb` 下になるよう `data` を揃える */
function atAWeightedLevel(
  data: Float32Array, referenceDb: number, belowDb: number,
): Float32Array {
  const cur = aWeightedDb(data);
  const g = Math.pow(10, (referenceDb + belowDb - cur) / 20);
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] * g;
  return out;
}

/** 発話部分だけのA特性レベル[dBFS] */
function speechADb(talk: Talk): number {
  const f = framesOf(talk.samples);
  const picked: number[] = [];
  for (let i = 0; i < f.power.length && i < talk.gapFrame.length; i++) {
    if (!talk.gapFrame[i]) picked.push(f.power[i]);
  }
  if (picked.length === 0) return -120;
  const mean = picked.reduce((a, b) => a + b, 0) / picked.length;
  return mean > 0 ? dbfs(Math.sqrt(mean)) : -120;
}

function scaleToRms(data: Float32Array, target: number): Float32Array {
  let s = 0;
  for (const v of data) s += v * v;
  const cur = Math.sqrt(s / data.length);
  const g = cur === 0 ? 0 : target / cur;
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] * g;
  return out;
}

function mixInto(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] + (b[i] ?? 0);
  return out;
}

// ==========================================================================
// フレーム化（製品と同じ規則）
// ==========================================================================

interface Frames {
  /** A特性のフレームパワー */
  power: number[];
  /** A特性のフレームレベル[dBFS] */
  db: number[];
  /** オクターブバンドのパワー */
  bands: number[][];
}

const shapeWin = blackmanHarrisWindow(SHAPE_FFT);

function bandPowersAt(data: Float32Array, end: number): number[] {
  const out = new Array<number>(SHAPE_BANDS_HZ.length).fill(0);
  const start = end - SHAPE_FFT;
  if (start < 0) return out;

  const re = new Float32Array(SHAPE_FFT);
  const im = new Float32Array(SHAPE_FFT);
  for (let i = 0; i < SHAPE_FFT; i++) re[i] = data[start + i] * shapeWin[i];
  fft(re, im);

  const binHz = SR / SHAPE_FFT;
  const half = SHAPE_FFT >> 1;
  for (let b = 0; b < SHAPE_BANDS_HZ.length; b++) {
    const lo = Math.max(1, Math.floor((SHAPE_BANDS_HZ[b] * Math.SQRT1_2) / binHz));
    const hi = Math.min(half, Math.ceil((SHAPE_BANDS_HZ[b] * Math.SQRT2) / binHz));
    let sum = 0;
    for (let k = lo; k < hi; k++) sum += re[k] * re[k] + im[k] * im[k];
    out[b] = sum / Math.max(1, hi - lo);
  }
  return out;
}

function framesOf(data: Float32Array, withBands = false): Frames {
  const weighted = new AWeightingFilter(SR).process(data);
  const power: number[] = [];
  const db: number[] = [];
  const bands: number[][] = [];
  for (let f = 0; f + FRAME <= data.length; f += FRAME) {
    let s = 0;
    for (let k = f; k < f + FRAME; k++) s += weighted[k] * weighted[k];
    const p = s / FRAME;
    power.push(p);
    db.push(p > 0 ? dbfs(Math.sqrt(p)) : -120);
    bands.push(withBands ? bandPowersAt(data, f + FRAME) : []);
  }
  return { power, db, bands };
}

/** 製品と同じ手順でフレームごとの有音判定を出す */
function gateFlags(db: number[], rangeDb: number): boolean[] {
  const historyLen = (GATE_HISTORY_SEC * 1000) / FRAME_MS;
  const history: number[] = [];
  return db.map((level) => {
    const threshold = gateThresholdDb(history, rangeDb);
    history.push(level);
    if (history.length > historyLen) history.shift();
    if (level <= -120) return false;
    return threshold === null || level >= threshold;
  });
}

// ==========================================================================
// 1. 喋りの密度によるバイアス
// ==========================================================================

/** 有音フレームの直近 n 枚（rangeDb=Infinity なら全フレーム＝実時間の窓） */
function windowLeqDb(
  power: number[], flags: boolean[], from: number, count: number,
): number | null {
  const picked: number[] = [];
  for (let i = from; i >= 0 && picked.length < count; i--) {
    if (flags[i]) picked.push(power[i]);
  }
  if (picked.length < count) return null;
  const mean = picked.reduce((a, b) => a + b, 0) / picked.length;
  return mean > 0 ? dbfs(Math.sqrt(mean)) : -120;
}

interface BiasRow {
  label: string;
  gatedDb: number | null;
  ungatedDb: number | null;
}

/**
 * 密に喋る区間で基準を取り、間の多い区間と比べたときの差[dB]。
 *
 * ゲート無しの側は**全フレームの直近100枚**（＝実時間10秒）を平均する。
 * ここで無音フレームを除いてしまうと、それは「ゲート無し」ではなく
 * 「別のゲート」を測っていることになる。
 */
function densityBias(speaker: string, rangeDb: number | null): number | null {
  const dense  = buildTalk(speaker, 0.3, 40);
  const sparse = buildTalk(speaker, 2.0, 60);
  if (dense.samples.length === 0 || sparse.samples.length === 0) return null;

  const d = framesOf(dense.samples);
  const s = framesOf(sparse.samples);
  const df = rangeDb === null ? d.db.map(() => true) : gateFlags(d.db, rangeDb);
  const sf = rangeDb === null ? s.db.map(() => true) : gateFlags(s.db, rangeDb);

  const ref = windowLeqDb(d.power, df, d.power.length - 1, 100);
  const cur = windowLeqDb(s.power, sf, s.power.length - 1, 100);
  return ref !== null && cur !== null ? cur - ref : null;
}

function measureBias(speakers: string[]): BiasRow[] {
  return speakers.map((speaker) => ({
    label: speaker,
    ungatedDb: densityBias(speaker, null),
    gatedDb:   densityBias(speaker, ACTIVE_RANGE_DB),
  }));
}

// ==========================================================================
// 2. ゲート幅の走査
// ==========================================================================

interface SweepRow {
  rangeDb: number;
  /** 発話フレームを無音と判定した率 */
  missRate: number;
  /** 間（暗騒音 -20dB）を有音と判定した率 */
  gapRoom20: number;
  /** 間（暗騒音 -10dB）を有音と判定した率 */
  gapRoom10: number;
  /** 間（暗騒音 -6dB）を有音と判定した率 */
  gapRoom6: number;
  /** 喋りの密度によるバイアス[dB]。真値は 0 */
  biasDb: number | null;
}

/**
 * ゲート幅を振る。
 *
 * **選ぶ基準は「間を取り込まないこと」と「密度バイアスが小さいこと」の2つだけ。**
 * 発話フレームの取り落とし率も出すが、これは選定には使わない——1本の発話の中にも
 * 短い間があり、そこを外すのは正しい振る舞いなのに「取り落とし」に数えられる。
 * 平均に要るのは全部の発話フレームではなく、レベルを代表するフレームである。
 */
function sweepGate(speaker: string, widths: number[]): SweepRow[] {
  const room20 = buildTalk(speaker, 1.2, 60, { roomBelowDb: -20 });
  const room10 = buildTalk(speaker, 1.2, 60, { roomBelowDb: -10 });
  const room6  = buildTalk(speaker, 1.2, 60, { roomBelowDb: -6 });
  if (room20.samples.length === 0) return [];

  const f20 = framesOf(room20.samples);
  const f10 = framesOf(room10.samples);
  const f6  = framesOf(room6.samples);

  const rate = (flags: boolean[], gapFrame: boolean[], want: boolean, gap: boolean): number => {
    let hit = 0;
    let total = 0;
    for (let i = 0; i < flags.length && i < gapFrame.length; i++) {
      if (gapFrame[i] !== gap) continue;
      total++;
      if (flags[i] === want) hit++;
    }
    return total === 0 ? 0 : hit / total;
  };

  return widths.map((rangeDb) => ({
    rangeDb,
    missRate:  rate(gateFlags(f20.db, rangeDb), room20.gapFrame, false, false),
    gapRoom20: rate(gateFlags(f20.db, rangeDb), room20.gapFrame, true,  true),
    gapRoom10: rate(gateFlags(f10.db, rangeDb), room10.gapFrame, true,  true),
    gapRoom6:  rate(gateFlags(f6.db,  rangeDb), room6.gapFrame,  true,  true),
    biasDb:    densityBias(speaker, rangeDb),
  }));
}

// ==========================================================================
// 3-4. スペクトル距離
// ==========================================================================

/** 有音フレームの平均バンドパワーから形を出す */
function shapeFor(data: Float32Array, rangeDb = ACTIVE_RANGE_DB): number[] | null {
  const f = framesOf(data, true);
  const flags = gateFlags(f.db, rangeDb);
  const picked = f.bands.filter((_, i) => flags[i] && f.bands[i].some((v) => v > 0));
  if (picked.length === 0) return null;
  const n = picked[0].length;
  const mean = new Array<number>(n).fill(0);
  for (const b of picked) for (let i = 0; i < n; i++) mean[i] += b[i];
  for (let i = 0; i < n; i++) mean[i] /= picked.length;
  return shapeOf(mean);
}

interface DistanceRow {
  label: string;
  distanceDb: number | null;
  /** 数値を出し続けてよい側か（true なら距離は小さくあってほしい） */
  shouldPass: boolean;
}

function measureDistances(): DistanceRow[] {
  const rows: DistanceRow[] = [];
  const refTalk = buildTalk('awb', 1.0, 30);
  if (refTalk.samples.length === 0) return rows;
  const ref = shapeFor(refTalk.samples);
  if (ref === null) return rows;

  const push = (label: string, data: Float32Array | null, shouldPass: boolean): void => {
    const s = data === null ? null : shapeFor(data);
    rows.push({ label, distanceDb: s === null ? null : shapeDistanceDb(s, ref), shouldPass });
  };

  const sameSpeaker = buildTalk('awb', 1.4, 30);
  push('同じ話者・別の発話', sameSpeaker.samples, true);

  for (const other of ['bdl', 'ksp', 'slt']) {
    const t = buildTalk(other, 1.0, 30);
    if (t.samples.length > 0) push(`話者交代 (awb→${other})`, t.samples, true);
  }
  // 話者交代はこの道具の常態なので、いちばん離れる組を上限として押さえておく
  for (const [a, b] of [['bdl', 'slt'], ['ksp', 'slt'], ['bdl', 'ksp']]) {
    const ta = buildTalk(a, 1.0, 30);
    const tb = buildTalk(b, 1.0, 30);
    const sa = ta.samples.length > 0 ? shapeFor(ta.samples) : null;
    const sb = tb.samples.length > 0 ? shapeFor(tb.samples) : null;
    rows.push({
      label: `話者交代 (${a}→${b})`,
      distanceDb: sa && sb ? shapeDistanceDb(sb, sa) : null,
      shouldPass: true,
    });
  }

  // レベル不変性。同じ音源をフェーダーで動かしただけ
  const louder = new Float32Array(refTalk.samples.length);
  for (let i = 0; i < louder.length; i++) louder[i] = refTalk.samples[i] * Math.pow(10, 6 / 20);
  push('同じ音源 +6dB（フェーダー操作）', louder, true);

  // 声の下に BGM。これは「違う音」ではなく「声が主のまま」なので通す側
  const refADb = speechADb(refTalk);
  push('声＋BGM(-15dB)',
    mixInto(refTalk.samples,
      atAWeightedLevel(pinkNoise(refTalk.samples.length, 0.05, 11), refADb, -15)),
    true);

  push('BGM のみ（合成）', pinkNoise(refTalk.samples.length, 0.05, 3), false);
  push('拍手（合成）', applause(refTalk.samples.length, 0.05, 5), false);

  return rows;
}

/**
 * 捕まえられないもの: **声の下に敷かれた BGM。**
 *
 * 音源が入れ替わるわけではないので形はほとんど変わらない。それでいてレベルは
 * 上がるので、フェーダーに触れていないのに差が出る。ここで測るのは「形が変わらない
 * こと」と「そのとき何 dB ずれるか」の両方——**捕まえられない誤差の大きさ**を
 * 数字にしておかないと、限界を書いたことにならない。
 */
interface BgmLimitRow {
  belowDb: number;
  distanceDb: number | null;
  levelErrorDb: number | null;
}

function measureBgmLimit(): BgmLimitRow[] {
  const talk = buildTalk('awb', 1.2, 40);
  if (talk.samples.length === 0) return [];
  const base = framesOf(talk.samples);
  const baseFlags = gateFlags(base.db, ACTIVE_RANGE_DB);
  const refDb = windowLeqDb(base.power, baseFlags, base.power.length - 1, 100);
  const refShape = shapeFor(talk.samples);
  const speechDb = speechADb(talk);

  return [-15, -10, -6, -3, 0].map((belowDb) => {
    const mixed = mixInto(
      talk.samples,
      atAWeightedLevel(pinkNoise(talk.samples.length, 0.05, 13), speechDb, belowDb),
    );
    const f = framesOf(mixed);
    const flags = gateFlags(f.db, ACTIVE_RANGE_DB);
    const cur = windowLeqDb(f.power, flags, f.power.length - 1, 100);
    const s = shapeFor(mixed);
    return {
      belowDb,
      distanceDb: s && refShape ? shapeDistanceDb(s, refShape) : null,
      levelErrorDb: cur !== null && refDb !== null ? cur - refDb : null,
    };
  });
}

// ==========================================================================
// 出力
// ==========================================================================

function fmt(v: number | null, digits = 2): string {
  return v === null ? '—' : v.toFixed(digits);
}

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function main(): void {
  if (corpusFiles('awb').length === 0) {
    console.error(`素材がありません: ${CORPUS}（npm run fetch-corpus で取得）`);
    process.exit(1);
  }

  const bias = measureBias(['awb', 'bdl', 'ksp', 'slt']);
  const sweep = sweepGate('awb', [6, 9, 12, 15, 18, 21, 25]);
  const distances = measureDistances();
  const bgmLimit = measureBgmLimit();

  const lines: string[] = [];
  lines.push('# 実測: ボリュームチェックの有音ゲートとスペクトル照合');
  lines.push('');
  lines.push('`node validation/volume-gate.ts` の出力。**この文書は生成物である。**');
  lines.push('');
  lines.push('声は実音声（CMU Arctic）。**BGM と拍手は合成の代用**で、本物より');
  lines.push('「声と違う」側に外れる。距離の数字は上振れとして読むこと。');
  lines.push('');

  lines.push('## 1. 喋りの密度によるバイアス');
  lines.push('');
  lines.push('同じレベルの声を、間 0.3 秒の区間で基準に取り、間 2.0 秒の区間と比べる。');
  lines.push('**フェーダーには触れていないので真値は 0.00 dB。**');
  lines.push('');
  lines.push('| 話者 | ゲートなし（実時間10秒） | ゲートあり（声10秒） |');
  lines.push('|---|---|---|');
  for (const r of bias) {
    lines.push(`| ${r.label} | ${fmt(r.ungatedDb)} dB | **${fmt(r.gatedDb)} dB** |`);
  }
  const worstUngated = Math.max(...bias.map((r) => Math.abs(r.ungatedDb ?? 0)));
  const worstGated   = Math.max(...bias.map((r) => Math.abs(r.gatedDb ?? 0)));
  lines.push('');
  lines.push(`最大の偏り: ゲートなし **${worstUngated.toFixed(2)} dB** → ` +
    `ゲートあり **${worstGated.toFixed(2)} dB**。`);
  lines.push('');

  lines.push('## 2. ゲート幅の走査');
  lines.push('');
  lines.push('間 1.2 秒の話し声。「間の取り込み」は挿入した間を有音と判定した率で、');
  lines.push('括弧の数字は敷いた客席のざわめきのレベル（声からの差、A特性で揃えたもの）。');
  lines.push('間を取り込むほど、平均は「喋っていない時間」に汚される。');
  lines.push('');
  lines.push('| 幅[dB] | 間の取り込み(暗騒音-20) | 同(-10) | 同(-6) | 密度バイアス | (参考)取り落とし |');
  lines.push('|---|---|---|---|---|---|');
  for (const r of sweep) {
    const mark = r.rangeDb === ACTIVE_RANGE_DB ? ' ←採用' : '';
    lines.push(`| ${r.rangeDb}${mark} | ${pct(r.gapRoom20)} | ${pct(r.gapRoom10)} | ` +
      `${pct(r.gapRoom6)} | ${fmt(r.biasDb)} dB | ${pct(r.missRate)} |`);
  }
  lines.push('');
  lines.push('「取り落とし」を選定に使っていないのは、1本の発話の中にも短い間があり、');
  lines.push('そこを外すのは正しい振る舞いだからである。平均に要るのは全部の発話フレーム');
  lines.push('ではなく、レベルを代表するフレームのほうである。');
  lines.push('');

  lines.push('## 3. 基準とのスペクトル距離');
  lines.push('');
  lines.push('基準は awb の話し声。**通す側**は数値を出し続けてよい相手、');
  lines.push('**黙る側**は数値を引っ込めるべき相手。');
  lines.push('');
  lines.push('| 相手 | 距離[dB] | 期待 | いまのしきい値での判定 |');
  lines.push('|---|---|---|---|');
  for (const r of distances) {
    const passes = r.distanceDb !== null && r.distanceDb < SHAPE_DISTANCE_DB;
    const ok = r.distanceDb === null ? '—' : passes === r.shouldPass ? '一致' : '**外れ**';
    lines.push(`| ${r.label} | ${fmt(r.distanceDb)} | ${r.shouldPass ? '通す' : '黙る'} | ` +
      `${passes ? '通す' : '黙る'} (${ok}) |`);
  }
  lines.push('');
  lines.push(`しきい値 \`SHAPE_DISTANCE_DB = ${SHAPE_DISTANCE_DB}\`、` +
    `ゲート幅 \`ACTIVE_RANGE_DB = ${ACTIVE_RANGE_DB}\`。`);
  lines.push('');
  const talkerMax = Math.max(
    ...distances.filter((r) => r.shouldPass).map((r) => r.distanceDb ?? 0),
  );
  const otherMin = Math.min(
    ...distances.filter((r) => !r.shouldPass).map((r) => r.distanceDb ?? Infinity),
  );
  lines.push(`通す側の最大 **${talkerMax.toFixed(2)} dB**（話者交代）と、`);
  lines.push(`黙る側の最小 **${otherMin.toFixed(2)} dB**（BGM のみ）の間にしきい値を置く。`);
  lines.push('話者交代は会場の常態なので、そこで黙る設計にはできない。');
  lines.push('');

  lines.push('## 4. 捕まえられないもの: 声の下の BGM');
  lines.push('');
  lines.push('音源が入れ替わるわけではないので形は変わらない。**それでいてレベルは上がる**ので、');
  lines.push('フェーダーに触れていないのに差が出る。スペクトル照合では捕まらない。');
  lines.push('');
  lines.push('| BGM のレベル（声比） | 形の距離[dB] | 表示に出る誤差[dB] |');
  lines.push('|---|---|---|');
  for (const r of bgmLimit) {
    lines.push(`| ${r.belowDb} dB | ${fmt(r.distanceDb)} | **${fmt(r.levelErrorDb)}** |`);
  }
  lines.push('');
  lines.push('**通す範囲に残る誤差は 1dB 以下に収まっている。** 声より 3dB 下まで BGM が');
  lines.push('上がると距離がしきい値を超えるので、そこから先は画面が黙る——形の照合は');
  lines.push('BGM を狙って作ったものではないが、結果として「誤差が効き始めるあたり」で');
  lines.push('引っかかっている。');
  lines.push('');
  lines.push('ただし**これは合成のピンクノイズでの話である**。実際の音楽が声とどれだけ');
  lines.push('違う形をしているかはここでは測れていない。声に近い形の BGM（弦や男声の');
  lines.push('コーラス）なら距離は伸びず、1dB 前後の誤差が断りなしに出る。');
  lines.push('');

  writeFileSync(OUT, lines.join('\n'), 'utf8');
  console.log(lines.join('\n'));
  console.log(`\n→ ${OUT}`);
}

main();
