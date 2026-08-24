/**
 * 音質分析のコア。
 *
 * 目的は「この録音は会議の環境としてどのレベルか」を客観的に示すこと。
 * 話者の喋り方（声量のムラ、間の取り方）は評価しない。環境の評価ではないため。
 *
 * 評価軸と配点（合計100点）:
 *
 *   ノイズ (noise)            25点  SNR。環境の主要因
 *   周波数バランス (frequency) 25点  有効帯域・明瞭度・こもり・キンキン
 *   残響 (reverb)             20点  RT60。環境の主要因
 *   音量 (volume)             15点  有効音声レベル。機材設定
 *   音割れ (clip)             15点  クリッピング。機材設定
 *
 * 閾値の根拠は既存規格に置く（ITU-T P.56 の有効音声レベル、ISO 3382 の残響時間、
 * ITU-T の広帯域音声帯域）。絶対音圧は扱わない——ブラウザはマイク感度を知らないため
 * dBFS から dBA への換算は原理的に不可能で、ノイズは相対値(SNR)でしか語れない。
 *
 * 分析本体 `analyzeSamples` は Float32Array を直接受け取り、DOM/Web Audio に
 * 依存しない。これは Node 側の検証スクリプト(validation/)から同じコードを
 * 呼び、推定誤差を実測できるようにするため。ブラウザ側は AudioBuffer を
 * 受け取る薄いラッパ `analyzeAudio` を使う。
 */

import { clamp } from './signal.ts';
import { detectProvenance, unreliableAxes, type Provenance } from './provenance.ts';
import {
  estimateSpectralSlope,
  estimateClipping,
  estimateLevel,
  estimateReverb,
  estimateSnr,
} from './estimators.ts';

/**
 * アドバイスの種類。
 *
 * 文面ではなくコードを返す。分析側で日本語を組み立てていたため、
 * EN モードでもアドバイスだけ日本語で出ていた。文面は i18n 側に置く。
 */
export const ADVICE_CODES = [
  'level-low',
  'level-high',
  'bandwidth-narrow',
  'muffled',
  'reverb-strong',
  'reverb-unmeasurable',
  'clipping',
  'noise-high',
] as const;

export type AdviceCode = (typeof ADVICE_CODES)[number];

export interface AdviceItem {
  code: AdviceCode;
  /**
   * 文面に埋める数値。意味はコードごとに決まる。
   * 'bandwidth-narrow' は帯域上限[Hz]、'reverb-strong' は残響時間[秒]。
   */
  value?: number;
}

/** スコア軸のキー */
export type ScoreAxis = 'volume' | 'frequency' | 'reverb' | 'clip' | 'noise';

/** 各軸の満点。合計100 */
export const AXIS_MAX: Record<ScoreAxis, number> = {
  noise:     25,
  frequency: 25,
  reverb:    20,
  volume:    15,
  clip:      15,
};

/** 会議の録音環境として使えるかの判定 */
export type VerdictLevel = 'good' | 'usable' | 'poor';

export interface Verdict {
  level: VerdictLevel;
  /** 最も足を引っ張っている軸。すべて良好かつ測定も揃っていれば null */
  limitingAxis: ScoreAxis | null;
  /**
   * スコア自体は良好だが、測定できなかった軸があるため「十分」と断定できない状態。
   * 測定不能な軸に中間点を与えているので、そのまま good を出すと
   * 「測れなかった部屋」が「実測した悪い部屋」より高評価になってしまう。
   */
  unconfirmed: boolean;
}

/** 判定の根拠になった実測値。総合点より前にこれを見せる */
export interface Measured {
  /** 声に対する背景ノイズの比[dB] */
  snrDb: number | null;
  /** 残響時間[秒] */
  rt60Sec: number | null;
  /** 実測した帯域上限[Hz] */
  bandwidthHz: number;
  /** 発話区間の音量レベル[dBFS] */
  activeSpeechDbfs: number | null;
  /** 有音サンプルに対するクリップ率 */
  clipRate: number | null;
}

