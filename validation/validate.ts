/**
 * 検証セットを流して、推定誤差とスコアの単調性を実測する。
 *
 *   node validation/validate.ts [--mos]
 *
 * 測るものは2つ。
 *
 * 1. 推定誤差 — 注入した既知の物理量を、推定器が復元できるか。
 *    ラベル付けは発生しない（算数なので）。
 * 2. スコアの単調性 — 劣化を強めたときスコアが正しい方向に動くか。
 *    Spearman の順位相関で見る。符号が想定と逆なら、その軸は壊れている。
 *
 * --mos を付けると、学習済みの無参照品質推定モデル(DNSMOS)との順位相関も出す。
 * モデルは製品には載せない。ここでの用途は「係数を調整する方向」を得るための
 * 開発時オラクルに限る。
 *
 * 出力: validation/report.json / validation/report.md （どちらもgit管理下）
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { decodeWav } from './lib/wav.ts';
import { MANIFEST, REPORT_JSON, REPORT_MD, ROOT, parseArgs } from './lib/paths.ts';
import {
  estimateClipping, estimateLevel, estimateReverb, estimateSnr, estimateSpectralSlope,
} from '../src/features/quality/estimators.ts';
import { detectProvenance } from '../src/features/quality/provenance.ts';
import {
  analyzeSamples, AXIS_MAX, AXIS_RATIO_PER_UNIT, AXIS_RATIO_UNCERTAINTY,
  type AudioScores,
} from '../src/features/quality/AudioAnalyzer.ts';
import { scoreMos } from './mos-oracle.ts';

const args = parseArgs(process.argv.slice(2));
const WANT_MOS = args.mos === true;

interface ManifestItem {
  id: string;
  file: string;
  source: string;
  sampleRate: number;
  condition: { type: string; params: Record<string, number | string> };
  truth: Record<string, number>;
}

interface Row {
  id: string;
  source: string;
  conditionType: string;
  params: Record<string, number | string>;
  /** 推定対象の真値（単調性の軸としても使う） */
  truthValue: number | null;
  estimate: number | null;
  errorLabel: string;
  scores: { overall: number; volume: number; frequency: number; reverb: number; clip: number; noise: number };
  /** 残響推定に使えた減衰イベント数（rt60条件の診断用） */
  decayEvents: number | null;
  /**
   * ノイズフロアの推定に使えた無音フレーム数。
   *
   * 0 なら推定器はパーセンタイル代替に落ちている。間の少ない発話で下限を
   * 割ったかどうかがここに出る。
   */
  noiseFrames: number | null;
  /**
   * 近似の落差が ISO 3382 の T20 相当（20dB）に届いた減衰イベント数。
   *
   * 実装は落差10dBから×6に外挿しているので、規格の手順（T20は20dBを×3）より
   * 曲率と雑音の影響が2倍拡大される。**「確定値」の条件に落差を足すべきかは
   * この列で誤差を層別して決める。**
   */
  decayEventsT20: number | null;
  /**
   * 推定したRT60[秒]と、条件が持つRT60の真値。
   *
   * drr条件（マイク位置を振る条件）では単調性の軸に DRR を使うので、RT60の誤差が
   * truthValue/estimate には載らない。どのマイク距離まで残響を判定できるかを見るため
   * 別に持つ。
   */
  rt60Estimate: number | null;
  rt60Truth: number | null;
  bandwidthHz: number;
  flags: string[];
  /**
   * 製品が「参考値」として扱う軸。
   *
   * 誤差が大きい行が利用者に断りなく出ていないかを確かめるために記録する。
   * 実測では減衰イベントが3個未満だとRT60のMAEが2.4倍になるので、
   * そこが reverb として挙がっていることがこの表で確認できる必要がある。
   */
  unreliable: string[];
  /** 総合判定 good/usable/poor */
  verdict: string;
  /**
   * 判定を断定しなかった理由。`false` なら断定している。
   *
   * boolean ではなく理由を持つ。「測れなかった」と「測れたが境界の誤差圏内」は
   * 利用者にとって別の状況で、レポートでも分けて数えられる必要がある。
   */
  verdictUnconfirmed: AudioScores['verdict']['unconfirmed'];
  /**
   * 出した助言のコード。
   *
   * 助言は注入した物理量から真値を作れる（帯域上限が7kHz未満なら帯域不足の
   * 助言が出るべき、など）。**採点だけ検証して助言を検証しないと、採点の境界を
   * 動かしたときに助言が黙って壊れる。** 実際に満点を7kHz→16kHzに変えたとき、
   * 達成率で判定していた帯域不足の助言が12.2kHz以下すべてに出るようになっていた。
   */
  advice: string[];
  mos: number | null;
}

// ==========================================================================
// 統計ヘルパー
// ==========================================================================

function ranks(values: number[]): number[] {
  const idx = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const out = new Array<number>(values.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1].v === idx[i].v) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[idx[k].i] = avg;
    i = j + 1;
  }
  return out;
}

function pearson(a: number[], b: number[]): number | null {
  const n = a.length;
  if (n < 3) return null;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  if (da === 0 || db === 0) return null;
  return num / Math.sqrt(da * db);
}

function spearman(a: number[], b: number[]): number | null {
  return pearson(ranks(a), ranks(b));
}

/**
 * 劣化なしの素材に対するMOSがこれを下回ったら、素材がモデルの学習分布から
 * 外れていると判断する。モデルは劣化ではなく素材の不自然さを評価しており、
 * 条件ごとの相関を読んでも意味がない。
 */
const MOS_TRUSTWORTHY_BASELINE = 3.0;

/**
 * DNSMOS の入力は16kHzモノラル。これを超える帯域の違いは原理的に見えない。
 * 帯域制限の条件を解釈するときに必要な注意。
 */
const MOS_VISIBLE_HZ = 8000;

/** 条件ごとのMOS相関と、その信号にそもそも情報があるか */
interface MosConditionStat {
  rho: number | null;
  n: number;
  /** 異なるMOS値の個数。1なら劣化がモデルに見えていない */
  distinct: number;
  /** MOSの振れ幅 */
  spread: number;
}

