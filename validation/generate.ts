/**
 * 検証セットの生成。
 *
 *   node validation/generate.ts [--duration=10] [--max-sources=3] [--seed=1]
 *                               [--synthetic] [--rates=16000,48000] [--mixed]
 *
 * fixtures/corpus/ にクリーン音声のWAVがあればそれを素材にし、無ければ
 * 合成した音声風信号(speechlike.ts)で代替する。素材ごとに、既知の物理量を
 * 1つだけ注入した劣化版を作る。1条件ずつしか掛けないのは、誤差の原因を
 * 一意に切り分けるため。
 *
 * 出力:
 *   fixtures/generated/*.wav   … git管理外
 *   validation/manifest.json   … git管理下（劣化パラメータと真値の記録）
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import { decodeWav, encodeWavFloat32 } from './lib/wav.ts';
import { resample, resampledContentHz } from './lib/dsp.ts';
import { speechLike } from './lib/speechlike.ts';
import {
  activeSpeechRms,
  addBabbleNoise,
  addImpulsiveNoise,
  addNoise,
  applyBandedReverb,
  applyClipping,
  applyLowpass,
  applyLevel,
  applyTilt,
  applyReverb,
  normalizeSpeechLevel,
  reducePauses,
  type BandRt60Profile,
} from './lib/degrade.ts';
import { CORPUS_DIR, GENERATED_DIR, MANIFEST, numArg, parseArgs } from './lib/paths.ts';

const args = parseArgs(process.argv.slice(2));
// 製品のマイク録音と同じ長さに合わせる。短いと残響の自由減衰を観測できる
// 息継ぎの回数が足りず、長いRT60ほど検出できなくなる。
const DURATION_SEC = numArg(args, 'duration', 10);
const MAX_SOURCES  = numArg(args, 'max-sources', 3);
const SEED         = numArg(args, 'seed', 1);
const FORCE_SYNTH  = args.synthetic === true;
/** 複合条件も生成する（配点の検証用） */
const WANT_MIXED   = args.mixed === true;
const SYNTH_SR     = 48000;
/**
 * 検証するサンプルレートの一覧（空 = 素材のレートそのまま）。
 * 指定すると素材1つがレートごとに複製され、同じ内容を違うレートで並べて比較できる。
 *
 * 製品のマイク録音は48kHzだが、公開コーパスは16kHzが主流。推定器の定数は
 * すべて秒/Hzで書いてあるが、FFT長(2048)だけは固定なので周波数分解能が
 * サンプルレートに反比例する（16kHz:7.8Hz/bin → 48kHz:23.4Hz/bin）。
 * 帯域上限の検出は100Hz幅の帯で見ているので、48kHzでは1帯あたり4binしか
 * 入らない。ここが壊れていないかを実素材で確かめるための入口。
 *
 * **注意: これは「48kHzで実装が正しく動くか」の検証であって、
 * 「48kHzの実録音で正しいか」の検証ではない。** 16kHz素材を上げ変換しても
 * 8kHz以上に中身は生まれないので、8/11/16kHzのカットオフ条件は依然として
 * 試せない。そちらは広帯域の実素材が必要。
 */
const RATES = typeof args.rates === 'string'
  ? String(args.rates).split(',').map(Number).filter((n) => Number.isFinite(n) && n > 0)
  : [];
/**
 * 目標長に対してこの割合を下回るコーパス素材は使わない。
 * 息継ぎの回数が足りず残響を推定できないため、短い素材を混ぜると
 * rt60 条件だけ測定不能が増えて誤差が読めなくなる。
 */
const MIN_SOURCE_RATIO = 0.8;