export interface AudioScores {
  overall: number;
  volume: number;
  frequency: number;
  reverb: number;
  clip: number;
  noise: number;
  advice: AdviceItem[];
  /** この録音が環境評価に使えるか（加工の痕跡）。スコアには影響しない */
  provenance: Provenance;
  /** 推定できたRT60[秒]。測定不能なら null */
  rt60Sec: number | null;
  /** 加工の痕跡や測定不能により信用できない軸。UIで「参考値」として明示する */
  unreliable: ScoreAxis[];
  /** 「このまま会議していいのか」の答え */
  verdict: Verdict;
  /** 判定の根拠になった実測値 */
  measured: Measured;
}

/** ブラウザ側の入口。AudioBuffer の先頭チャンネルのみを分析する */
export async function analyzeAudio(audioBuffer: AudioBuffer): Promise<AudioScores> {
  return analyzeSamples(audioBuffer.getChannelData(0), audioBuffer.sampleRate);
}

/** 分析本体。DOM非依存なので Node からも呼べる */
export function analyzeSamples(channelData: Float32Array, sampleRate: number): AudioScores {
  const advice: AdviceItem[] = [];

  // 帯域上限は周波数バランスの分母に使うので先に実測する
  const provenance = detectProvenance(channelData, sampleRate);
  const reverbEst  = estimateReverb(channelData, sampleRate);

  const volume    = Math.round(calcVolumeScore(channelData, sampleRate, advice));
  const freqResult = calcFrequencyScore(channelData, sampleRate, provenance.bandwidthHz, advice);
  const frequency = Math.round(freqResult.score);
  const reverb    = Math.round(calcReverbScore(reverbEst.rt60Sec, advice));
  const clip      = Math.round(calcClipScore(channelData, advice));
  const noise     = Math.round(calcNoiseScore(channelData, sampleRate, reverbEst.rt60Sec, advice));

  const measured: Measured = {
    snrDb: estimateSnr(channelData, sampleRate, reverbEst.rt60Sec).snrDb,
    rt60Sec: reverbEst.rt60Sec,
    bandwidthHz: provenance.bandwidthHz,
    activeSpeechDbfs: estimateLevel(channelData, sampleRate).activeSpeechDbfs,
    clipRate: estimateClipping(channelData).clipRate,
  };

  // overall は内訳の単純合計（各軸の満点合計が100になるよう設計している）
  const overall = clamp(volume + frequency + reverb + clip + noise, 0, 100);

  // 残響が測れなかった／根拠が薄い場合、その軸のスコアは参考値として明示する。
  const unreliable: ScoreAxis[] = [...unreliableAxes(provenance)];
  if (!reverbEst.confident && !unreliable.includes('reverb')) unreliable.push('reverb');
  // 傾斜が測れない（1kHz以上に信号が無い / 帯域が2kHzも無い）ときは、周波数軸の
  // 10点分を測らずに中間値で埋めている。黙って部分点を出さず参考値として開示する。
  if (!freqResult.slopeMeasured && !unreliable.includes('frequency')) unreliable.push('frequency');

  return {
    overall, volume, frequency, reverb, clip, noise,
    advice, provenance,
    rt60Sec: reverbEst.rt60Sec,
    unreliable,
    verdict: judge({ volume, frequency, reverb, clip, noise }, unreliable),
    measured,
  };
}

/** 判定の閾値。各軸の満点に対する達成率 */
const VERDICT_GOOD_RATIO   = 0.75;
const VERDICT_USABLE_RATIO = 0.5;

/**
 * 「このまま会議していいのか」を判定する。
 *
 * 総合点の合計ではなく **最も低い軸** で決める。録音環境は最も弱い要因で
 * 使えなくなるため。他が満点でも暗騒音が大きければ会議はできない。
 * 総合点を平均的に見ると、この「弱点が支配する」性質が消えてしまう。
 */