function round(v: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

// ==========================================================================
// 1件ぶんの評価
// ==========================================================================

/**
 * 素材ごとの「劣化なしの傾斜」。tilt条件の真値の土台になる。
 *
 * 注入した傾き[dB/oct]は素材の自然な傾斜に足される量なので、真値は
 * 「素材の傾斜 + 注入量」。素材の傾斜は劣化なしの行を実測して得る。
 * 4話者で -2.4〜-8.8dB/oct と幅があり、共通の定数では代用できない。
 */
const baseSlopeBySource = new Map<string, number | null>();

function baseSlopeOf(source: string): number | null {
  return baseSlopeBySource.get(source) ?? null;
}
function evaluate(item: ManifestItem, samples: Float32Array, mos: number | null): Row {
  const sr = item.sampleRate;
  const scores = analyzeSamples(samples, sr);
  const prov = detectProvenance(samples, sr);
  const reverbEst = estimateReverb(samples, sr);
  // ノイズフロアの推定に使えた無音フレーム数を診断値として持ち出すため、
  // 条件ごとの switch の外で1回だけ呼ぶ。引数は case 'snr' と同じ。
  const snrEst = estimateSnr(samples, sr, reverbEst.rt60Sec);

  let truthValue: number | null = null;
  let estimate: number | null = null;
  let errorLabel = '';

  // 劣化なしの行で素材の自然な傾斜を記録しておく（tilt条件の真値の土台）。
  // manifest は素材ごとに clean を先に並べているので、tilt条件の評価時には揃っている。
  if (item.condition.type === 'clean') {
    baseSlopeBySource.set(item.source, estimateSpectralSlope(samples, sr, prov.bandwidthHz));
  }

  switch (item.condition.type) {
    case 'snr': {
      truthValue = item.truth.snrDb;
      estimate = snrEst.snrDb;
      errorLabel = 'SNR[dB]';
      break;
    }
    case 'cutoff': {
      truthValue = item.truth.cutoffHz;
      estimate = prov.bandwidthHz;
      errorLabel = '帯域上限[Hz]';
      break;
    }
    case 'clip': {
      truthValue = item.truth.clipRateActive;
      estimate = estimateClipping(samples).clipRate;
      errorLabel = 'クリップ率(有音基準)';
      break;
    }
    case 'drr': {
      // 直接音対残響比を推定する器は無い（無参照では難しい）。ここで見るのは
      // 「RT60を固定してマイク位置だけ変えたとき、残響軸が動くか」だけなので、
      // 単調性の軸としてのみ真値を使い、推定値は置かない（誤差表に混ぜない）。
      truthValue = item.truth.drrDb;
      estimate = null;
      errorLabel = '';
      break;
    }
    case 'level': {
      truthValue = item.truth.activeSpeechDbfs;
      estimate = estimateLevel(samples, sr).activeSpeechDbfs;
      errorLabel = '有効音声レベル[dBFS]';
      break;
    }
    case 'tilt': {
      // 注入した傾きは 1kHz 以上に足した分。素材自身の自然な傾斜が土台にあるので、
      // 真値は「素材の傾斜 + 注入量」。素材の傾斜は劣化なしの行から取る。
      const baseSlope = baseSlopeOf(item.source);
      truthValue = baseSlope === null ? null : baseSlope + item.truth.tiltDbPerOct;
      estimate = estimateSpectralSlope(samples, sr, prov.bandwidthHz);
      errorLabel = '1kHz以上の傾斜[dB/oct]';
      break;
    }
    case 'rt60': {
      truthValue = item.truth.rt60Sec;
      estimate = reverbEst.rt60Sec;
      errorLabel = 'RT60[秒]';
      break;
    }
    case 'rt60band': {
      // 真値は中帯域のRT60。ISO 3382 が代表値とする 500Hz/1kHz オクターブの平均に対応する。
      truthValue = item.truth.rt60Sec;
      estimate = reverbEst.rt60Sec;
      errorLabel = 'RT60[秒] (帯域依存)';
      break;
    }
    case 'rt60rep': {
      // 真値を固定して乱数だけ振る条件。誤差そのものより「判定が同じ答えを返すか」を見る。
      // 誤差表にも出るが、真値が2水準しか無いので rt60 条件とは別の行に分ける。
      truthValue = item.truth.rt60Sec;
      estimate = reverbEst.rt60Sec;
      errorLabel = 'RT60[秒] (再現性)';
      break;
    }
    case 'snrbabble': {
      truthValue = item.truth.snrDb;
      estimate = snrEst.snrDb;
      errorLabel = 'SNR[dB] (多人数の話し声)';
      break;
    }
    case 'snrimpulse': {
      truthValue = item.truth.snrDb;
      estimate = snrEst.snrDb;
      errorLabel = 'SNR[dB] (衝撃性ノイズ)';
      break;
    }
    case 'pauses': {
      // SNRは固定し、間（無音区間）の量だけを変えた条件。誤差が動いたら、
      // それは環境ではなく喋り方への依存である。
      truthValue = item.truth.snrDb;
      estimate = snrEst.snrDb;
      errorLabel = 'SNR[dB] (間が少ない発話)';
      break;
    }
    default:
      errorLabel = '';
  }

  return {
    id: item.id,
    source: item.source,
    conditionType: item.condition.type,
    params: item.condition.params,
    truthValue,
    estimate,
    errorLabel,
    scores: {
      overall: scores.overall,
      volume: scores.volume,
      frequency: scores.frequency,
      reverb: scores.reverb,
      clip: scores.clip,
      noise: scores.noise,
    },
    decayEvents: reverbEst.events,
    noiseFrames: snrEst.noiseFrames,
    decayEventsT20: reverbEst.perEventDropDb.filter((d) => d >= T20_DROP_DB).length,
    rt60Estimate: reverbEst.rt60Sec,
    rt60Truth: item.truth.rt60Sec ?? null,
    bandwidthHz: prov.bandwidthHz,
    flags: prov.flags,
    unreliable: scores.unreliable,
    verdict: scores.verdict.level,
    verdictUnconfirmed: scores.verdict.unconfirmed,
    advice: scores.advice.map((a) => a.code),
    mos,
  };
}

// ==========================================================================
// 集計
// ==========================================================================

interface ErrorStat {
  conditionType: string;
  label: string;
  n: number;
  bias: number;
  mae: number;
  maxAbs: number;
  worst: { id: string; truth: number; estimate: number };
}

/**
 * 条件ごとの推定誤差。groupBy を渡すと条件×グループで分ける。
 * 素材（話者）ごとに分けると、推定器が特定の声質に依存していないかが見える。
 */
function errorStats(rows: Row[], groupBy?: (r: Row) => string): ErrorStat[] {
  const byType = new Map<string, Row[]>();
  for (const r of rows) {
    if (r.truthValue === null || r.estimate === null) continue;
    const key = groupBy ? `${r.conditionType} / ${groupBy(r)}` : r.conditionType;
    const list = byType.get(key) ?? [];
    list.push(r);
    byType.set(key, list);
  }

  const out: ErrorStat[] = [];
  for (const [type, list] of byType) {
    let sum = 0, abs = 0, maxAbs = 0;
    let worst = list[0];
    for (const r of list) {
      const e = (r.estimate as number) - (r.truthValue as number);
      sum += e;
      abs += Math.abs(e);
      if (Math.abs(e) > maxAbs) { maxAbs = Math.abs(e); worst = r; }
    }
    out.push({
      conditionType: type,
      label: list[0].errorLabel,
      n: list.length,
      bias: round(sum / list.length, 3),
      mae: round(abs / list.length, 3),
      maxAbs: round(maxAbs, 3),
      worst: {
        id: worst.id,
        truth: round(worst.truthValue as number, 4),
        estimate: round(worst.estimate as number, 4),
      },
    });
  }
  return out.sort((a, b) => a.conditionType.localeCompare(b.conditionType));
}

// ==========================================================================
// 配点の検証
// ==========================================================================

/**
 * 軸の配点（ノイズ25 / 周波数25 / 残響20 / 音量15 / 音割れ15）が妥当かを、
 * MOSオラクルとの順位相関で確かめる。
 *
 * 単独条件では配点を検証できない。「ノイズが強い録音」と「残響が長い録音」の
 * どちらを低く評価すべきかという比較を含まないため。複合条件(mixed)だけを使う。
 *
 * **これは最適化ではなく粗い誤りの検出。** DNSMOS は8kHz超の帯域差が見えないので、
 * 相関を最大化するように重みを振ると必ず周波数軸の配点が下がる——モデルの盲点に
 * 合わせているだけで、判定として良くなったわけではない。候補間で相関が大きく
 * 開かないなら「この方法では配点を決められない」が結論。
 */
interface WeightCandidate {
  name: string;
  weights: Record<string, number>;
}

const WEIGHT_CANDIDATES: WeightCandidate[] = [
  { name: '現行', weights: { noise: 25, frequency: 25, reverb: 20, volume: 15, clip: 15 } },
  { name: '均等', weights: { noise: 20, frequency: 20, reverb: 20, volume: 20, clip: 20 } },
  { name: 'ノイズ重視', weights: { noise: 40, frequency: 15, reverb: 20, volume: 10, clip: 15 } },
  { name: '残響重視', weights: { noise: 25, frequency: 15, reverb: 35, volume: 10, clip: 15 } },
  { name: '周波数軽視', weights: { noise: 30, frequency: 10, reverb: 30, volume: 15, clip: 15 } },
  { name: '周波数重視', weights: { noise: 20, frequency: 40, reverb: 15, volume: 10, clip: 15 } },
];

/**
 * 周波数軸を25点に固定したまま、残る75点をノイズ/残響/音量/音割れに振り直す候補。
 *
 * 周波数の配点だけはこの方法で決められない。帯域制限を含まない条件では周波数軸に
 * 信号が無いので、その配点を下げれば必ず相関は上がる（無情報な軸が総合点を薄めて
 * いるぶんが消えるだけ）。帯域制限を含む条件でも DNSMOS は帯域差を見られない。
 * どちらの群でも「周波数を下げろ」しか出ないので、その問いはここでは扱わない。
 *
 * 一方 ノイズ/残響/音割れ の相対的な重みは DNSMOS が実際に反応する要因なので、
 * 周波数を固定して比べれば答えが出る。
 */
const WEIGHT_CANDIDATES_FIXED_FREQ: WeightCandidate[] = [
  { name: '現行', weights: { noise: 25, frequency: 25, reverb: 20, volume: 15, clip: 15 } },
  { name: 'ノイズ寄せ', weights: { noise: 35, frequency: 25, reverb: 15, volume: 10, clip: 15 } },
  { name: '残響寄せ', weights: { noise: 15, frequency: 25, reverb: 30, volume: 15, clip: 15 } },
  { name: '音割れ寄せ', weights: { noise: 20, frequency: 25, reverb: 15, volume: 15, clip: 25 } },
  { name: '音量を削る', weights: { noise: 30, frequency: 25, reverb: 25, volume: 5, clip: 15 } },
  { name: 'ノイズと残響に集中', weights: { noise: 35, frequency: 25, reverb: 30, volume: 5, clip: 5 } },
];

interface WeightResult {
  name: string;
  weights: Record<string, number>;
  /** 素材ごとに求めて平均した順位相関 */
  rho: number | null;
  /** 全素材まとめての順位相関（素材間の水準差が混ざる。参考） */
  rhoPooled: number | null;
}

interface WeightingGroup {
  /** この群の説明 */
  label: string;
  n: number;
  mosSpread: number;
  candidates: WeightResult[];
  /** 周波数25点固定で残りを振り直した候補 */
  fixedFreq: WeightResult[];
  /**
   * 軸ごとの達成率とMOSの順位相関。
   * オラクルがどの要因に反応しているかが分かる。反応していない軸の配点は
   * この方法では決められない。
   */
  axisRho: Record<string, number | null>;
}

interface WeightingReport {
  n: number;
  mosSpread: number;
  mosDistinct: number;
  candidates: WeightResult[];
  /**
   * 帯域制限を含む条件と含まない条件に分けた結果。
   *
   * DNSMOS の入力は16kHzなので帯域制限の影響を正しく評価できない。分けずに見ると、
   * 周波数軸がスコアを動かしてもMOSが動かないぶんが相関の低下として現れ、
   * 「配点が悪い」と読み違える。含まない群でモデルが全要因を見ているはず。
   */
  groups: WeightingGroup[];
}

/** 軸スコアを重み付けし直して総合点を組み直す */
function reweight(scores: Row['scores'], weights: Record<string, number>): number {
  let sum = 0, total = 0;
  for (const [axis, w] of Object.entries(weights)) {
    const max = AXIS_MAX[axis as keyof typeof AXIS_MAX];
    if (max == null) continue;
    sum += (scores[axis as keyof Row['scores']] / max) * w;
    total += w;
  }
  return total > 0 ? (sum / total) * 100 : 0;
}

/** 素材ごとに順位相関を求めて平均する（素材間の水準差を混ぜないため） */
function weightRhos(list: Row[], cands: WeightCandidate[] = WEIGHT_CANDIDATES): WeightResult[] {
  const bySource = new Map<string, Row[]>();
  for (const r of list) bySource.set(r.source, [...(bySource.get(r.source) ?? []), r]);
  const mos = list.map((r) => r.mos as number);

  return cands.map((c) => {
    const rhos: number[] = [];
    for (const group of bySource.values()) {
      if (group.length < 3) continue;
      const rho = spearman(
        group.map((r) => r.mos as number),
        group.map((r) => reweight(r.scores, c.weights)),
      );
      if (rho !== null) rhos.push(rho);
    }
    return {
      name: c.name,
      weights: c.weights,
      rho: rhos.length > 0 ? round(rhos.reduce((a, b) => a + b, 0) / rhos.length, 3) : null,
      rhoPooled: round(spearman(mos, list.map((r) => reweight(r.scores, c.weights))) ?? 0, 3),
    };
  });
}

/**
 * 判定（良好 / 使える / 不可）が、借り物の基準の上で実際に分離しているか。
 *
 * 閾値（達成率75%で良好 / 50%で使える）は目的からの判断で置いた初期値。
 * 「良好」の群と「不可」の群でMOSの分布が重なっているなら、閾値は意味をなしていない。
 *
 * 判定は**最弱の軸**で決まるので、複合条件（複数の軸が同時に下がる条件）でこそ
 * 意味を持つ。単独条件では常に同じ軸が最弱になる。
 */
interface VerdictStat {
  level: string;
  n: number;
  mosMean: number | null;
  mosMin: number | null;
  mosMax: number | null;
  /** 参考値扱いの軸があって good を出せなかった件数 */
  unconfirmed: number;
}

function verdictStats(rows: Row[]): VerdictStat[] {
  const list = rows.filter((r) => r.conditionType === 'mixed');
  const out: VerdictStat[] = [];
  for (const level of ['good', 'usable', 'poor']) {
    const g = list.filter((r) => r.verdict === level);
    const mos = g.map((r) => r.mos).filter((v): v is number => v !== null);
    out.push({
      level,
      n: g.length,
      mosMean: mos.length > 0 ? round(mos.reduce((a, b) => a + b, 0) / mos.length, 3) : null,
      mosMin: mos.length > 0 ? round(Math.min(...mos), 3) : null,
      mosMax: mos.length > 0 ? round(Math.max(...mos), 3) : null,
      unconfirmed: g.filter((r) => r.verdictUnconfirmed).length,
    });
  }
  return out;
}

/**
 * 助言の的中と外れ。
 *
 * 助言には注入した物理量から真値が作れる。「帯域上限が7kHz未満なら帯域不足の
 * 助言が出るべき」のように、条件ごとに出るべき/出るべきでないが決まる。
 *
 * **なぜ測るのか。** 採点だけ検証して助言を検証しないと、採点の境界を動かした
 * ときに助言が黙って壊れる。ノイズ軸の満点を25dB→45dBに、帯域幅の満点を
 * 7kHz→16kHzに上げたとき、達成率0.7で判定していた帯域不足の助言が12.2kHz以下
 * すべてに出るようになっていた（8.1kHz帯域は会議音声として問題無いのに
 * 「子音が聞き取りにくい」と言う）。手で気づいたが、次は気づかない。
 *
 * 空振り(FP)は的中(TP)より重い。出すべき助言を1つ落とすより、直さなくてよい
 * ものを直せと言うほうが道具への信頼を損なう。
 */
interface AdviceStat {
  code: string;
  criterion: string;
  /** 真値が「出すべき」だった件数 */
  positives: number;
  /** 真値が「出すべきでない」だった件数 */
  negatives: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  /** 出した助言のうち正しかった割合 */
  precision: number | null;
  /** 出すべき助言のうち出せた割合 */
  recall: number | null;
  /** 外れた行の例（最大3件） */
  worst: Array<{ id: string; truth: number; kind: string }>;
}

/**
 * 助言ごとの真値の定義。
 *
 * `conditionTypes` はその助言の真値が作れる条件。`clean` は「劣化なし」なので
 * どの助言も出るべきでない側の対照として全部に入れる——ただし素材そのものの
 * 性質で出てしまう助言（16kHz素材の帯域不足、話者固有のこもり）は対照に
 * ならないので、その条件では clean を外す。
 */
const ADVICE_TRUTH: Array<{
  code: string;
  criterion: string;
  conditionTypes: string[];
  /** 真値を返す。null なら判定できないので集計から外す */
  shouldAdvise: (r: Row) => boolean | null;
  truthOf: (r: Row) => number;
}> = [
  {
    code: 'bandwidth-narrow',
    criterion: '帯域上限 < 7000Hz',
    conditionTypes: ['cutoff'],
    shouldAdvise: (r) => (r.truthValue === null ? null : r.truthValue < 7000),
    truthOf: (r) => r.truthValue ?? 0,
  },
  {
    code: 'noise-high',
    criterion: 'SNR < 15dB（定常ノイズ）',
    conditionTypes: ['snr', 'clean'],
    shouldAdvise: (r) => (r.conditionType === 'clean' ? false
      : r.truthValue === null ? null : r.truthValue < 15),
    truthOf: (r) => r.truthValue ?? 99,
  },
  {
    // 同じ助言を非定常ノイズだけで別行にする。**まとめてはいけない。**
    // 1行にすると、定常ノイズの良い成績が非定常の見落としを薄めて見えなくなる。
    // 尺度が違うものを混ぜないのは、採点と助言の閾値を分けているのと同じ理由。
    code: 'noise-high',
    criterion: 'SNR < 15dB（非定常: 話し声・打鍵音）',
    conditionTypes: ['snrbabble', 'snrimpulse'],
    shouldAdvise: (r) => (r.truthValue === null ? null : r.truthValue < 15),
    truthOf: (r) => r.truthValue ?? 99,
  },
  {
    code: 'reverb-strong',
    criterion: 'RT60 > 0.6秒',
    conditionTypes: ['rt60', 'clean'],
    // 基準は ANSI S12.60 が小さな教室に求める上限。製品の閾値と同じ値だが、
    // 偶然ではなく両方この規格から取っている。
    shouldAdvise: (r) => (r.conditionType === 'clean' ? false
      : r.rt60Truth === null ? null : r.rt60Truth > 0.6),
    truthOf: (r) => r.rt60Truth ?? 0,
  },
  {
    code: 'clipping',
    criterion: 'クリップした標本が1つ以上',
    conditionTypes: ['clip', 'clean'],
    shouldAdvise: (r) => (r.conditionType === 'clean' ? false : true),
    truthOf: (r) => r.truthValue ?? 0,
  },
  {
    code: 'muffled',
    criterion: '1kHz以上の傾斜 < -14dB/oct',
    conditionTypes: ['tilt', 'clean'],
    // clean を対照に入れられるのは、実音声の自然な傾斜が -2.4〜-8.8dB/oct で
    // 境界から十分離れているため（声の暗い話者でも出ない）。
    shouldAdvise: (r) => (r.conditionType === 'clean' ? false
      : r.truthValue === null ? null : r.truthValue < -14),
    truthOf: (r) => r.truthValue ?? 0,
  },
  {
    code: 'level-low',
    criterion: '有効音声レベル < -30dBFS',
    conditionTypes: ['level'],
    shouldAdvise: (r) => (r.truthValue === null ? null : r.truthValue < -30),
    truthOf: (r) => r.truthValue ?? 0,
  },
];

function adviceStats(rows: Row[]): AdviceStat[] {
  const out: AdviceStat[] = [];
  for (const def of ADVICE_TRUTH) {
    const list = rows.filter((r) => def.conditionTypes.includes(r.conditionType));
    let tp = 0, fp = 0, fn = 0, pos = 0, neg = 0;
    const worst: Array<{ id: string; truth: number; kind: string }> = [];
    for (const r of list) {
      const should = def.shouldAdvise(r);
      if (should === null) continue;
      const did = r.advice.includes(def.code);
      if (should) pos++; else neg++;
      if (should && did) tp++;
      else if (!should && did) { fp++; worst.push({ id: r.id, truth: round(def.truthOf(r), 3), kind: '空振り' }); }
      else if (should && !did) { fn++; worst.push({ id: r.id, truth: round(def.truthOf(r), 3), kind: '見落とし' }); }
    }
    out.push({
      code: def.code,
      criterion: def.criterion,
      positives: pos,
      negatives: neg,
      truePositives: tp,
      falsePositives: fp,
      falseNegatives: fn,
      precision: tp + fp > 0 ? round(tp / (tp + fp), 3) : null,
      recall: pos > 0 ? round(tp / pos, 3) : null,
      worst: worst.slice(0, 3),
    });
  }
  return out;
}

/** 軸ごとの達成率とMOSの順位相関（素材ごとに求めて平均） */
function axisRhoVsMos(list: Row[]): Record<string, number | null> {
  const bySource = new Map<string, Row[]>();
  for (const r of list) bySource.set(r.source, [...(bySource.get(r.source) ?? []), r]);

  const out: Record<string, number | null> = {};
  for (const axis of Object.keys(AXIS_MAX)) {
    const max = AXIS_MAX[axis as keyof typeof AXIS_MAX];
    const rhos: number[] = [];
    for (const group of bySource.values()) {
      if (group.length < 3) continue;
      const rho = spearman(
        group.map((r) => r.mos as number),
        group.map((r) => r.scores[axis as keyof Row['scores']] / max),
      );
      if (rho !== null) rhos.push(rho);
    }
    out[axis] = rhos.length > 0 ? round(rhos.reduce((a, b) => a + b, 0) / rhos.length, 3) : null;
  }
  return out;
}

function weighting(rows: Row[]): WeightingReport | null {
  const list = rows.filter((r) => r.conditionType === 'mixed' && r.mos !== null);
  if (list.length < 6) return null;

  const mos = list.map((r) => r.mos as number);
  const hasCutoff = (r: Row): boolean => r.params.cutoffHz != null;
  const hasClip = (r: Row): boolean => r.params.clipRate != null;
  const groupDefs: { label: string; list: Row[] }[] = [
    // オラクルが実際に反応する要因だけの群。配点の根拠に使えるのはここだけ。
    //
    // DNSMOSの単独条件での振れ幅（実音声4話者・16kHz）:
    //   SNR 0→40dB           MOS 1.563 → 3.317  (振れ幅 1.76)
    //   RT60 0.2→1.5秒        MOS 2.726 → 1.126  (振れ幅 1.60)
    //   クリップ率 0.0002→0.02  MOS 3.316 → 3.161  (振れ幅 0.155)
    //
    // 音割れは100倍にしてもMOSがほとんど動かない。モデルはノイズ抑制の出力で
    // 学習されており音割れの訓練信号をほぼ持たない。音割れ軸の配点をMOS相関で
    // 検証することは原理的にできない。
    {
      label: 'ノイズと残響だけ（オラクルが反応する要因のみ）',
      list: list.filter((r) => !hasCutoff(r) && !hasClip(r)),
    },
    { label: '帯域制限を含まない（音割れは含む）', list: list.filter((r) => !hasCutoff(r)) },
    { label: '帯域制限を含む（モデルは帯域差を見られない）', list: list.filter(hasCutoff) },
  ];

  return {
    n: list.length,
    mosSpread: round(Math.max(...mos) - Math.min(...mos), 3),
    mosDistinct: new Set(mos.map((v) => round(v, 3))).size,
    candidates: weightRhos(list),
    groups: groupDefs
      .filter((g) => g.list.length >= 6)
      .map((g) => ({
        label: g.label,
        n: g.list.length,
        mosSpread: round(
          Math.max(...g.list.map((r) => r.mos as number)) - Math.min(...g.list.map((r) => r.mos as number)),
          3,
        ),
        candidates: weightRhos(g.list),
        fixedFreq: weightRhos(g.list, WEIGHT_CANDIDATES_FIXED_FREQ),
        axisRho: axisRhoVsMos(g.list),
      })),
  };
}

// ==========================================================================
// マイク位置ごとの残響の測定能力
// ==========================================================================

/**
 * 直接音対残響比(DRR)ごとのRT60の誤差と測定不能率。
 *
 * 近似の開始点を発話の立ち下がりより下(-10dB)に置いた副作用として、残響が弱い
 * （=マイクが近い）ほど観測できる減衰が浅くなり、測定できる条件が減る。
 * どのマイク距離まで残響を判定できるのかを数値で押さえる。
 */
interface DrrCapability {
  drrDb: number;
  n: number;
  /** 測定できた件数 */
  measured: number;
  bias: number | null;
  mae: number | null;
  maxAbs: number | null;
  /** 平均の減衰イベント数 */
  events: number;
  /** 残響軸を参考値として開示した件数 */
  unreliable: number;
}

function drrCapability(rows: Row[]): DrrCapability[] {
  const list = rows.filter((r) => r.conditionType === 'drr');
  const byDrr = new Map<number, Row[]>();
  for (const r of list) {
    const k = Number(r.params.targetDrrDb);
    byDrr.set(k, [...(byDrr.get(k) ?? []), r]);
  }

  const out: DrrCapability[] = [];
  for (const [drrDb, group] of [...byDrr].sort((a, b) => b[0] - a[0])) {
    const ok = group.filter((r) => r.rt60Estimate !== null && r.rt60Truth !== null);
    const errs = ok.map((r) => (r.rt60Estimate as number) - (r.rt60Truth as number));
    out.push({
      drrDb,
      n: group.length,
      measured: ok.length,
      bias: errs.length ? round(errs.reduce((a, b) => a + b, 0) / errs.length, 3) : null,
      mae: errs.length ? round(errs.reduce((a, b) => a + Math.abs(b), 0) / errs.length, 3) : null,
      maxAbs: errs.length ? round(Math.max(...errs.map(Math.abs)), 3) : null,
      events: round(group.reduce((a, r) => a + (r.decayEvents ?? 0), 0) / group.length, 1),
      unreliable: group.filter((r) => r.unreliable.includes('reverb')).length,
    });
  }
  return out;
}

// ==========================================================================
// 帯域依存の残響による系統誤差
// ==========================================================================

/**
 * 部屋のプロファイルごとのRT60誤差。
 *
 * `flat` の行が対照で、他との差がそのまま「周波数依存によって増える誤差」になる。
 * 広帯域のレベル列から測る推定器は最も遅く減衰する帯域に引っ張られるので、
 * 低域だけ長い部屋（吸音天井）で最も大きくずれる。
 */
interface BandProfileStat {
  profile: string;
  lowSec: number;
  midSec: number;
  highSec: number;
  n: number;
  measured: number;
  bias: number | null;
  mae: number | null;
  maxAbs: number | null;
  /** flat（平坦な応答）のバイアスとの差。周波数依存だけが持ち込む誤差 */
  excessOverFlat: number | null;
  confident: number;
}

function bandProfileStats(rows: Row[]): BandProfileStat[] {
  const list = rows.filter((r) => r.conditionType === 'rt60band');
  if (list.length === 0) return [];

  const byProfile = new Map<string, Row[]>();
  for (const r of list) {
    const k = String(r.params.profile);
    byProfile.set(k, [...(byProfile.get(k) ?? []), r]);
  }

  const stat = (group: Row[]): { bias: number | null; mae: number | null; maxAbs: number | null; measured: number } => {
    const ok = group.filter((r) => r.estimate !== null && r.truthValue !== null);
    const errs = ok.map((r) => (r.estimate as number) - (r.truthValue as number));
    return {
      measured: ok.length,
      bias: errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : null,
      mae: errs.length ? errs.reduce((a, b) => a + Math.abs(b), 0) / errs.length : null,
      maxAbs: errs.length ? Math.max(...errs.map(Math.abs)) : null,
    };
  };

  const flatBias = byProfile.has('flat') ? stat(byProfile.get('flat') as Row[]).bias : null;

  const out: BandProfileStat[] = [];
  for (const [profile, group] of byProfile) {
    const s = stat(group);
    out.push({
      profile,
      lowSec: Number(group[0].params.lowSec),
      midSec: Number(group[0].params.midSec),
      highSec: Number(group[0].params.highSec),
      n: group.length,
      measured: s.measured,
      bias: s.bias === null ? null : round(s.bias, 3),
      mae: s.mae === null ? null : round(s.mae, 3),
      maxAbs: s.maxAbs === null ? null : round(s.maxAbs, 3),
      excessOverFlat: s.bias === null || flatBias === null ? null : round(s.bias - flatBias, 3),
      confident: group.filter((r) => !r.unreliable.includes('reverb')).length,
    });
  }
  // 平坦を先頭に置く（対照だから）。あとは中帯域のRT60順
  return out.sort((a, b) =>
    (a.profile === 'flat' ? -1 : b.profile === 'flat' ? 1 : a.midSec - b.midSec));
}

// ==========================================================================
// 間（無音区間）の量とSNRの測定能力
// ==========================================================================

/**
 * 間の量ごとのSNR誤差。
 *
 * README は「話者の喋り方（声量のムラ、間の取り方）は評価しない。環境の評価では
 * ないため」と宣言している。SNRを固定して間だけを変えたときに誤差が動くなら、
 * **その宣言はノイズ軸については成り立っていない。**
 *
 * `無音フレーム` の列も併記する。0 になっている行は推定器がパーセンタイル代替に
 * 落ちている（=下限を割った）ことを意味する。
 */
interface PauseStat {
  keepRatio: number;
  /** 実際に残った無音フレームの割合 */
  silenceRatio: number;
  n: number;
  bias: number | null;
  mae: number | null;
  maxAbs: number | null;
  /** ノイズフロアの推定に使えた無音フレーム数の平均 */
  noiseFrames: number;
  /** パーセンタイル代替に落ちた件数 */
  fellBack: number;
}

function pauseStats(rows: Row[]): PauseStat[] {
  const list = rows.filter((r) => r.conditionType === 'pauses');
  if (list.length === 0) return [];

  const byKeep = new Map<number, Row[]>();
  for (const r of list) {
    const k = Number(r.params.keepRatio);
    byKeep.set(k, [...(byKeep.get(k) ?? []), r]);
  }

  const out: PauseStat[] = [];
  for (const [keepRatio, group] of [...byKeep].sort((a, b) => b[0] - a[0])) {
    const ok = group.filter((r) => r.estimate !== null && r.truthValue !== null);
    const errs = ok.map((r) => (r.estimate as number) - (r.truthValue as number));
    out.push({
      keepRatio,
      silenceRatio: round(
        group.reduce((a, r) => a + Number(r.params.silenceRatio ?? 0), 0) / group.length, 3),
      n: group.length,
      bias: errs.length ? round(errs.reduce((a, b) => a + b, 0) / errs.length, 3) : null,
      mae: errs.length ? round(errs.reduce((a, b) => a + Math.abs(b), 0) / errs.length, 3) : null,
      maxAbs: errs.length ? round(Math.max(...errs.map(Math.abs)), 3) : null,
      noiseFrames: round(group.reduce((a, r) => a + (r.noiseFrames ?? 0), 0) / group.length, 1),
      fellBack: group.filter((r) => (r.noiseFrames ?? 0) === 0).length,
    });
  }
  return out;
}

/** ISO 3382 の T20 に相当する落差[dB]（−5〜−25dB） */
const T20_DROP_DB = 20;

// ==========================================================================
// 判定の不確かさの定数と実測の突き合わせ
// ==========================================================================

/**
 * `AXIS_RATIO_UNCERTAINTY` が実測MAEより楽観になっていないかの検算。
 *
 * あの定数は「境界からこの距離までは断定しない」という安全距離で、
 * validation の実測MAEから換算して決めている。**推定器を変えたときに
 * 定数を更新し忘れると、黙って断定しすぎるようになる。** それを機械で捕まえる。
 *
 * 換算に使う係数は AudioAnalyzer が公開している（採点の境界を動かしたら
 * 係数も一緒に動く。数値をこちら側に写すと二重管理になる）。
 */
interface UncertaintyCheck {
  axis: string;
  /** 換算の元にした実測 */
  basis: string;
  measuredMae: number;
  measuredRatio: number;
  constant: number;
  /** 定数が実測より楽観なら true（= 断定しすぎる） */
  optimistic: boolean;
}

function uncertaintyChecks(rows: Row[]): UncertaintyCheck[] {
  const out: UncertaintyCheck[] = [];

  const mae = (list: Row[]): number | null => {
    const e = list
      .filter((r) => r.estimate !== null && r.truthValue !== null)
      .map((r) => Math.abs((r.estimate as number) - (r.truthValue as number)));
    return e.length ? e.reduce((a, b) => a + b, 0) / e.length : null;
  };

  // 残響は確定値の集合で測る。参考値の行は unreliable 経由で別に断定を止めるので、
  // 定数の根拠に混ぜると二重に安全側へ寄る。
  const reverbConfident = rows.filter(
    (r) => ['rt60', 'rt60band', 'rt60rep'].includes(r.conditionType)
      && !r.unreliable.includes('reverb'));
  const reverbMae = mae(reverbConfident);
  if (reverbMae !== null) {
    const ratio = reverbMae * AXIS_RATIO_PER_UNIT.reverbPerSec;
    out.push({
      axis: 'reverb',
      basis: `確定値のRT60 MAE (n=${reverbConfident.length})`,
      measuredMae: round(reverbMae, 3),
      measuredRatio: round(ratio, 3),
      constant: AXIS_RATIO_UNCERTAINTY.reverb,
      optimistic: ratio > AXIS_RATIO_UNCERTAINTY.reverb,
    });
  }

  // ノイズは定常＋多人数の話し声。衝撃性ノイズは provenance の申告で扱うので
  // 除く（含めると定数が 0.2 を超え、ノイズ軸で何も断定できなくなる）。
  const noiseRows = rows.filter((r) => ['snr', 'snrbabble'].includes(r.conditionType));
  const noiseMae = mae(noiseRows);
  if (noiseMae !== null) {
    const ratio = noiseMae * AXIS_RATIO_PER_UNIT.noisePerDb;
    out.push({
      axis: 'noise',
      basis: `SNR MAE（定常＋話し声, n=${noiseRows.length}）`,
      measuredMae: round(noiseMae, 3),
      measuredRatio: round(ratio, 3),
      constant: AXIS_RATIO_UNCERTAINTY.noise,
      optimistic: ratio > AXIS_RATIO_UNCERTAINTY.noise,
    });
  }

  return out;
}

// ==========================================================================
// 減衰の落差ごとのRT60誤差
// ==========================================================================

/**
 * 「T20相当の落差に届いたイベント数」で層別したRT60誤差。
 *
 * 現在の `confident`（参考値かどうか）の条件はイベント数だけで、落差は見ていない。
 * ISO 3382 の T20 は −5〜−25dB の20dBを×3に外挿するが、この実装は10dBを×6に
 * 外挿しているので、曲率と雑音の影響が2倍に拡大される。
 *
 * **落差を条件に足すべきかは、この表が支持するかどうかで決める。** 深い落差を
 * 要求すると測定できる条件が減るというトレードオフがあるので、
 * 誤差が下がるだけでは足りない（測れる件数も見る）。
 */
interface DropStratum {
  label: string;
  n: number;
  measured: number;
  bias: number | null;
  mae: number | null;
  maxAbs: number | null;
  /** 現在の実装が確定値として出した件数 */
  confidentNow: number;
}

function dropStrata(rows: Row[]): DropStratum[] {
  const list = rows.filter(
    (r) => ['rt60', 'rt60band', 'rt60rep'].includes(r.conditionType) && r.rt60Truth !== null);
  if (list.length === 0) return [];

  const buckets: Array<{ label: string; test: (n: number) => boolean }> = [
    { label: '0件', test: (n) => n === 0 },
    { label: '1件', test: (n) => n === 1 },
    { label: '2〜3件', test: (n) => n >= 2 && n <= 3 },
    { label: '4件以上', test: (n) => n >= 4 },
  ];

  const out: DropStratum[] = [];
  for (const b of buckets) {
    const group = list.filter((r) => b.test(r.decayEventsT20 ?? 0));
    if (group.length === 0) continue;
    const ok = group.filter((r) => r.rt60Estimate !== null);
    const errs = ok.map((r) => (r.rt60Estimate as number) - (r.rt60Truth as number));
    out.push({
      label: b.label,
      n: group.length,
      measured: ok.length,
      bias: errs.length ? round(errs.reduce((a, x) => a + x, 0) / errs.length, 3) : null,
      mae: errs.length ? round(errs.reduce((a, x) => a + Math.abs(x), 0) / errs.length, 3) : null,
      maxAbs: errs.length ? round(Math.max(...errs.map(Math.abs)), 3) : null,
      confidentNow: group.filter((r) => !r.unreliable.includes('reverb')).length,
    });
  }
  return out;
}

// ==========================================================================
// 衝撃性ノイズの検出
// ==========================================================================

/**
 * `impulsive-noise` フラグの的中と空振り。
 *
 * ノイズ軸はこの種のノイズに無反応なので、**スコアで表現できない事実を
 * フラグで申告する**。助言と同じ扱いで、空振りは見落としより重い。
 *
 * 陽性は `snrimpulse` 条件だけ。他のすべての条件（劣化なし・定常ノイズ・
 * 多人数の話し声・残響・帯域制限…）が陰性で、そこに1件でも出たら空振りである。
 */
interface ImpulseDetection {
  positives: number;
  negatives: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number | null;
  recall: number | null;
  /** 空振りした行（条件の種類つき） */
  falsePositiveIds: string[];
}

function impulseDetection(rows: Row[]): ImpulseDetection | null {
  const list = rows.filter((r) => r.conditionType === 'snrimpulse');
  if (list.length === 0) return null;

  let tp = 0, fp = 0, fn = 0, positives = 0, negatives = 0;
  const falsePositiveIds: string[] = [];
  for (const r of rows) {
    const should = r.conditionType === 'snrimpulse';
    const flagged = r.flags.includes('impulsive-noise');
    if (should) positives++; else negatives++;
    if (should && flagged) tp++;
    else if (!should && flagged) {
      fp++;
      if (falsePositiveIds.length < 5) falsePositiveIds.push(`${r.id} (${r.conditionType})`);
    } else if (should && !flagged) fn++;
  }

  return {
    positives, negatives,
    truePositives: tp, falsePositives: fp, falseNegatives: fn,
    precision: tp + fp > 0 ? round(tp / (tp + fp), 3) : null,
    recall: positives > 0 ? round(tp / positives, 3) : null,
    falsePositiveIds,
  };
}

// ==========================================================================
// 判定の再現性
// ==========================================================================

/**
 * 真値を固定して乱数だけを振ったときの、判定のばらつき。
 *
 * 誤差表は「真値をずらしたときにどれだけ当たるか」を測る。しかしこの道具の出力は
 * 3値の判定なので、利用者にとって意味があるのは**同じ部屋を測り直して同じ答えが
 * 出るか**である。推定誤差が判定境界の間隔より広ければ、判定は測定ではなく抽選になる。
 */
interface ReproducibilityStat {
  rt60Sec: number;
  n: number;
  measured: number;
  estimateMin: number | null;
  estimateMax: number | null;
  reverbScoreMin: number;
  reverbScoreMax: number;
  good: number;
  usable: number;
  poor: number;
  unconfirmed: number;
  /** 残響の助言が出た件数 */
  advisedReverb: number;
}

function reproducibility(rows: Row[]): ReproducibilityStat[] {
  const list = rows.filter((r) => r.conditionType === 'rt60rep');
  if (list.length === 0) return [];

  const byRt60 = new Map<number, Row[]>();
  for (const r of list) {
    const k = Number(r.params.rt60Sec);
    byRt60.set(k, [...(byRt60.get(k) ?? []), r]);
  }

  const out: ReproducibilityStat[] = [];
  for (const [rt60Sec, group] of [...byRt60].sort((a, b) => a[0] - b[0])) {
    const ests = group.map((r) => r.estimate).filter((v): v is number => v !== null);
    out.push({
      rt60Sec,
      n: group.length,
      measured: ests.length,
      estimateMin: ests.length ? round(Math.min(...ests), 3) : null,
      estimateMax: ests.length ? round(Math.max(...ests), 3) : null,
      reverbScoreMin: Math.min(...group.map((r) => r.scores.reverb)),
      reverbScoreMax: Math.max(...group.map((r) => r.scores.reverb)),
      good:   group.filter((r) => r.verdict === 'good').length,
      usable: group.filter((r) => r.verdict === 'usable').length,
      poor:   group.filter((r) => r.verdict === 'poor').length,
      unconfirmed: group.filter((r) => r.verdictUnconfirmed).length,
      advisedReverb: group.filter((r) => r.advice.includes('reverb-strong')).length,
    });
  }
  return out;
}

/** 劣化の強さとスコアの向きが合っているか */
interface Monotonicity {
  conditionType: string;
  axis: string;
  /**
   * 期待する符号。+1 なら「真値が大きいほどスコアが高い」、-1 はその逆。
   * 0 は「この条件に反応してはいけない」— 別の要因を誤って減点していないかの監視。
   */
  expectedSign: number;
  rho: number | null;
  /**
   * その軸のスコアが実際に動いた幅[点]。
   *
   * 順位相関はスケールフリーなので、25点満点で1.2点しか動かない結合と
   * 12点動く結合を同じ値で報告してしまう。効果量を併記しないと、
   * 無視できるズレを直そうとして本質的な精度を落とす判断をしかねない
   * （実際にSNR精度を9dB犠牲にする方向へ動かしかけた）。
   */
  axisRange: number;
  /** その軸の満点。axisRange を相対で読むため */
  axisMax: number;
  verdict: 'ok' | 'weak' | 'wrong-direction' | 'blind' | 'coupled' | 'insufficient';
}

/** 期待符号0の行で「結合している」と判定する効果量の下限（満点に対する割合） */
const COUPLING_EFFECT_RATIO = 0.1;

const MONOTONICITY_TARGETS: Array<{ type: string; axis: keyof Row['scores']; expectedSign: number }> = [
  { type: 'snr',    axis: 'noise',     expectedSign: +1 }, // SNRが高いほどノイズ点は高い
  { type: 'clip',   axis: 'clip',      expectedSign: -1 }, // クリップ率が高いほど音割れ点は低い
  { type: 'cutoff', axis: 'frequency', expectedSign: +1 }, // 帯域が広いほど周波数点は高いべき
  { type: 'rt60',   axis: 'reverb',    expectedSign: -1 }, // 残響が長いほど残響点は低い
  // 残響エネルギーは信号由来。ノイズ軸が反応したら二重減点なので、無相関が正しい。
  { type: 'rt60',   axis: 'noise',     expectedSign:  0 },
  // 傾きが緩い（0に近い）ほど周波数点は高いべき。帯域は削っていないので、
  // 帯域幅の内訳ではなく「明瞭度」の内訳が反応するはず。
  { type: 'tilt',   axis: 'frequency', expectedSign: +1 },
  // 音量軸は範囲に収まっているかを見るので、本来は単調ではない（両端で減点する）。
  // ただし上側はピーク上限に当たって -12dBFS 以上に到達できないため、実際に
  // 観測できるのは「小さすぎる側」だけになる。その範囲では単調増加が正しい。
  { type: 'level',  axis: 'volume',    expectedSign: +1 },
  // 直接音対残響比が大きい（=マイクが近い）ほど残響は乗らないので、残響点は高い。
  // これは欠陥ではなく実際の聞こえ方だが、「部屋の評価」としては交絡になる。
  { type: 'drr',    axis: 'reverb',    expectedSign: +1 },
  // 非定常ノイズでも、SNRが高いほどノイズ点は高いべき。定常ノイズ(snr)と同じ推定器を
  // 使っているので、同じ期待符号で並べれば「どのノイズなら測れているか」が読める。
  { type: 'snrbabble',  axis: 'noise', expectedSign: +1 },
  // 衝撃性ノイズは実測で `blind`（推定値が真値と無相関）になる。**これは想定どおりの
  // 失敗ではなく、記録しておくべき盲点である。** 直したら ok に変わる。
  { type: 'snrimpulse', axis: 'noise', expectedSign: +1 },
  // rt60band はここに入れない。プロファイルは実在する部屋を模して選んでいるので
  // 中帯域のRT60に同値(0.5秒)が2件あり、しかも低域・高域も同時に動く。順位相関の
  // 軸として成立しないので、入れると設計の都合を「blind」と報告してしまう
  // （実際に ρ=-0.115 と出た）。この条件が測るのは向きではなく系統誤差なので、
  // 専用の節（帯域ごとにRT60が違う部屋での系統誤差）で平坦な応答との差を見る。
];

/**
 * 素材ごとに順位相関を出して平均する。
 *
 * 全素材をまとめて1つの相関にすると、素材間でスコアの水準が違うだけで
 * 相関が下がる（実測で帯域→周波数が 1素材 0.827 → 4素材 0.535 に落ちた。
 * 素材ごとには単調なのに、水準差が混ざって順位が乱れていた）。
 */
function pooledSpearman(list: Row[], axis: keyof Row['scores']): number | null {
  const bySource = new Map<string, Row[]>();
  for (const r of list) {
    bySource.set(r.source, [...(bySource.get(r.source) ?? []), r]);
  }
  const rhos: number[] = [];
  for (const group of bySource.values()) {
    if (group.length < 3) continue;
    const rho = spearman(group.map((r) => r.truthValue as number), group.map((r) => r.scores[axis]));
    if (rho !== null) rhos.push(rho);
  }
  if (rhos.length === 0) {
    // 素材ごとに分けられない場合は全体でまとめて計算する
    return spearman(list.map((r) => r.truthValue as number), list.map((r) => r.scores[axis]));
  }
  return rhos.reduce((a, b) => a + b, 0) / rhos.length;
}

function monotonicity(rows: Row[]): Monotonicity[] {
  return MONOTONICITY_TARGETS.map(({ type, axis, expectedSign }) => {
    const list = rows.filter((r) => r.conditionType === type && r.truthValue !== null);
    const axisMax = AXIS_MAX[axis as keyof typeof AXIS_MAX] ?? 100;
    if (list.length < 3) {
      return {
        conditionType: type, axis, expectedSign, rho: null,
        axisRange: 0, axisMax, verdict: 'insufficient' as const,
      };
    }

    // 真値ごとに軸スコアを平均してから振れ幅を取る（個体差を平均で吸収する）
    const byTruth = new Map<number, number[]>();
    for (const r of list) {
      const k = r.truthValue as number;
      byTruth.set(k, [...(byTruth.get(k) ?? []), r.scores[axis]]);
    }
    const means = [...byTruth.values()].map((v) => v.reduce((a, b) => a + b, 0) / v.length);
    const axisRange = round(Math.max(...means) - Math.min(...means), 2);

    const rho = pooledSpearman(list, axis);
    if (rho === null) {
      return {
        conditionType: type, axis, expectedSign, rho: null,
        axisRange, axisMax, verdict: 'blind' as const,
      };
    }
    return {
      conditionType: type, axis, expectedSign, rho: round(rho, 3),
      axisRange, axisMax,
      verdict: verdictFor(rho, expectedSign, axisRange, axisMax),
    };
  });
}

// ==========================================================================
// レポート出力
// ==========================================================================

function verdictFor(
  rho: number,
  expectedSign: number,
  axisRange = 0,
  axisMax = 100,
): Monotonicity['verdict'] {
  // 期待符号0 = この条件に反応してはいけない（別要因の誤計上の監視）。
  // 相関の有無だけでなく効果量も見る。満点の10%も動いていない結合を
  // 「欠陥」として扱うと、それを直すために本質的な精度を落としかねない。
  if (expectedSign === 0) {
    const meaningful = Math.abs(rho) >= 0.3 && axisRange >= axisMax * COUPLING_EFFECT_RATIO;
    return meaningful ? 'coupled' : 'ok';
  }
  const signed = rho * expectedSign;
  if (signed >= 0.7) return 'ok';
  if (signed <= -0.3) return 'wrong-direction';
  if (Math.abs(rho) < 0.2) return 'blind';
  return 'weak';
}

const VERDICT_TEXT: Record<Monotonicity['verdict'], string> = {
  ok:                '想定どおり',
  weak:              '方向は合っているが弱い',
  'wrong-direction': '**逆方向に動いている（欠陥）**',
  blind:             '**まったく反応していない（測っていない）**',
  coupled:           '**反応してはいけない条件に反応している（別要因の誤計上）**',
  insufficient:      'サンプル不足',
};

function renderMarkdown(report: ReturnType<typeof buildReport>): string {
  const L: string[] = [];
  L.push('# 検証レポート — 音質判定の推定誤差');
  L.push('');
  L.push('`npm run validate` の出力。人間のラベル付けは使っていない。');
  L.push('注入した既知の物理量を推定器が復元できるかを測っている。');
  L.push('');
  L.push(`- 生成日時: ${report.generatedAt}`);
  L.push(`- 素材: ${report.sources.join(', ')}`);
  L.push(`- 件数: ${report.itemCount}`);
  L.push(`- MOSオラクル: ${report.mos.available ? `有効 (${report.mos.note})` : `無効 (${report.mos.note})`}`);
  L.push('');

  L.push('## 1. 推定誤差');
  L.push('');
  L.push('| 条件 | 推定対象 | 件数 | バイアス(平均誤差) | MAE | 最大誤差 | 最悪ケース |');
  L.push('|---|---|---:|---:|---:|---:|---|');
  for (const s of report.errors) {
    L.push(
      `| ${s.conditionType} | ${s.label} | ${s.n} | ${s.bias} | ${s.mae} | ${s.maxAbs} | ` +
      `${s.worst.id} (真値 ${s.worst.truth} → 推定 ${s.worst.estimate}) |`,
    );
  }
  L.push('');

  if (report.sources.length > 1) {
    L.push('### 素材ごとの内訳');
    L.push('');
    L.push('推定器が特定の声質・発話速度に依存していないかを見る。');
    L.push('素材間でバイアスの符号が揃わない、あるいはMAEが大きく開く場合は、');
    L.push('その推定器が話者依存の仮定を持っている。');
    L.push('');
    L.push('| 条件 / 素材 | 件数 | バイアス | MAE | 最大誤差 |');
    L.push('|---|---:|---:|---:|---:|');
    for (const s of report.errorsBySource) {
      L.push(`| ${s.conditionType} | ${s.n} | ${s.bias} | ${s.mae} | ${s.maxAbs} |`);
    }
    L.push('');
  }

  if (report.notImplemented.length > 0) {
    L.push('### 未実装の推定器');
    L.push('');
    for (const n of report.notImplemented) {
      L.push(`- **${n.conditionType}** (${n.label}) — ${n.n} 件の検証データを生成済みだが、推定器が無いため誤差を測れない`);
    }
    L.push('');
  }

  L.push('## 2. スコアの単調性（Spearman順位相関）');
  L.push('');
  L.push('劣化を強めたときスコアが正しい向きに動くか。符号が想定と逆なら、その軸は壊れている。');
  L.push('');
  L.push('期待符号が `0 (無相関)` の行は「この条件に反応してはいけない」ことの監視。');
  L.push('反応していたら、別の要因をその軸で誤って減点している。');
  L.push('');
  L.push('ρ は素材ごとに求めて平均している。全素材をまとめると、素材間の水準差だけで');
  L.push('相関が下がってしまうため。効果量（軸スコアが実際に動いた幅）も併記する——');
  L.push('順位相関はスケールフリーなので、無視できるズレと本質的な欠陥を区別できない。');
  L.push('');
  L.push('| 条件 | 見る軸 | 期待符号 | ρ (素材平均) | 効果量 | 判定 |');
  L.push('|---|---|---:|---:|---:|---|');
  for (const m of report.monotonicity) {
    const sign = m.expectedSign > 0 ? '+' : m.expectedSign < 0 ? '-' : '0 (無相関)';
    L.push(
      `| ${m.conditionType} | ${m.axis} | ${sign} | ${m.rho ?? 'n/a'} | ` +
      `${m.axisRange} / ${m.axisMax}点 | ${VERDICT_TEXT[m.verdict]} |`,
    );
  }
  L.push('');

  if (report.uncertaintyChecks.length > 0) {
    L.push('## 3. 判定の不確かさの定数と実測の突き合わせ');
    L.push('');
    L.push('判定は3値なので、境界の近くで断定しないための安全距離を軸ごとに持っている');
    L.push('（AudioAnalyzer の `AXIS_RATIO_UNCERTAINTY`）。その値は実測MAEから換算して');
    L.push('決めているので、**推定器を変えて定数を更新し忘れると黙って断定しすぎる**。');
    L.push('ここで機械的に突き合わせる。');
    L.push('');
    L.push('| 軸 | 換算の元 | 実測MAE | 達成率に換算 | 定数 | 判定 |');
    L.push('|---|---|---:|---:|---:|---|');
    for (const c of report.uncertaintyChecks) {
      L.push(
        `| ${c.axis} | ${c.basis} | ${c.measuredMae} | ${c.measuredRatio} | ${c.constant} | ` +
        `${c.optimistic ? '**定数が実測より楽観（断定しすぎる）**' : '実測を覆っている'} |`,
      );
    }
    L.push('');
  }

  if (report.mos.available) {
    L.push('## 4. MOSオラクルとの順位相関');
    L.push('');
    L.push('学習済みモデル(DNSMOS)の評価順と、自分の総合スコアの順が一致しているか。');
    L.push('係数を調整する方向を得るための指標。1に近いほど良い。');
    L.push('');

    // ---- オラクルが信用できるかの自己診断 ----
    L.push(`- 劣化なし素材のMOS: ${report.mos.cleanBaseline ?? 'n/a'} / 5`);
    if (!report.mos.trustworthy) {
      L.push('');
      L.push(`> **警告: 素材がモデルの学習分布から外れている可能性が高い。**`);
      L.push(
        `> 劣化なしの素材でMOSが ${report.mos.cleanBaseline} しか出ていない` +
        `（${MOS_TRUSTWORTHY_BASELINE} 未満）。モデルは劣化ではなく素材そのものの` +
        `不自然さを評価している。条件ごとの相関の符号を根拠にスコア設計を変えてはいけない。`,
      );
      L.push('> 実音声のコーパスで測り直すこと（`npm run fetch-corpus`）。');
    }
    L.push('');
    L.push(`- 全条件まとめ: ρ = ${report.mos.rhoOverall ?? 'n/a'}`);
    L.push('');
    L.push('| 条件 | 件数 | 異なるMOS値 | MOSの振れ幅 | ρ | 解釈 |');
    L.push('|---|---:|---:|---:|---:|---|');
    for (const [type, s] of Object.entries(report.mos.rhoByCondition)) {
      let note: string;
      if (s.distinct <= 1) {
        note = '**モデルに劣化が見えていない（相関に意味なし）**';
      } else if (s.spread < 0.1) {
        note = 'MOSの差が小さく、相関は読めない';
      } else if (type === 'cutoff') {
        note = `${MOS_VISIBLE_HZ}Hz超の違いはモデルに見えない（入力16kHz）`;
      } else {
        note = '';
      }
      L.push(`| ${type} | ${s.n} | ${s.distinct} | ${s.spread} | ${s.rho ?? 'n/a'} | ${note} |`);
    }
    L.push('');
  }

  if (report.weighting) {
    const w = report.weighting;
    L.push('## 5. 軸の配点の検証（複合条件）');
    L.push('');
    L.push('単独条件では配点を検証できない——「ノイズが強い録音」と「残響が長い録音」の');
    L.push('どちらを低く評価すべきかという比較を含まないため。2つ以上の劣化を同時に');
    L.push('掛けた条件だけを使って、総合点の順位がMOSオラクルの順位と合うかを見る。');
    L.push('');
    L.push(`- 複合条件: ${w.n}件 / 異なるMOS値 ${w.mosDistinct}個 / MOSの振れ幅 ${w.mosSpread}`);
    L.push('');
    L.push('> **これは最適化ではなく粗い誤りの検出。**');
    L.push(`> DNSMOS は入力が16kHzなので ${MOS_VISIBLE_HZ}Hz超の帯域差が見えない。`);
    L.push('> 相関を最大化するように重みを振れば必ず周波数軸の配点が下がるが、それは');
    L.push('> モデルの盲点に合わせているだけで判定が良くなったわけではない。');
    L.push('> 候補間で相関が大きく開かないなら「この方法では配点を決められない」が結論。');
    L.push('');
    L.push('| 配点 | ノイズ | 周波数 | 残響 | 音量 | 音割れ | ρ (素材平均) | ρ (まとめ) |');
    L.push('|---|---:|---:|---:|---:|---:|---:|---:|');
    for (const c of w.candidates) {
      L.push(
        `| ${c.name} | ${c.weights.noise} | ${c.weights.frequency} | ${c.weights.reverb} | ` +
        `${c.weights.volume} | ${c.weights.clip} | ${c.rho ?? 'n/a'} | ${c.rhoPooled ?? 'n/a'} |`,
      );
    }
    L.push('');

    for (const g of w.groups) {
      L.push(`### ${g.label}`);
      L.push('');
      L.push(`- ${g.n}件 / MOSの振れ幅 ${g.mosSpread}`);
      L.push('');
      L.push('オラクルが実際に反応している軸（軸の達成率とMOSの順位相関）:');
      L.push('');
      L.push('| 軸 | ρ |');
      L.push('|---|---:|');
      for (const [axis, rho] of Object.entries(g.axisRho)) {
        L.push(`| ${axis} | ${rho ?? 'n/a'} |`);
      }
      L.push('');
      L.push('周波数25点を固定して残りを振り直した場合。周波数の配点だけはこの方法では');
      L.push('決められない（帯域制限を含まない条件では周波数軸に信号が無く、含む条件でも');
      L.push('DNSMOSは帯域差を見られないので、どちらでも「下げろ」しか出ない）。');
      L.push('');
      L.push('| 配点 | ノイズ | 周波数 | 残響 | 音量 | 音割れ | ρ |');
      L.push('|---|---:|---:|---:|---:|---:|---:|');
      for (const c of g.fixedFreq) {
        L.push(
          `| ${c.name} | ${c.weights.noise} | ${c.weights.frequency} | ${c.weights.reverb} | ` +
          `${c.weights.volume} | ${c.weights.clip} | ${c.rho ?? 'n/a'} |`,
        );
      }
      L.push('');
      L.push('参考: 周波数も振った場合');
      L.push('');
      L.push('| 配点 | ρ (素材平均) |');
      L.push('|---|---:|');
      for (const c of g.candidates) {
        L.push(`| ${c.name} | ${c.rho ?? 'n/a'} |`);
      }
      L.push('');
    }
  }

  if (report.drrCapability.length > 0) {
    L.push('## 6. マイク位置ごとの残響の測定能力');
    L.push('');
    L.push('RT60を固定して直接音対残響比(DRR)だけを振った条件。DRRはマイク位置に相当し、');
    L.push('了解度にはRT60よりこちらが効く。近接マイクなら同じ部屋でも残響はほとんど乗らない。');
    L.push('');
    L.push('目安: +15〜+25dB 近接(10〜30cm) / +5〜+15dB 卓上・ノートPC / -5〜+5dB 部屋の向こう');
    L.push('');
    L.push('| DRR[dB] | 件数 | 測定できた | バイアス[秒] | MAE[秒] | 最大誤差[秒] | 減衰イベント数 | 参考値扱い |');
    L.push('|---:|---:|---:|---:|---:|---:|---:|---:|');
    for (const d of report.drrCapability) {
      L.push(
        `| ${d.drrDb} | ${d.n} | ${d.measured} | ${d.bias ?? 'n/a'} | ${d.mae ?? 'n/a'} | ` +
        `${d.maxAbs ?? 'n/a'} | ${d.events} | ${d.unreliable} |`,
      );
    }
    L.push('');
  }

  if (report.bandProfiles.length > 0) {
    L.push('## 7. 帯域ごとにRT60が違う部屋での系統誤差');
    L.push('');
    L.push('検証基盤の既定のインパルス応答は**スペクトルが平坦**な指数減衰で、全帯域が同じ');
    L.push('速さで減衰する。実室はそうならない——空気吸収と吸音材の効きが周波数で違うので、');
    L.push('高域ほど早く減衰する。広帯域のレベル列から測る推定器は**最も遅く減衰する帯域に');
    L.push('引っ張られる**ため、平坦な応答しか試していないとこの誤差は原理的に見えない。');
    L.push('');
    L.push('真値は中帯域(500〜2000Hz)のRT60。ISO 3382 が代表値とする 500Hz/1kHz');
    L.push('オクターブの平均に対応する。`flat` が対照で、「平坦との差」がそのまま');
    L.push('周波数依存だけが持ち込む誤差になる。');
    L.push('');
    L.push('| プロファイル | 低 / 中 / 高 [秒] | 件数 | 測定できた | バイアス[秒] | MAE[秒] | 最大誤差[秒] | 平坦との差[秒] | 確定値 |');
    L.push('|---|---|---:|---:|---:|---:|---:|---:|---:|');
    for (const b of report.bandProfiles) {
      L.push(
        `| ${b.profile} | ${b.lowSec} / ${b.midSec} / ${b.highSec} | ${b.n} | ${b.measured} | ` +
        `${b.bias ?? 'n/a'} | ${b.mae ?? 'n/a'} | ${b.maxAbs ?? 'n/a'} | ` +
        `${b.excessOverFlat ?? 'n/a'} | ${b.confident} |`,
      );
    }
    L.push('');
  }

  if (report.dropStrata.length > 0) {
    L.push('## 8. 減衰の落差ごとのRT60誤差');
    L.push('');
    L.push('ISO 3382 の T20 は減衰曲線の −5〜−25dB（20dB）を×3に外挿する。この実装は');
    L.push('−8〜−18dB（10dB）を**×6**に外挿しているので、曲率と雑音の影響が規格の手順より');
    L.push('2倍拡大される。「確定値」の条件は現在イベント数だけで、落差を見ていない。');
    L.push('');
    L.push('落差が20dBに届いたイベントの数で層別する。**落差を条件に足すべきかは');
    L.push('この表が支持するかで決める**——誤差が下がるだけでは足りず、測れる件数も見る。');
    L.push('');
    L.push('| T20相当のイベント数 | 件数 | 測定できた | バイアス[秒] | MAE[秒] | 最大誤差[秒] | 現在の確定値 |');
    L.push('|---|---:|---:|---:|---:|---:|---:|');
    for (const d of report.dropStrata) {
      L.push(
        `| ${d.label} | ${d.n} | ${d.measured} | ${d.bias ?? 'n/a'} | ${d.mae ?? 'n/a'} | ` +
        `${d.maxAbs ?? 'n/a'} | ${d.confidentNow} |`,
      );
    }
    L.push('');
  }

  if (report.pauses.length > 0) {
    L.push('## 9. 間（無音区間）の量とSNRの測定能力');
    L.push('');
    L.push('READMEは「話者の喋り方（声量のムラ、間の取り方）は評価しない。環境の評価では');
    L.push('ないため」と宣言している。SNRを固定して間だけを間引いた条件で、その宣言が');
    L.push('ノイズ軸について成り立っているかを見る。**誤差が動いたら、それは環境ではなく');
    L.push('喋り方への依存である。**');
    L.push('');
    L.push('`無音フレーム` はノイズフロアの推定に使えたフレーム数。0 の行は下限を割って');
    L.push('パーセンタイル代替に落ちている。');
    L.push('');
    L.push('| 残した無音 | 実際の無音率 | 件数 | バイアス[dB] | MAE[dB] | 最大誤差[dB] | 無音フレーム | 代替に落ちた |');
    L.push('|---:|---:|---:|---:|---:|---:|---:|---:|');
    for (const p of report.pauses) {
      L.push(
        `| ${p.keepRatio} | ${p.silenceRatio} | ${p.n} | ${p.bias ?? 'n/a'} | ` +
        `${p.mae ?? 'n/a'} | ${p.maxAbs ?? 'n/a'} | ${p.noiseFrames} | ${p.fellBack} |`,
      );
    }
    L.push('');
  }

  if (report.impulseDetection !== null) {
    const d = report.impulseDetection;
    L.push('## 10. 衝撃性ノイズの検出');
    L.push('');
    L.push('ノイズ軸は打鍵音のような衝撃音に無反応なので（節2の `snrimpulse` が `blind`）、');
    L.push('**スコアで表現できない事実を加工痕跡のフラグとして申告する**。スコアと判定は');
    L.push('動かさない。助言と同じく空振りは見落としより重い——正常な録音に');
    L.push('「打鍵音がある」と言うほうが道具への信頼を損なう。');
    L.push('');
    L.push('陽性は `snrimpulse` 条件だけ。他のすべての条件が陰性で、そこに出たら空振りである。');
    L.push('');
    L.push('| 出すべき | 出すべきでない | 的中 | 空振り | 見落とし | 適合率 | 再現率 |');
    L.push('|---:|---:|---:|---:|---:|---:|---:|');
    L.push(
      `| ${d.positives} | ${d.negatives} | ${d.truePositives} | ${d.falsePositives} | ` +
      `${d.falseNegatives} | ${d.precision ?? 'n/a'} | ${d.recall ?? 'n/a'} |`,
    );
    L.push('');
    if (d.falsePositiveIds.length > 0) {
      L.push('空振り:');
      L.push('');
      for (const id of d.falsePositiveIds) L.push(`- ${id}`);
      L.push('');
    }
  }

  if (report.reproducibility.length > 0) {
    L.push('## 11. 判定の再現性（真値を固定して乱数だけ振る）');
    L.push('');
    L.push('誤差表は「真値をずらしたときにどれだけ当たるか」を測る。しかしこの道具の出力は');
    L.push('3値の判定なので、利用者にとって意味があるのは**同じ部屋を測り直して同じ答えが');
    L.push('出るか**である。RT60とマイク位置を固定し、応答の実現（乱数）だけを振った条件。');
    L.push('');
    L.push('**推定誤差が判定境界の間隔より広ければ、判定は測定ではなく抽選になる。**');
    L.push('残響軸は0.2秒で満点・0.9秒で0点の直線なので、RT60の誤差[秒]は 20/0.7 倍して');
    L.push('点数になる。判定の境界（達成率 0.55 と 0.35）の間隔は 0.20 しかない。');
    L.push('');
    L.push('| 真のRT60[秒] | 件数 | 測定できた | 推定値の範囲[秒] | 残響軸 | good | usable | poor | 断定せず | 残響の助言 |');
    L.push('|---:|---:|---:|---|---|---:|---:|---:|---:|---:|');
    for (const p of report.reproducibility) {
      const range = p.estimateMin === null ? 'n/a' : `${p.estimateMin} – ${p.estimateMax}`;
      L.push(
        `| ${p.rt60Sec} | ${p.n} | ${p.measured} | ${range} | ` +
        `${p.reverbScoreMin}–${p.reverbScoreMax} / ${AXIS_MAX.reverb} | ` +
        `${p.good} | ${p.usable} | ${p.poor} | ${p.unconfirmed} | ${p.advisedReverb} |`,
      );
    }
    L.push('');
  }

  if (report.verdicts.some((v) => v.n > 0)) {
    L.push('## 12. 判定の分離（複合条件）');
    L.push('');
    L.push('判定は**最弱の軸**で決まるので、複数の軸が同時に下がる複合条件でこそ意味を持つ。');
    L.push('「良好」の群と「不可」の群でMOSの分布が重なっているなら、閾値は意味をなしていない。');
    L.push('');
    L.push('| 判定 | 件数 | MOS平均 | MOS最小 | MOS最大 | うち参考値ありでgood不可 |');
    L.push('|---|---:|---:|---:|---:|---:|');
    for (const v of report.verdicts) {
      L.push(
        `| ${v.level} | ${v.n} | ${v.mosMean ?? 'n/a'} | ${v.mosMin ?? 'n/a'} | ` +
        `${v.mosMax ?? 'n/a'} | ${v.unconfirmed} |`,
      );
    }
    L.push('');
  }

  if (report.advice.some((a) => a.positives + a.negatives > 0)) {
    L.push('## 13. 助言の的中と空振り');
    L.push('');
    L.push('注入した物理量から「この助言が出るべきか」の真値が作れる。**空振りは見落としより重い**——');
    L.push('出すべき助言を落とすより、直さなくてよいものを直せと言うほうが道具への信頼を損なう。');
    L.push('');
    L.push('| 助言 | 出すべき基準 | 出すべき | 出すべきでない | 的中 | 空振り | 見落とし | 適合率 | 再現率 |');
    L.push('|---|---|---:|---:|---:|---:|---:|---:|---:|');
    for (const a of report.advice) {
      L.push(
        `| ${a.code} | ${a.criterion} | ${a.positives} | ${a.negatives} | ${a.truePositives} | ${a.falsePositives} | ${a.falseNegatives} | ` +
        `${a.precision ?? 'n/a'} | ${a.recall ?? 'n/a'} |`,
      );
    }
    L.push('');
    const bad = report.advice.filter((a) => a.worst.length > 0);
    if (bad.length > 0) {
      L.push('外れた行:');
      L.push('');
      for (const a of bad) {
        for (const w of a.worst) {
          L.push(`- ${a.code} ${w.kind}: ${w.id} 真値 ${w.truth}`);
        }
      }
      L.push('');
    }
  }

  L.push('## 14. 劣化なし基準の挙動');
  L.push('');
  L.push('| id | 総合 | ノイズ | 残響 | 周波数 | 音量 | 音割れ | 帯域上限[Hz] | 検出フラグ | 参考値扱いの軸 |');
  L.push('|---|---:|---:|---:|---:|---:|---:|---:|---|---|');
  for (const r of report.cleanRows) {
    L.push(
      `| ${r.id} | ${r.scores.overall} | ${r.scores.noise} | ${r.scores.reverb} | ` +
      `${r.scores.frequency} | ${r.scores.volume} | ${r.scores.clip} | ` +
      `${r.bandwidthHz} | ${r.flags.join(', ') || 'なし'} | ${r.unreliable.join(', ') || 'なし'} |`,
    );
  }
  L.push('');
  return L.join('\n');
}

function buildReport(rows: Row[], sources: string[], mosNote: string, mosAvailable: boolean) {
  const errors = errorStats(rows);
  const errorsBySource = errorStats(rows, (r) => r.source);
  const measuredTypes = new Set(errors.map((e) => e.conditionType));
  const notImplemented = [...new Set(rows.map((r) => r.conditionType))]
    // clean は劣化なし、mixed は複合条件（物理量ごとの真値を定義できないので
    // 誤差の集計対象外。配点の検証にだけ使う）。どちらも未実装ではない。
    // clean は劣化なし。mixed は複合条件（物理量ごとの真値を定義できない）。
    // drr はマイク位置の条件で、無参照でDRRを推定する器は持たない（残響軸の反応を
    // 見るだけ）。いずれも未実装ではない。
    .filter((t) => !['clean', 'mixed', 'drr'].includes(t) && !measuredTypes.has(t))
    .map((t) => {
      const list = rows.filter((r) => r.conditionType === t);
      return { conditionType: t, label: list[0].errorLabel, n: list.length };
    });

  const withMos = rows.filter((r) => r.mos !== null);
  const rhoByCondition: Record<string, MosConditionStat> = {};
  for (const type of new Set(withMos.map((r) => r.conditionType))) {
    const list = withMos.filter((r) => r.conditionType === type);
    // 同じMOS値しか出ていない条件は、モデルにその劣化が見えていない。
    // 相関の符号を読む前にこれを確認しないと、正しい軸を誤った信号で壊す。
    const distinct = new Set(list.map((r) => round(r.mos as number, 3))).size;
    rhoByCondition[type] = {
      rho: list.length >= 3
        ? round(spearman(list.map((r) => r.mos as number), list.map((r) => r.scores.overall)) ?? 0, 3)
        : null,
      n: list.length,
      distinct,
      spread: list.length > 0
        ? round(Math.max(...list.map((r) => r.mos as number)) - Math.min(...list.map((r) => r.mos as number)), 3)
        : 0,
    };
  }

  // 劣化なしの素材に対するMOS。低い場合、素材がモデルの学習分布から外れており
  // モデルは劣化ではなく素材そのものの不自然さを評価している。
  const cleanMos = rows.filter((r) => r.conditionType === 'clean' && r.mos !== null);
  const cleanBaseline = cleanMos.length > 0
    ? round(cleanMos.reduce((s, r) => s + (r.mos as number), 0) / cleanMos.length, 3)
    : null;

  return {
    generatedAt: new Date().toISOString(),
    sources,
    itemCount: rows.length,
    errors,
    errorsBySource,
    notImplemented,
    monotonicity: monotonicity(rows),
    mos: {
      available: mosAvailable,
      note: mosNote,
      rhoOverall: withMos.length >= 3
        ? round(spearman(withMos.map((r) => r.mos as number), withMos.map((r) => r.scores.overall)) ?? 0, 3)
        : null,
      rhoByCondition,
      cleanBaseline,
      trustworthy: cleanBaseline !== null && cleanBaseline >= MOS_TRUSTWORTHY_BASELINE,
    },
    weighting: weighting(rows),
    drrCapability: drrCapability(rows),
    bandProfiles: bandProfileStats(rows),
    pauses: pauseStats(rows),
    impulseDetection: impulseDetection(rows),
    dropStrata: dropStrata(rows),
    uncertaintyChecks: uncertaintyChecks(rows),
    reproducibility: reproducibility(rows),
    verdicts: verdictStats(rows),
    advice: adviceStats(rows),
    cleanRows: rows.filter((r) => r.conditionType === 'clean'),
    rows,
  };
}

// ==========================================================================
// main
// ==========================================================================

async function main(): Promise<void> {
  if (!existsSync(MANIFEST)) {
    console.error('validation/manifest.json がありません。先に npm run generate を実行してください。');
    process.exit(1);
  }

  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
    items: ManifestItem[];
    sources: Array<{ name: string }>;
  };

  const missing = manifest.items.filter((i) => !existsSync(resolve(ROOT, i.file)));
  if (missing.length > 0) {
    console.error(`検証用の音声が ${missing.length} 件見つかりません（例: ${missing[0].file}）。`);
    console.error('fixtures/ はgit管理外です。npm run generate を実行して再生成してください。');
    process.exit(1);
  }

  const mosOracle = WANT_MOS ? await scoreMos.prepare() : null;
  const mosNote = WANT_MOS
    ? (mosOracle?.note ?? '準備に失敗')
    : '--mos が指定されていない';

  const rows: Row[] = [];
  for (const item of manifest.items) {
    const bytes = readFileSync(resolve(ROOT, item.file));
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const wav = decodeWav(ab);
    const mos = mosOracle ? await mosOracle.score(wav.samples, wav.sampleRate) : null;
    rows.push(evaluate(item, wav.samples, mos));
    process.stdout.write(`\r評価中 ${rows.length}/${manifest.items.length}   `);
  }
  process.stdout.write('\n');

  const report = buildReport(
    rows,
    manifest.sources.map((s) => s.name),
    mosNote,
    mosOracle !== null,
  );

  writeFileSync(REPORT_JSON, JSON.stringify(report, null, 2) + '\n');
  writeFileSync(REPORT_MD, renderMarkdown(report));

  // ---- コンソール要約 ----
  console.log('\n推定誤差:');
  for (const s of report.errors) {
    console.log(`  ${s.conditionType.padEnd(8)} ${s.label.padEnd(18)} n=${String(s.n).padStart(3)}  bias=${s.bias}  MAE=${s.mae}  max=${s.maxAbs}`);
  }
  if (report.notImplemented.length > 0) {
    console.log('\n推定器が未実装:');
    for (const n of report.notImplemented) console.log(`  ${n.conditionType} (${n.label}) — ${n.n}件`);
  }
  console.log('\nスコアの単調性:');
  for (const m of report.monotonicity) {
    console.log(`  ${m.conditionType.padEnd(8)} ${m.axis.padEnd(10)} rho=${String(m.rho ?? 'n/a').padStart(6)}  ${m.verdict}`);
  }
  if (report.drrCapability.length > 0) {
    console.log(`
マイク位置ごとの残響の測定能力（RT60は固定）:`);
    for (const d of report.drrCapability) {
      console.log(`  DRR ${String(d.drrDb).padStart(4)}dB  測定 ${d.measured}/${d.n}  ` +
        `bias=${String(d.bias ?? 'n/a').padStart(7)} MAE=${String(d.mae ?? 'n/a').padStart(6)}  ` +
        `イベント${d.events}  参考値${d.unreliable}/${d.n}`);
    }
  }
  if (report.verdicts.some((v) => v.n > 0)) {
    console.log(`
判定の分離（複合条件）:`);
    for (const v of report.verdicts) {
      console.log(`  ${v.level.padEnd(8)} n=${String(v.n).padStart(4)}  MOS平均 ${v.mosMean ?? 'n/a'}  範囲 ${v.mosMin ?? '-'}〜${v.mosMax ?? '-'}`);
    }
  }
  if (report.weighting) {
    console.log(`
配点の検証（複合条件 ${report.weighting.n}件 / MOSの振れ幅 ${report.weighting.mosSpread}）:`);
    for (const c of report.weighting.candidates) {
      console.log(`  ${c.name.padEnd(12)} rho=${String(c.rho ?? 'n/a').padStart(6)}`);
    }
    for (const g of report.weighting.groups) {
      console.log(`  -- ${g.label} (${g.n}件) --`);
      console.log('     オラクルが反応している軸: ' +
        Object.entries(g.axisRho).map(([a, v]) => `${a}=${v ?? 'n/a'}`).join('  '));
      for (const c of g.fixedFreq) {
        console.log(`     ${c.name.padEnd(20)} rho=${String(c.rho ?? 'n/a').padStart(6)}`);
      }
    }
  }
  console.log(`\nレポート: ${REPORT_MD}`);
}

await main();