// ---- 条件マトリクス（1素材あたり） ----
const SNR_DB_LIST    = [0, 5, 10, 15, 20, 25, 30, 40];
const RT60_SEC_LIST  = [0.2, 0.35, 0.5, 0.7, 1.0, 1.5];
const CUTOFF_HZ_LIST = [3400, 4000, 5500, 8000, 11000, 16000];
const CLIP_RATE_LIST = [0.0002, 0.001, 0.005, 0.02];
/**
 * スペクトルの傾き[dB/oct]（こもり）。帯域は削らずに高域だけ落とす。
 *
 * 周波数軸の内訳のうち「明瞭度」10点はこれを捉えるためにあるが、検証条件が
 * 無かった。実測すると劣化なしの実音声4話者でこの内訳が3.4〜8.8点とばらついて
 * おり、声質（低い声ほど500〜3000Hzの比率が下がる）を環境の欠点として減点して
 * いる疑いがある。注入した傾きへの反応と話者間のばらつきを比べて確かめる。
 */
const TILT_DB_PER_OCT_LIST = [-3, -6, -9, -12];

/**
 * 有効音声レベル[dBFS]。音量軸を動かす条件。
 *
 * 素材は -17dBFS に正規化してあるので、そのままでは音量軸が常に満点で
 * 検証にならなかった。
 *
 * 減点しない範囲を -50dBFS まで広げたので（量子化フロアが根拠）、条件も
 * そこより下まで振る必要がある。実録音の実測値（-26.2 / -31.4 / -35.4 /
 * -47.4 dBFS）はすべて減点しない範囲に入るので、それだけでは軸が動かない。
 */
const LEVEL_DBFS_LIST = [-70, -60, -50, -40, -30, -20, -12, -8];

/**
 * 直接音対残響比を変える条件。残響の振幅（直接音を1としたときの比）で指定する。
 *
 * RT60を固定してマイク位置だけを変える。RT60は部屋の性質だが、マイクに届く残響の
 * 量はマイク位置で決まり、了解度に効くのはそちらのほう。残響軸が「部屋」を測って
 * いるのか「その位置での聞こえ」を測っているのかを切り分けるための条件。
 *
 * 検証基盤はこれまで 0.45 に固定していたので、残響軸の閾値を較正できなかった。
 */
const DRR_RT60_SEC = 0.6;
/**
 * 直接音対残響比[dB]。実際の録音の範囲を覆う。
 *   +20 近接マイク / +10 卓上マイク / 0 部屋の向こう / -10 かなり遠い
 */
const DRR_DB_LIST = [20, 15, 10, 5, 0, -10];

/**
 * 帯域ごとにRT60が違う部屋のプロファイル（低/中/高）。
 *
 * `makeRir` の応答はスペクトルが平坦で、全帯域が同じ速さで減衰する。実室はそうならず、
 * 高域ほど早く減衰する。広帯域のレベル列から測る推定器は最も遅く減衰する帯域に
 * 引っ張られるので、**平坦な応答しか試していないとこの誤差は原理的に見えない。**
 *
 * `flat` は対照。他の3件との差がそのまま「周波数依存によって増える誤差」になる。
 * 真値は中帯域（500〜2000Hz）のRT60で、ISO 3382 が代表値とする
 * 500Hz/1kHz オクターブの平均に対応する。
 */
const RT60_BAND_PROFILES: Array<{ name: string; profile: BandRt60Profile }> = [
  { name: 'flat',    profile: { lowSec: 0.5, midSec: 0.5, highSec: 0.5  } },
  { name: 'meeting', profile: { lowSec: 0.7, midSec: 0.5, highSec: 0.35 } },
  { name: 'hard',    profile: { lowSec: 1.2, midSec: 0.9, highSec: 0.6  } },
  { name: 'ceiling', profile: { lowSec: 0.9, midSec: 0.4, highSec: 0.25 } },
];

/**
 * 多人数の話し声（非定常ノイズ）のSNR[dB]。
 *
 * 既存のノイズ条件は白色とピンクだけ、つまり定常ノイズしかない。有音／無音の分離に
 * 依存するSNR推定がいちばん苦手な入力が試されていなかった。低SNR側で楽観に振れるので、
 * 判定の「適していない」境界（SNR 15.8dB相当）をまたぐ範囲まで振る。
 */
const BABBLE_SNR_LIST = [25, 20, 15, 10, 5];
/**
 * 重ねる声の数。
 *
 * 4声と8声を試したが誤差はほぼ同じだった（素材が3〜4しか無いので、増やした分は
 * 同じ素材を別の開始位置で重ねることになり、包絡の変調が浅くなるだけで水準は動かない）。
 * 条件を2倍にする価値が無いので1つに固定する。
 */