function judge(scores: Record<ScoreAxis, number>, unreliable: ScoreAxis[]): Verdict {
  let worstAxis: ScoreAxis | null = null;
  let worstRatio = Infinity;

  for (const axis of Object.keys(AXIS_MAX) as ScoreAxis[]) {
    const ratio = scores[axis] / AXIS_MAX[axis];
    if (ratio < worstRatio) { worstRatio = ratio; worstAxis = axis; }
  }

  if (worstRatio >= VERDICT_GOOD_RATIO) {
    // 測定できなかった軸があるなら「十分」と断定しない。
    // 測定不能な軸には中間点を与えているため、そのまま good を出すと
    // 「測れなかった部屋」が「実測した悪い部屋」より高評価になる。
    if (unreliable.length > 0) {
      return { level: 'usable', limitingAxis: unreliable[0], unconfirmed: true };
    }
    return { level: 'good', limitingAxis: null, unconfirmed: false };
  }

  const level: VerdictLevel = worstRatio >= VERDICT_USABLE_RATIO ? 'usable' : 'poor';
  return { level, limitingAxis: worstAxis, unconfirmed: false };
}

// ==========================================================================
// 1. 音量レベル [15点満点]
// ==========================================================================
// 有効音声レベル(dBFS)が実用的な範囲に収まっているかを評価する。
//
// 全体RMSではなく発話区間のみのRMSを使う。全体RMSには無音区間が含まれるため、
// 間の多い録音ほど音量が小さいと誤判定される。実測では、レベルが適正な
// クリーン音声で音量スコアが 11〜13/30 しか出ていなかった。
//
// 声量のムラ(ダイナミクス)の評価は削除した。録音環境の評価に話者の喋り方は
// 含まれないため。
//
// この軸は品質の尺度ではなく**衛生チェック**として置いている。レベル自体は
// 後から正規化できるし、録音環境については何も語らない。レベルが実害を持つのは
// 両端だけ——高すぎれば音割れ（それは音割れ軸が直接測る）、低すぎれば量子化雑音や
// ノイズフロアとの余裕が減る（SNRも別に測っている）。だから通過帯域は広く取る。
function calcVolumeScore(data: Float32Array, sampleRate: number, advice: AdviceItem[]): number {
  const MAX = AXIS_MAX.volume;
  /**
   * 減点しない有効音声レベルの範囲[dBFS]。
   *
   * **レベルはできあがった音声の品質属性ではない。** 正規化すれば直るし、
   * 録音環境について何も語らない。だから減点するのは「レベルが低すぎて音質を
   * 実際に損なう」ところだけにする。
   *
   * 経緯: 最初は -20〜-14dBFS だった（放送・配信の制作目標）。実録音を入れると
   * 全滅したので -30〜-12dBFS に広げたが、それでも足りなかった。実録音4本の
   * 有効音声レベルは -26.2 / -31.4 / -35.4 / -47.4 dBFS で、民生機材はこの帯に
   * 収まらない。-47.4dBFS の録音は SNR 28.5dB・全帯域・残響0.25秒・音割れ無しで、
   * 正規化すれば何の問題も無いのに音量軸だけで「不可」になっていた。
   *
   * 下限の根拠は量子化フロア。16bitのフロアは -96dBFS なので、発話が -50dBFS でも
   * 46dBの余裕がある。それ以下になると量子化雑音が聞こえ始める。
   * 上限は -12dBFS。発話の波高率は12〜18dBなのでこれ以上ではピークが0dBFSに
   * 達しはじめる（実際に割れているかは音割れ軸が測る）。
   */
  const IDEAL_LO = -50;
  const IDEAL_HI = -12;
  /**
   * 助言を出すレベル[dBFS]。**採点の範囲とは別に持つ。**
   *
   * 減点はしないが、入力ゲインを上げたほうがよいことは伝える価値がある。
   * 次の録音のSNRが良くなるし、利用者が最も簡単に直せる要因でもある。
   * ITU-T P.56 系の試験手順が有効音声レベルを -26dBov に正規化することと、
   * 民生機材の実測（-26〜-47dBFS）を踏まえて -30dBFS に置いた。
   */
  const ADVISE_LOW_DBFS = -30;
  /** 1dB逸脱あたりの減点。12dB以上の逸脱でほぼ0点 */
  const PENALTY_PER_DB = MAX / 12;

  const { activeSpeechDbfs, overallDbfs } = estimateLevel(data, sampleRate);
  const levelDb = activeSpeechDbfs ?? overallDbfs;

  let score: number;
  if (levelDb >= IDEAL_LO && levelDb <= IDEAL_HI) {
    score = MAX;
  } else {
    const deviation = levelDb < IDEAL_LO ? IDEAL_LO - levelDb : levelDb - IDEAL_HI;
    score = clamp(MAX - deviation * PENALTY_PER_DB, 0, MAX);
  }

  if (levelDb < ADVISE_LOW_DBFS) {
    advice.push({ code: 'level-low' });
  } else if (levelDb > IDEAL_HI + 3) {
    advice.push({ code: 'level-high' });
  }

  return score;
}

