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

import { clamp } from '../../lib/signal.ts';
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

/**
 * 判定の閾値。各軸の満点に対する達成率。
 *
 * **満点はスタジオ・放送品質を意味するので、「会議の録音として十分か」の境界は
 * 満点よりかなり下にある。** 尺度の意味を決め直したのに合わせて 0.75/0.5 から
 * 下げた。下げないと、実際には使える録音がすべて「不可」になる。
 *
 * ノイズ軸で換算すると公表基準と重なる（満点 SNR 45dB）。
 *   0.55 → SNR 24.8dB … 会議音声の指針が「良好」とする20dBより厳しい
 *   0.35 → SNR 15.8dB … ISO 9921 が STI 0.75「良好」とする +15dB 相当
 *
 * **この2つの値そのものは未検証。** 実録音に対する是非の判断（この録音を会議の
 * 記録として受け入れるか）を集めれば実測で決められるが、まだ集めていない。
 */
const VERDICT_GOOD_RATIO   = 0.55;
const VERDICT_USABLE_RATIO = 0.35;

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
  // ITU-T の超広帯域音声(16kHz)で満点、電話品質(3.4kHz)で0点。
  // 明瞭度の観点では7kHzで足りるが、それは採点ではなく助言の側で
  // 表現する（ADVISE_NARROW_HZ）。採点は品質の尺度なので上を詰めない。
  const effectiveHz = Math.min(bandwidthHz, sampleRate / 2);
  const bwFactor = clamp((effectiveHz - BW_MIN_HZ) / (BW_FULL_HZ - BW_MIN_HZ), 0, 1);
  const bandwidthScore = BANDWIDTH_MAX * bwFactor;

  // ---- こもり（1kHz以上の傾斜） ----
  const slope = estimateSpectralSlope(data, sampleRate, effectiveHz);
  let slopeScore: number;
  if (slope === null) {
    // 近似する区間が取れない = 帯域が2kHzも無い。電話品質未満。
    // その減点は帯域幅の内訳が担っているので、ここでは中間値にして二重減点を避ける。
    slopeScore = SLOPE_MAX / 2;
  } else if (slope < SLOPE_PLATEAU_LO_DB_OCT) {
    // 高域が落ちすぎ（こもり）
    slopeScore = SLOPE_MAX * clamp(
      (slope - SLOPE_MUFFLED_DB_OCT) / (SLOPE_PLATEAU_LO_DB_OCT - SLOPE_MUFFLED_DB_OCT), 0, 1,
    );
  } else if (slope > SLOPE_PLATEAU_HI_DB_OCT) {
    // 高域が過剰（ヒスノイズ、帯域外の混入）
    slopeScore = SLOPE_MAX * clamp(
      (SLOPE_HISSY_DB_OCT - slope) / (SLOPE_HISSY_DB_OCT - SLOPE_PLATEAU_HI_DB_OCT), 0, 1,
    );
  } else {
    slopeScore = SLOPE_MAX;
  }

  const score = clamp(bandwidthScore + slopeScore, 0, AXIS_MAX.frequency);

  if (effectiveHz < ADVISE_NARROW_HZ) advice.push({ code: 'bandwidth-narrow', value: effectiveHz });
  if (slope !== null && slope < ADVISE_MUFFLED_DB_OCT) advice.push({ code: 'muffled', value: slope });

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
/**
 * 帯域幅が満点になる有効帯域上限[Hz]。**満点は広帯域音声の上限を意味する。**
 *
 * 以前は7000Hzだった（ITU-Tの広帯域音声。会議音声の明瞭度にはそれ以上を要しない）。
 * 明瞭度の基準としては正しいが、**品質の尺度としては上が詰まっていた**——8.1kHzの
 * 録音と24kHzの録音が同じ満点になり、区別できなかった。
 *
 * 16000Hzの根拠: ITU-T の超広帯域音声が14kHz（G.722.1 Annex C）、フルバンドが20kHz。
 * 16kHzを満点に置くと、8kHz帯域（16kHzサンプリング由来）が0.37、電話品質が0で、
 * 実際に区別が付く。明瞭度上7kHzで足りることは変わらないが、それは判定の閾値の側で
 * 表現する。
 */
const BW_FULL_HZ = 16000;
/**
 * 帯域不足を助言する有効帯域上限[Hz]。**採点の尺度とは別に持つ。**
 *
 * 満点を16kHzに上げたとき、助言の条件が達成率0.7のままだったので
 * 12.2kHz以下すべてに「高音域が不足」と出るようになっていた。8.1kHz帯域
 * （16kHzサンプリング由来。OS標準の録音アプリや会議端末の大半がこれ）は
 * 会議音声として何の問題も無いのに助言が出る。しかも文面が主張する
 * 「子音が聞き取りにくい」は8kHzでは起きない。
 *
 * 音量軸と同じ扱いにする。**採点は品質の尺度（16kHz満点）、助言は明瞭度の
 * 基準（絶対値）。** 7000Hz は ITU-T の広帯域音声で、摩擦音・サ行の識別に
 * 必要な帯域はここでほぼ足りる。これを下回るのは電話帯域(3.4kHz)や
 * Bluetooth HFP(4kHz)で、どちらも利用者が録り方を変えれば直せる。
 */
const ADVISE_NARROW_HZ = 7000;
/**
 * こもりを助言する傾斜[dB/oct]。**採点の尺度とは別に持つ。**
 *
 * 以前は達成率0.7で判定していた（結果として -13.6dB/oct）。値としては同じだが、
 * 採点の境界を動かすと助言の条件も黙って動いてしまう。帯域幅の助言が実際に
 * それで壊れたので、こちらも絶対値で持つ。
 *
 * -14dB/oct の根拠: 実音声の自然な傾斜は -2.4〜-8.8dB/oct（4話者）。マイクを
 * 服やロの中に入れたり布で覆ったりすると -12dB/oct 以上の傾きが乗る。自然な
 * 範囲の最も急な値から5dB/oct 以上離れているので、声の暗い話者では出ない。
 */