const BABBLE_VOICES = 6;

/**
 * 衝撃性ノイズ（打鍵音）のSNR[dB]と毎秒の回数。
 *
 * **この道具の最大の盲点を機械可読にするための条件。** 実測では真SNR 15〜22dB の
 * 範囲で推定値が 27dB 前後に張り付き、真値と無相関になる。単調性の節が
 * これを `blind` として記録する。
 *
 * SNR 10dB 以下は生成できない——衝撃音は波高率が高いので、素材のピーク（0.95）に
 * 足すと 1.0 を超えて音割れという別の劣化が混ざる。生成側でピークを見て飛ばす。
 */
const IMPULSE_SNR_LIST = [25, 20, 15];
const IMPULSE_PER_SEC_LIST = [2, 8];
/** 混合後のピークがこれを超える条件は生成しない（音割れの混入を避ける） */
const IMPULSE_PEAK_LIMIT = 0.98;

/**
 * 判定の再現性を測る条件。RT60 とマイク位置を固定し、**乱数だけを振る。**
 *
 * 誤差表は「真値をずらしたときにどれだけ当たるか」を測るが、この道具の出力は
 * 3値の判定なので、本当に問うべきは「同じ部屋を測り直して同じ答えが出るか」である。
 * 真値を固定して応答の実現だけを変えると、判定のばらつきがそのまま観測できる。
 *
 * 0.5秒と0.7秒を選ぶ理由は、判定の境界がその間にあること。0.7秒は ANSI/ASA S12.60 が
 * 10,000〜20,000ft³ の教室に許す上限そのもので、判定がいちばん効いてほしい領域である。
 */
const RT60_REPEAT_SEC_LIST = [0.5, 0.7];
const RT60_REPEAT_COUNT = 5;

/**
 * 残す無音フレームの割合。間の少ない発話を作る条件。
 *
 * 狙いは2つ。
 *
 * 1. README の「話者の喋り方は評価しない」という宣言の検証。ノイズ軸はSNRを
 *    有音／無音の分離から推定するので、間の量に依存していないかは振ってみないと
 *    分からない。SNRは固定するので、誤差が動いたらそれは喋り方への依存である。
 * 2. ノイズフロアの推定に使える無音フレーム数の下限（推定器の MIN_NOISE_FRAMES）を
 *    実際に踏ませる。公開コーパスは発話を連結して素材にしているので間が多く、
 *    **この下限に当たる録音が検証セットに1件も無かった。**
 */
const PAUSE_KEEP_RATIO_LIST = [0.5, 0.25, 0.1, 0.03];
/** 間を振るときの注入SNR[dB]。判定の境界より上に置き、間だけを変数にする */
const PAUSE_SNR_DB = 20;

/**
 * 複合条件（--mixed）。2つ以上の劣化を同時に掛ける。
 *
 * 単独条件では**配点を検証できない**。ノイズ25点・残響20点という重み付けが
 * 妥当かどうかは、「ノイズが強い録音」と「残響が長い録音」のどちらを低く
 * 評価すべきかという比較でしか問えない。単独条件はその比較を含まない。
 *
 * **要因の組み合わせは均衡させる（完全要因配置にする）。** 最初は
 * 「ノイズ×残響」「ノイズ×音割れ」…と組を並べる形にしたが、それでは
 * 音割れの条件に強い残響が入らず、残響の条件に音割れが入らない。結果、
 * 軸ごとの相関が音量 -0.52 / 音割れ -0.64 と符号が反転して出た。
 * 軸が壊れていたのではなく、条件の組み方が交絡していただけだった。
 *
 * 真値は物理量ごとには定義できない（帯域制限した後のSNRの真値のような
 * 組み合わせは意味が曖昧）ので、推定誤差の集計からは外れる。用途は
 * MOSオラクルとの順位相関による配点の検証だけ。
 */
interface MixedSpec {
  snrDb?: number;
  rt60Sec?: number;
  cutoffHz?: number;
  clipRate?: number;
}