// ==========================================================================
// 2. 周波数バランス [25点満点]
// ==========================================================================
// 内訳は2つだけ。どちらも物理量として実測でき、真値と比べられるもの。
//
//   有効帯域幅[Hz]        15点 … コーデック・電話品質・低ビットレート圧縮
//   1kHz以上の傾斜[dB/oct] 10点 … こもり（マイクが服の下・机の下・口から遠い）
//
// 以前は「明瞭度(500〜3000Hzの比率) 10点 / こもり(低域比率) 4点 /
// キンキン(高域比率) 3点」を持っていた。**これらは声質を測っていた。**
//
// 実測（実音声4話者・CMU ARCTIC）:
//   傾き -12dB/oct のこもりを注入しても周波数軸が動いたのは 0.5/25点。
//   一方、劣化なしの状態での話者間のばらつきは 7点。こもりより声質に14倍敏感。
//   内訳を見ると、明瞭度比率は分母に0〜500Hzを含むため基本周波数の低い声で
//   構造的に下がる（ksp=インド英語男性は48%が200Hz以下にあり、明瞭度3.4/10 +
//   こもり2.2/4 と二重に減点されていた）。低い声であることは録音環境の欠点ではない。
//
// 傾斜に置き換えると注入量にほぼ1:1で追随し（0→-12dB/octで実測 -10.95〜-13.76）、
// 話者間のばらつきも 6.3dB/oct に収まる。注入している物理量そのものなので、
// 推定誤差を数値で測れる（validation/report.md の tilt 条件）。
//
// 「明るすぎる」側は、傾斜が正（高域が上昇している）ときだけ減点する。実音声の
// 自然な傾斜は必ず負で、観測した最も緩い値が -2.4dB/oct（ksp）だった。明るい声と
// 明るいマイクを4話者で分離することはできないので、境界は自然な範囲から十分離す。
function calcFrequencyScore(
  data: Float32Array,
  sampleRate: number,
  bandwidthHz: number,
  advice: AdviceItem[],
): { score: number; slopeMeasured: boolean } {
  const BANDWIDTH_MAX = 15;
  const SLOPE_MAX     = 10;

  // ---- 有効帯域幅 ----
  // ITU-T の広帯域音声(〜7kHz)で満点、電話品質(3.4kHz)で0点。
  // 7kHz以上を同点にしているのは、会議音声の明瞭度にそれ以上を要しないため
  // （摩擦音・サ行の識別に必要な帯域は7kHzでほぼ足りる）。
  const effectiveHz = Math.min(bandwidthHz, sampleRate / 2);
  const bwFactor = clamp((effectiveHz - BW_MIN_HZ) / (BW_FULL_HZ - BW_MIN_HZ), 0, 1);
  const bandwidthScore = BANDWIDTH_MAX * bwFactor;

  // ---- こもり（1kHz以上の傾斜） ----
  const slope = estimateSpectralSlope(data, sampleRate, effectiveHz);
  let slopeScore: number;
  let slopeFactor = 1;
  if (slope === null) {
    // 近似する区間が取れない = 帯域が2kHzも無い。電話品質未満。
    // その減点は帯域幅の内訳が担っているので、ここでは中間値にして二重減点を避ける。
    slopeScore = SLOPE_MAX / 2;
  } else if (slope < SLOPE_PLATEAU_LO_DB_OCT) {
    // 高域が落ちすぎ（こもり）
    slopeFactor = clamp(
      (slope - SLOPE_MUFFLED_DB_OCT) / (SLOPE_PLATEAU_LO_DB_OCT - SLOPE_MUFFLED_DB_OCT), 0, 1,
    );
    slopeScore = SLOPE_MAX * slopeFactor;
  } else if (slope > SLOPE_PLATEAU_HI_DB_OCT) {
    // 高域が過剰（ヒスノイズ、帯域外の混入）
    slopeFactor = clamp(
      (SLOPE_HISSY_DB_OCT - slope) / (SLOPE_HISSY_DB_OCT - SLOPE_PLATEAU_HI_DB_OCT), 0, 1,
    );
    slopeScore = SLOPE_MAX * slopeFactor;
  } else {
    slopeScore = SLOPE_MAX;
  }

  const score = clamp(bandwidthScore + slopeScore, 0, AXIS_MAX.frequency);

  if (bwFactor < 0.7)   advice.push({ code: 'bandwidth-narrow', value: effectiveHz });
  if (slopeFactor < 0.7 && slope !== null) advice.push({ code: 'muffled', value: slope });

  return { score, slopeMeasured: slope !== null };
}