const ADVISE_MUFFLED_DB_OCT = -14;

// ==========================================================================
// 3. 残響 [20点満点]
// ==========================================================================
// 会議室の音の悪さの主要因のひとつ。「静かな部屋なのに聞き取りにくい」の主犯で、
// かつユーザーが対処できる（カーテン、カーペット、マイクを口元に近づける）。
//
// 閾値は ANSI S12.60 / ISO 9921 の目安に置く。0.2秒以下は処理された部屋か
// 近接マイク、0.9秒以上は硬い面ばかりの部屋で発話が明らかに濁る水準。
//
// 測定不能な場合（喋り続けていて自由減衰が無い、デッドすぎて発話自体の減衰と
// 分離できない）は中間値を返し、その軸を unreliable に入れる。満点は与えない。
function calcReverbScore(rt60Sec: number | null, advice: AdviceItem[]): number {
  const MAX = AXIS_MAX.reverb;
  /**
   * 満点・0点とするRT60[秒]。**満点は音響処理をした部屋か近接マイクを意味する。**
   *
   * 以前は 0.4／1.2秒だった。品質の尺度としては上が詰まっており、0.13秒の録音と
   * 0.25秒の録音が同じ満点になっていた。
   *
   * 根拠: ANSI S12.60 は小さな教室に RT60 0.6秒以下を求め、ISO 9921 は 0.5秒を
   * 超えると明瞭度が落ちるとする。0.2秒は処理された部屋か近接マイク、0.9秒は
   * 硬い面ばかりの部屋で発話が明らかに濁る水準。
   *
   * 注意: RT60の推定誤差は MAE 0.141秒あり、0.2〜0.9秒という幅の20%に相当する。
   * 4点ぶんの揺れが出るので、この軸の点数を細かく読んではいけない。
   */
  const GOOD_SEC = 0.2;
  const BAD_SEC  = 0.9;

  if (rt60Sec === null) {
    advice.push({ code: 'reverb-unmeasurable' });
    // 測定できなかったときは「使えるかどうかの境界」に置く。0.6倍にしていた頃は、
    // 実測した0.7秒の部屋(6/20)より測定不能(12/20)のほうが高得点になっていた。
    return MAX * VERDICT_USABLE_RATIO;
  }

  const score = clamp((1 - (rt60Sec - GOOD_SEC) / (BAD_SEC - GOOD_SEC)) * MAX, 0, MAX);

  /**
   * 残響を助言するRT60[秒]。**採点の境界（0.2／0.9秒）とは別に持つ。**
   *
   * 以前は0.7秒。助言の的中を測って初めて分かったが、**それでは再現率0.44しか
   * 無かった**——実際に残響の強い部屋（RT60 1.0秒）の半分以上で助言が出ない。
   * 原因は推定側の偏り。RT60は系統的に短く出る（bias -0.11秒）ので、真値1.0秒の
   * 部屋は中央値0.68秒と推定される。0.7秒の閾値はその真下にある。
   *
   * 掃引した結果（真値の基準は ANSI S12.60 の教室上限 0.6秒）:
   *   閾値0.70 … 適合率1.00 / 再現率0.44
   *   閾値0.60 … 適合率1.00 / 再現率0.64  ← これ
   *   閾値0.50 … 適合率0.87 / 再現率0.80
   *   閾値0.40 … 適合率0.67 / 再現率0.96
   *
   * 0.60秒は0.70秒を完全に上回る（空振りは同じ0件で、見落としが5件減る）。
   * これ以上下げると空振りが出る。**空振りは見落としより重い**——直さなくてよい
   * ものを直せと言うほうが道具への信頼を損なうので、ここで止める。
   *
   * 0.60秒という値そのものは ANSI S12.60 が小さな教室に求める上限で、掃引に
   * 合わせて選んだ数字ではない。偏りを打ち消す補正を入れる必要が無かったのは、
   * 推定が短く出る方向に偏っているためたまたま都合が良かっただけである。
   */
  const ADVISE_REVERB_SEC = 0.6;
  if (rt60Sec > ADVISE_REVERB_SEC) advice.push({ code: 'reverb-strong', value: rt60Sec });

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
 * ノイズ軸が満点になるSNR[dB]。**満点はスタジオ・放送品質を意味する。**
 *
 * 経緯: 最初は40dBだったが、判定が最弱の軸で決まるため誰も「良好」に到達できず、
 * 25dBに下げた。ところが今度は実録音がすべて満点で並び、互いに区別できなくなった
 * （実録音4本が96〜100点）。
 *
 * 尺度の意味を決め直した。**満点は「これ以上良くならない」水準に置き、
 * 「会議の録音として十分か」は判定の閾値が担う。** こうすると尺度に上の余地が
 * 残り、良い録音同士も区別できる。
 *
 * 45dBの根拠: 放送の音声は概ね50〜60dB、音響処理をした自宅スタジオで45dB程度。
 * 45dBを満点に置くと、判定の閾値が公表基準とうまく重なる。
 *   良好の閾値 0.55 → SNR 24.8dB（会議音声の指針が「良好」とする20dBより厳しい）
 *   使えるの閾値 0.35 → SNR 15.8dB（ISO 9921 が STI 0.75「良好」とする+15dB相当）
 */
const FULL_MARKS_SNR_DB = 45;
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