const MIXED_SNR_LEVELS    = [8, 15, 25];
const MIXED_RT60_LEVELS   = [0.3, 0.6, 1.0];
const MIXED_CLIP_LEVELS   = [undefined, 0.005];
const MIXED_CUTOFF_LEVELS = [undefined, 3400];

/** 完全要因配置: 3 × 3 × 2 × 2 = 36通り */
const MIXED_LIST: MixedSpec[] = MIXED_SNR_LEVELS.flatMap((snrDb) =>
  MIXED_RT60_LEVELS.flatMap((rt60Sec) =>
    MIXED_CLIP_LEVELS.flatMap((clipRate) =>
      MIXED_CUTOFF_LEVELS.map((cutoffHz) => ({ snrDb, rt60Sec, clipRate, cutoffHz })),
    ),
  ),
);

interface Source {
  name: string;
  samples: Float32Array;
  sampleRate: number;
  /**
   * 素材に実際に中身が入っている上限周波数。
   *
   * ナイキストとは別物。16kHz素材を48kHzに上げても8kHz以上には何も生まれない
   * ので、それより上のカットオフ条件は掛けても真値が観測できない。
   * 意味のない条件を混ぜると帯域上限の誤差統計が読めなくなる。
   */
  contentHz: number;
  sha256: string | null;
}


interface ManifestItem {
  id: string;
  file: string;
  source: string;
  sourceSha256: string | null;
  sampleRate: number;
  samples: number;
  condition: { type: string; params: Record<string, number | string> };
  truth: Record<string, number>;
}

function loadSources(): Source[] {
  if (!FORCE_SYNTH && existsSync(CORPUS_DIR)) {
    const wavs = readdirSync(CORPUS_DIR).filter((f) => /\.wav$/i.test(f)).sort();
    if (wavs.length > 0) {
      const sources = buildCorpusSources(wavs);
      if (sources.length > 0) {
        console.log(`コーパス素材を使用: ${sources.length}素材 / ${wavs.length}ファイル (${CORPUS_DIR})`);
        for (const s of sources) {
          console.log(`  ${s.name}  ${s.sampleRate}Hz  ${(s.samples.length / s.sampleRate).toFixed(1)}秒`);
        }
        return sources;
      }
    }
  }

  console.log(
    FORCE_SYNTH
      ? '合成音声風信号を使用（--synthetic 指定）'
      : `コーパスが空のため合成音声風信号で代替します（${CORPUS_DIR}）\n` +
        '  実音声を使うには: npm run fetch-corpus  もしくは fixtures/corpus/ に WAV を置く',
  );
  const n = Math.max(1, Math.min(MAX_SOURCES, 8));
  return Array.from({ length: n }, (_, i) => ({
    name: `synthetic:${i}`,
    samples: speechLike(DURATION_SEC, SYNTH_SR, SEED * 1000 + i),
    sampleRate: SYNTH_SR,
    contentHz: SYNTH_SR / 2,
    sha256: null,
  }));
}

/**
 * コーパスのファイルを連結して、目標長の素材を作る。
 *
 * 公開コーパスの1ファイルは2〜4秒の単発発話が普通で、そのままでは短すぎる。
 * 残響の推定には発話の切れ目が複数必要なので、製品の録音長(10秒)に達するまで
 * 連ねる。ファイル間の無音は素材自身の録音余白なので、人工的な無音を挿入する
 * 必要はない（挿入するとデジタル無音として検出されてしまう）。
 */
/**
 * ファイル名から素材グループのキーを取る（末尾の連番を落とす）。
 * 話者ごとにファイル名の接頭辞が違うので、これで話者単位に素材がまとまる。
 * 1つの素材に複数話者を混ぜてしまうと、話者依存の問題を切り分けられない。
 */
function groupKeyOf(name: string): string {
  return name.replace(/-\d+\.wav$/i, '');
}