/**
 * こもりの採点の境界[dB/oct]。
 *
 * **4話者から置いた値。素材を増やしたら必ず見直す。** 実音声の自然な傾斜は
 * -2.4〜-8.8dB/oct（ksp / awb）だった。声の暗い話者を減点しないよう、満点側は
 * 観測した最も急な自然値(-8.8)より余裕を取って -10 に置いている。
 * 0点側は -12dB/oct の注入で -16〜-20 になることから -22 に置いた。
 */
const SLOPE_PLATEAU_LO_DB_OCT = -10;
const SLOPE_MUFFLED_DB_OCT    = -22;
/**
 * 高域が過剰と見なす側の境界[dB/oct]。ヒスノイズや帯域外の混入を捉える。
 *
 * 実音声の自然な傾斜は必ず負で、観測した最も緩い値が -2.4dB/oct（ksp）だった。
 * 明るい声と明るいマイクを4話者で分離することはできないので、平坦側の境界は
 * 自然な範囲から十分離して 0 に置き、+6dB/oct で0点にする。
 * つまり「上昇している」ものだけを減点する。
 */
const SLOPE_PLATEAU_HI_DB_OCT = 0;
const SLOPE_HISSY_DB_OCT      = 6;

/** 有効帯域幅がこれ以下なら明瞭度上の価値が無いとみなす（電話品質） */
const BW_MIN_HZ = 3400;
/** これ以上あれば会議音声として十分（ITU-T 広帯域音声） */
const BW_FULL_HZ = 7000;

// ==========================================================================
// 3. 残響 [20点満点]
// ==========================================================================
// 会議室の音の悪さの主要因のひとつ。「静かな部屋なのに聞き取りにくい」の主犯で、
// かつユーザーが対処できる（カーテン、カーペット、マイクを口元に近づける）。
//
// 閾値は ISO 3382 系の会議用途の目安に置く。0.4秒以下は処理された部屋、
// 1.2秒以上は会議に適さない反響。
//
// 測定不能な場合（喋り続けていて自由減衰が無い、デッドすぎて発話自体の減衰と
// 分離できない）は中間値を返し、その軸を unreliable に入れる。満点は与えない。
function calcReverbScore(rt60Sec: number | null, advice: AdviceItem[]): number {
  const MAX = AXIS_MAX.reverb;
  const GOOD_SEC = 0.4;
  const BAD_SEC  = 1.2;

  if (rt60Sec === null) {
    advice.push({ code: 'reverb-unmeasurable' });
    // 測定できなかったときは「使えるかどうかの境界」に置く。0.6倍にしていた頃は、
    // 実測した0.7秒の部屋(6/20)より測定不能(12/20)のほうが高得点になっていた。
    return MAX * VERDICT_USABLE_RATIO;
  }

  const score = clamp((1 - (rt60Sec - GOOD_SEC) / (BAD_SEC - GOOD_SEC)) * MAX, 0, MAX);

  if (rt60Sec > 0.7) advice.push({ code: 'reverb-strong', value: rt60Sec });

  return score;
}

// ==========================================================================
// 4. 音割れ（クリッピング） [15点満点]
// ==========================================================================
// - 絶対値0.98以上のサンプルをクリップとしてカウント
// - 連続クリップ(バースト)は波形の歪みが顕著なため、追加で重く減点
function calcClipScore(data: Float32Array, advice: AdviceItem[]): number {
  const MAX = AXIS_MAX.clip;
  const { clipRate, clippedCount, longestRunSamples } = estimateClipping(data);

  if (clipRate === null) return MAX;

  // クリッピング率 0%→満点、0.5%以上でほぼ0点（重い減点）
  let score = clamp((1 - clipRate / 0.005) * MAX, 0, MAX);

  // 連続クリップ(バースト歪み)は追加減点
  if (longestRunSamples > 5) {
    score = clamp(score - Math.min(MAX * 0.5, longestRunSamples * 0.3), 0, MAX);
  }

  if (clippedCount > 0) advice.push({ code: 'clipping' });

  return score;
}

// ==========================================================================
// 5. 背景ノイズ [25点満点]
// ==========================================================================
// 有音区間と無音(ノイズフロア)区間のRMS比からSNRを推定する。
//
// ブラウザは絶対音圧を知らないため「静かな部屋か」は言えない。言えるのは
// 「声に対してノイズが十分小さいか」だけ。
//
// 無音区間の割合の評価は削除した。無言が多いことは録音環境の欠点ではない。
//
// 残響の尾をノイズとして数えないよう、推定したRT60を渡している。
// 残響エネルギーは信号由来であり背景雑音ではない。
/**
 * ノイズ軸が満点になるSNR[dB]。
 *
 * 以前は40dBだった。**その設定では実質的に誰も「良好」判定に到達できない。**
 * 判定は最弱の軸の達成率で決まり「良好」は75%以上なので、40dB満点だと
 * ノイズ軸だけで SNR 30dB を要求することになる。実測では、劣化を一切
 * 加えていないスタジオ録音（CMU ARCTIC・素材自身のSNR 26.5〜32.6dB）でも
 * 4話者すべてが「使える」止まりで、288条件を通して「良好」が1件も出なかった。
 *
 * 公表されている了解度の基準はどれも、これよりはるかに低いSNRを「良好」とする。
 *   ISO 9921    … 残響が無ければ SNR +15dB 程度で STI 0.75「良好」
 *   ANSI S12.60 … 教室の暗騒音 35dBA 以下（発話 50〜55dBA なので SNR 15〜20dB）
 *   会議音声の一般的な指針 … SNR 20dB で良好、15dB で許容
 *
 * 25dBを満点に置くと SNR 20dB → 達成率0.80（良好）、15dB → 0.60（使える）、
 * 12dB → 0.48（使えない）となり、上の基準と一致する。
 * 25dB以上を同点にするのは、この道具の目的（環境が会議に適するか）にとって
 * 25dBと40dBの差が答えを変えないため。
 */
const FULL_MARKS_SNR_DB = 25;
function calcNoiseScore(
  data: Float32Array,
  sampleRate: number,
  rt60Sec: number | null,
  advice: AdviceItem[],
): number {
  const MAX = AXIS_MAX.noise;
  const FULL_SNR_DB = FULL_MARKS_SNR_DB;

  // 推定したRT60を渡し、残響の尾をノイズとして数えないようにする
  const { snrDb } = estimateSnr(data, sampleRate, rt60Sec);
  if (snrDb === null) return MAX / 2;

  const score = clamp((snrDb / FULL_SNR_DB) * MAX, 0, MAX);

  if (snrDb < 15) advice.push({ code: 'noise-high' });

  return score;
}