function buildCorpusSources(wavs: string[]): Source[] {
  // グループ（=話者）ごとにファイルを束ねる
  const groups = new Map<string, string[]>();
  for (const name of wavs) {
    const key = groupKeyOf(name);
    const list = groups.get(key) ?? [];
    list.push(name);
    groups.set(key, list);
  }

  const sources: Source[] = [];
  for (const [group, files] of groups) {
    if (sources.length >= MAX_SOURCES * Math.max(1, RATES.length)) break;

    let idx = 0;
    const parts: Float32Array[] = [];
    const used: string[] = [];
    const hash = createHash('sha256');
    let sampleRate = 0;
    let total = 0;
    let needed = Infinity;

    while (idx < files.length && total < needed) {
      const name = files[idx];
      idx++;
      const bytes = readFileSync(resolve(CORPUS_DIR, name));
      const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      let wav;
      try {
        wav = decodeWav(ab);
      } catch (e) {
        console.warn(`  読めないファイルを飛ばします: ${name} (${String(e)})`);
        continue;
      }
      if (sampleRate === 0) {
        sampleRate = wav.sampleRate;
        needed = Math.floor(DURATION_SEC * sampleRate);
      } else if (wav.sampleRate !== sampleRate) {
        continue; // サンプルレートが混ざる連結はしない
      }
      parts.push(wav.samples);
      total += wav.samples.length;
      used.push(basename(name));
      hash.update(bytes);
    }

    if (total === 0) continue;

    if (total < needed * MIN_SOURCE_RATIO) {
      console.log(`  ${group}: ${(total / sampleRate).toFixed(1)}秒 しかないため素材にしません`);
      continue;
    }

    const joined = new Float32Array(total);
    let offset = 0;
    for (const p of parts) { joined.set(p, offset); offset += p.length; }

    const sha = hash.digest('hex');
    // レート変換は正規化より前に行う。変換の補間で振幅がわずかに変わるため、
    // 後で正規化しないと目標発話レベルからずれる。
    for (const outSr of RATES.length > 0 ? RATES : [sampleRate]) {
      const converted = resample(joined, sampleRate, outSr);
      sources.push({
        name: `corpus:${group}(${used.length}本)@${outSr}Hz`,
        samples: normalizeSpeechLevel(converted, outSr),
        sampleRate: outSr,
        contentHz: outSr === sampleRate ? sampleRate / 2 : resampledContentHz(sampleRate, outSr),
        sha256: sha,
      });
    }
  }

  return sources;
}

/**
 * 後から足した条件の乱数種。**走行カウンタにしてはいけない。**
 *
 * 既存の `seedCounter` は素材をまたいで連続しているので、どこに条件を足しても
 * 2番目以降の素材の乱数がずれる。実際に一度ずらして既存252件の真値が動いた。
 * さらに、追加条件を走行カウンタで採ると**追加条件どうしが互いの乱数を動かす**
 * （条件を1つ増やしたら他の3条件の数値が変わった）。
 *
 * 素材番号と「どの条件の何番目か」から決めれば、条件を足しても既存の行も
 * 他の追加条件も動かない。SEED_SLOT_* は条件ごとの区画で、衝突しないよう
 * 素材あたりの間隔（1009）より小さく取る。
 */
function addedSeed(sourceIndex: number, slot: number): number {
  return SEED * 700001 + sourceIndex * 1009 + slot;
}

const SEED_SLOT_RT60BAND = 0;
const SEED_SLOT_BABBLE   = 100;
const SEED_SLOT_IMPULSE  = 200;
const SEED_SLOT_RT60REP  = 300;
const SEED_SLOT_PAUSES   = 400;

function trim(samples: Float32Array, sampleRate: number): Float32Array {
  const want = Math.floor(DURATION_SEC * sampleRate);
  return samples.length <= want ? samples : samples.subarray(0, want).slice();
}

function main(): void {
  mkdirSync(GENERATED_DIR, { recursive: true });

  const sources = loadSources();
  const items: ManifestItem[] = [];
  let seedCounter = SEED * 100003;

  for (const [si, src] of sources.entries()) {
    const clean = trim(src.samples, src.sampleRate);
    const sr = src.sampleRate;
    const contentHz = src.contentHz;
    const tag = `s${si}`;

    const emit = (
      id: string,
      data: Float32Array,
      condition: ManifestItem['condition'],
      truth: Record<string, number>,
    ): void => {
      const file = `${id}.wav`;
      writeFileSync(resolve(GENERATED_DIR, file), encodeWavFloat32(data, sr));
      items.push({
        id,
        file: `fixtures/generated/${file}`,
        source: src.name,
        sourceSha256: src.sha256,
        sampleRate: sr,
        samples: data.length,
        condition,
        truth,
      });
    };

    // ---- 劣化なしの基準 ----
    emit(`${tag}-clean`, clean, { type: 'clean', params: {} }, {
      activeSpeechRms: activeSpeechRms(clean, sr),
    });

    // ---- 既知SNRのノイズ ----
    for (const snr of SNR_DB_LIST) {
      for (const color of ['pink', 'white'] as const) {
        const r = addNoise(clean, sr, snr, seedCounter++, color, contentHz);
        emit(`${tag}-snr${snr}-${color}`, r.out,
          { type: 'snr', params: { targetSnrDb: snr, color } },
          {
            snrDb: r.trueSnrDb,
            requestedSnrDb: r.requestedSnrDb,
            activeSpeechRms: r.activeSpeechRms,
            noiseRms: r.noiseRms,
            sourceNoiseRms: r.sourceNoiseRms,
          });
      }
    }

    // ---- 既知RT60の残響 ----
    for (const rt60 of RT60_SEC_LIST) {
      const r = applyReverb(clean, sr, rt60, seedCounter++);
      emit(`${tag}-rt60-${String(rt60).replace('.', '_')}`, r.out,
        { type: 'rt60', params: { rt60Sec: rt60 } },
        { rt60Sec: r.trueRt60Sec, drrDb: r.trueDrrDb });
    }

    // ---- 既知カットオフの帯域制限 ----
    for (const cutoff of CUTOFF_HZ_LIST) {
      // 素材に中身が無い帯域を切っても何も起きない。真値が観測できないので飛ばす
      if (cutoff >= contentHz * 0.92) continue;
      const r = applyLowpass(clean, sr, cutoff);
      emit(`${tag}-lp${cutoff}`, r.out,
        { type: 'cutoff', params: { cutoffHz: cutoff } },
        { cutoffHz: r.trueCutoffHz });
    }

    // ---- 既知のクリップ率 ----
    for (const rate of CLIP_RATE_LIST) {
      const r = applyClipping(clean, rate);
      emit(`${tag}-clip${String(rate).replace('.', '_')}`, r.out,
        { type: 'clip', params: { targetRateAll: rate } },
        { clipRateAll: r.trueClipRateAll, clipRateActive: r.trueClipRateActive, gain: r.gain });
    }

    // ---- 直接音対残響比（マイク位置） ----
    for (const drr of DRR_DB_LIST) {
      const r = applyReverb(clean, sr, DRR_RT60_SEC, seedCounter++, drr);
      emit(`${tag}-drr${String(drr).replace('-', 'm')}`, r.out,
        { type: 'drr', params: { targetDrrDb: drr, rt60Sec: DRR_RT60_SEC } },
        { drrDb: r.trueDrrDb, rt60Sec: r.trueRt60Sec });
    }

    // ---- 既知の有効音声レベル ----
    for (const dbfs of LEVEL_DBFS_LIST) {
      const r = applyLevel(clean, sr, dbfs);
      emit(`${tag}-level${String(dbfs).replace('-', 'm')}`, r.out,
        { type: 'level', params: { targetDbfs: dbfs } },
        {
          activeSpeechDbfs: r.trueActiveSpeechDbfs,
          requestedDbfs: r.requestedDbfs,
          peakLimited: r.peakLimited ? 1 : 0,
        });
    }

    // ---- 既知の傾き（こもり） ----
    for (const slope of TILT_DB_PER_OCT_LIST) {
      const r = applyTilt(clean, sr, slope);
      emit(`${tag}-tilt${String(slope).replace("-", "m")}`, r.out,
        { type: 'tilt', params: { tiltDbPerOct: slope, hingeHz: r.hingeHz } },
        { tiltDbPerOct: r.trueTiltDbPerOct });
    }

    // ---- 複合条件（配点の検証用） ----
    //
    // MOSオラクルの入力は16kHzなので、レートを上げても同じ情報しか得られない。
    // 生成コストだけ増えるので、複数レートを指定したときは一番低いレートにだけ出す。
    const mixedRate = RATES.length > 0 ? Math.min(...RATES) : sr;
    if (WANT_MIXED && sr === mixedRate) {
      for (const spec of MIXED_LIST) {
        // 掛ける順番は信号経路に合わせる: 部屋の残響 → マイクが拾う暗騒音
        //  → 入力段の音割れ → コーデックの帯域制限
        if (spec.cutoffHz != null && spec.cutoffHz >= contentHz * 0.92) continue;

        let data = clean;
        const truth: Record<string, number> = {};
        const parts: string[] = [];

        if (spec.rt60Sec != null) {
          const r = applyReverb(data, sr, spec.rt60Sec, seedCounter++);
          data = r.out;
          truth.rt60Sec = r.trueRt60Sec;
          parts.push(`rt${String(spec.rt60Sec).replace('.', '_')}`);
        }
        if (spec.snrDb != null) {
          const r = addNoise(data, sr, spec.snrDb, seedCounter++, 'pink', contentHz);
          data = r.out;
          truth.snrDb = r.trueSnrDb;
          truth.noiseRms = r.noiseRms;
          truth.sourceNoiseRms = r.sourceNoiseRms;
          parts.push(`snr${spec.snrDb}`);
        }
        if (spec.clipRate != null) {
          const r = applyClipping(data, spec.clipRate);
          data = r.out;
          truth.clipRateActive = r.trueClipRateActive;
          parts.push(`clip${String(spec.clipRate).replace('.', '_')}`);
        }
        if (spec.cutoffHz != null) {
          const r = applyLowpass(data, sr, spec.cutoffHz);
          data = r.out;
          truth.cutoffHz = r.trueCutoffHz;
          parts.push(`lp${spec.cutoffHz}`);
        }

        emit(`${tag}-mix-${parts.join('-')}`, data,
          { type: 'mixed', params: { ...spec } as Record<string, number> },
          truth);
      }
    }

    // ======================================================================
    // ここから下は後から足した条件。**この位置より上に挿してはいけない。**
    //
    // seedCounter は発行順に消費される共有カウンタなので、既存ループの前に
    // 新しいループを挿すと以降すべての乱数がずれ、レポートの既存行が
    // 全部変わって「何を直したせいで数値が動いたのか」が読めなくなる。
    // ======================================================================

    // ---- 帯域ごとにRT60が違う残響（実室の周波数依存） ----
    for (const [pi, { name, profile }] of RT60_BAND_PROFILES.entries()) {
      const r = applyBandedReverb(clean, sr, profile, addedSeed(si, SEED_SLOT_RT60BAND + pi));
      emit(`${tag}-rt60band-${name}`, r.out,
        {
          type: 'rt60band',
          params: {
            profile: name,
            lowSec: profile.lowSec, midSec: profile.midSec, highSec: profile.highSec,
          },
        },
        {
          rt60Sec: r.trueRt60Sec,
          lowRt60Sec: r.trueLowRt60Sec,
          highRt60Sec: r.trueHighRt60Sec,
          drrDb: r.trueDrrDb,
        });
    }

    // ---- 多人数の話し声（非定常ノイズ） ----
    //
    // 素材は同じレートの他の話者を使う。素材が1つしか無い場合は作れないので飛ばす。
    const others = sources
      .filter((o) => o !== src && o.sampleRate === sr)
      .map((o) => trim(o.samples, o.sampleRate));
    if (others.length === 0) {
      console.log(`  ${src.name}: 同じレートの他素材が無いため babble 条件を飛ばします`);
    } else {
      for (const [bi, snr] of BABBLE_SNR_LIST.entries()) {
        const r = addBabbleNoise(clean, sr, snr, others, BABBLE_VOICES, addedSeed(si, SEED_SLOT_BABBLE + bi));
        emit(`${tag}-babble${snr}`, r.out,
          { type: 'snrbabble', params: { targetSnrDb: snr, voices: r.voices } },
          {
            snrDb: r.trueSnrDb,
            requestedSnrDb: r.requestedSnrDb,
            activeSpeechRms: r.activeSpeechRms,
            noiseRms: r.noiseRms,
            sourceNoiseRms: r.sourceNoiseRms,
          });
      }
    }

    // ---- 衝撃性ノイズ（打鍵音） ----
    for (const [pi, perSec] of IMPULSE_PER_SEC_LIST.entries()) {
      for (const [ii, snr] of IMPULSE_SNR_LIST.entries()) {
        const r = addImpulsiveNoise(clean, sr, snr, perSec,
          addedSeed(si, SEED_SLOT_IMPULSE + pi * IMPULSE_SNR_LIST.length + ii));
        // 波高率が高いので、低いSNRでは素材のピークに足すと1.0を超える。
        // 音割れという別の劣化が混ざるので生成しない（帯域制限で中身の無い
        // カットオフを飛ばしているのと同じ判断）。
        if (r.peak > IMPULSE_PEAK_LIMIT) continue;
        emit(`${tag}-click${perSec}-${snr}`, r.out,
          { type: 'snrimpulse', params: { targetSnrDb: snr, clicksPerSec: perSec } },
          {
            snrDb: r.trueSnrDb,
            requestedSnrDb: r.requestedSnrDb,
            activeSpeechRms: r.activeSpeechRms,
            noiseRms: r.noiseRms,
            sourceNoiseRms: r.sourceNoiseRms,
            peak: r.peak,
          });
      }
    }

    // ---- 判定の再現性（真値を固定して乱数だけ振る） ----
    for (const [ri, rt60] of RT60_REPEAT_SEC_LIST.entries()) {
      for (let rep = 0; rep < RT60_REPEAT_COUNT; rep++) {
        const r = applyReverb(clean, sr, rt60,
          addedSeed(si, SEED_SLOT_RT60REP + ri * RT60_REPEAT_COUNT + rep));
        emit(`${tag}-rt60rep-${String(rt60).replace('.', '_')}-${rep}`, r.out,
          { type: 'rt60rep', params: { rt60Sec: rt60, rep } },
          { rt60Sec: r.trueRt60Sec, drrDb: r.trueDrrDb });
      }
    }

    // ---- 間（無音区間）の量を振る ----
    for (const [ki, keep] of PAUSE_KEEP_RATIO_LIST.entries()) {
      const squeezed = reducePauses(clean, sr, keep);
      const r = addNoise(squeezed.out, sr, PAUSE_SNR_DB,
        addedSeed(si, SEED_SLOT_PAUSES + ki), 'pink', contentHz);
      emit(`${tag}-pauses${String(keep).replace('.', '_')}`, r.out,
        {
          type: 'pauses',
          params: {
            keepRatio: keep,
            targetSnrDb: PAUSE_SNR_DB,
            silenceRatio: Number(squeezed.silenceRatio.toFixed(4)),
          },
        },
        {
          snrDb: r.trueSnrDb,
          requestedSnrDb: r.requestedSnrDb,
          silenceRatio: squeezed.silenceRatio,
          activeSpeechRms: r.activeSpeechRms,
          noiseRms: r.noiseRms,
          sourceNoiseRms: r.sourceNoiseRms,
        });
    }
  }

  const manifest = {
    version: 1,
    seed: SEED,
    generatedWith: {
      durationSec: DURATION_SEC, maxSources: MAX_SOURCES,
      syntheticSampleRate: SYNTH_SR, rates: RATES.length > 0 ? RATES : null,
    },
    sources: sources.map((s) => ({ name: s.name, sampleRate: s.sampleRate, sha256: s.sha256 })),
    items,
  };
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');

  console.log(`\n生成完了: ${items.length} 件`);
  console.log(`  音声: ${GENERATED_DIR} (git管理外)`);
  console.log(`  記録: ${MANIFEST} (git管理下)`);
  console.log('\n次: npm run validate');
}

main();
