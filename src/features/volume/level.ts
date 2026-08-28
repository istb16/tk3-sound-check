/**
 * ボリュームチェックの測定。DOM非依存。
 *
 * 会場でPAから流れている音を客席で拾い、ミキサーを調整するための相対レベル計。
 * **絶対音圧(dBA)は出さない。** マイクの感度が判別できないので、dBFS からの
 * 換算は原理的に不可能である。したがってここが返すのは「フルスケールに対する
 * A特性重み付けレベル」であり、それ自体には意味が無い。意味を持つのは差だけ。
 */

import { dbfs, maxAbs } from '../../lib/dsp/stats.ts';
import { AWeightingFilter } from '../../lib/dsp/weighting.ts';
import { FrameSplitter, RingWindow } from '../../lib/stream/frames.ts';

/** 表示とLeqの更新間隔。バーの手応えと計算量の折り合い */
export const FRAME_MS = 100;
/** 比較に使う等価レベルの窓。PAの音は瞬間ごとに10dB以上揺れるので平均で見る */
export const LEQ_WINDOW_SEC = 10;
/** 音割れ回数を数える窓。原因を取り除けば自動で消える長さ */
export const CLIP_WINDOW_SEC = 10;
/** ピークホールドの保持時間 */
export const PEAK_HOLD_SEC = 1;

/**
 * クリップとみなす振幅。音質チェックの estimateClipping と同じ値だが、
 * **定数は共有しない**——あちらは採点の尺度、こちらは会場での目安であり、
 * 片方を動かしたときにもう片方が黙って壊れるのを避ける。
 */
const CLIP_THRESHOLD = 0.98;

/**
 * 「入力段が限界に近い」とみなす振幅(-3dBFS)。
 *
 * クリップ判定(0.98)との間にこれを置くのは、**割れる手前で差が縮むから**である。
 * MEMSマイクは概ね120dB SPL付近で1%歪みに達し、会場の音圧(90〜105dBA)はその
 * 手前に入りうる。0.6FS から圧縮を始めるマイクを通した実測（真の変化は常に +6.02dB）:
 *
 *   入力RMS -18dB  ピーク -5.1dB  表示 6.02dB  割れ 0.0s  限界 0.0s  → 警告なし
 *   入力RMS -15dB  ピーク -2.0dB  表示 5.93dB  割れ 0.0s  限界 0.5s  → 警告なし
 *   入力RMS -12dB  ピーク -0.6dB  表示 5.57dB  割れ 0.0s  限界 9.7s  → 限界に近い
 *   入力RMS  -9dB  ピーク -0.1dB  表示 4.77dB  割れ 1.7s  限界10.0s  → 音割れ
 *
 * 差が目に見えて縮み始める行で、まだ 0.98 には届いていない——clipSeconds は 0 の
 * ままで、**警告が何も出ないまま差だけが小さくなる**。この道具でいちばん静かな
 * 壊れ方になるので、専用の窓を持って別に数える。
 */
const NEAR_CLIP_THRESHOLD = 0.708;

/**
 * 段差とみなす最小の変化量[dB]。
 *
 * 実素材で「操作していないのに検出される段差」を測って決めた。1.5dB なら定常素材で
 * 一度も出ず、±2dB で変調した音楽でも出るのは1%未満の時間に留まる
 * （STEP_MIN_FRAMES の表を参照）。**話し声では頻繁に真になるが、それは誤検出では
 * ない**——無音区間を挟む素材では10秒平均が本当に動いており、数値を信じてよい
 * 状態では無い。
 */
export const STEP_DB = 1.5;

/**
 * A特性の差とZ特性の差がこれ以上離れたら、帯域別の操作として画面に断る[dB]。
 *
 * 「同じ端末・同じ場所なら差は正しい」が成り立つのは**全帯域が一律に動いたとき
 * だけ**である。サブのフェーダーや低域EQを動かすと両者は離れる（実測: 120Hz以下
 * +6dB のシェルフで A特性 +1.01dB / Z特性 +2.45dB）。1.0dB は素材の揺れでは
 * 届かず、意味のある帯域操作では確実に超える大きさとして選んだ。
 */
export const BAND_MISMATCH_DB = 1.0;

/**
 * 「入力段が限界に近い」を画面に出すまでの継続時間[秒]。
 *
 * 単発のピークは音楽なら普通に出る。10秒窓の2割が限界域に張り付いて初めて、
 * 差が縮んでいる可能性の話になる。
 */
export const NEAR_CLIP_WARN_SEC = 2;

/**
 * 段差判定で前後それぞれに許す最小フレーム数(0.2秒)。
 *
 * **これが「操作した直後に気づけるか」と「残り秒数がどこまで出せるか」を決める。**
 * 新しい側がこの長さに満たない間は真の分割点に置けず、薄まった分割でしか見えない。
 *
 * ただし短い区間の平均は当てにならないので、**短いほど大きな段差を要求する**
 * （`stepThresholdDb`）。一定の閾値のまま最小長だけ縮めると、単発の大きな
 * フレーム1つで段差ありになる。実測:
 *
 *   設定                  | 誤検出(定常/音楽±2dB) | 収束中が出るまで(+2/+3/+6dB) | 残り秒数の幅
 *   20フレーム 一定閾値      | 0.0% / 0.0%        | 1.4s / 0.8s / 0.3s        | 2.0〜8.0s
 *    5フレーム 一定閾値      | 0.0% / 0.4%        | 0.4s / 0.3s / 0.1s        | 0.5〜9.5s
 *    2フレーム 長さ補正あり   | 0.0% / 0.4%        | 0.3s / 0.2s / 0.1s        | 0.2〜9.8s
 *
 * **取り違えの向きが非対称なので、迷ったら検出する側に倒す**——余分な「収束中」は
 * 正しい数値を疑わせるだけだが、出し損ねると確定色つきの間違った数値がそのまま
 * 読まれる。+2dB の操作で 0.3秒 残るのは、それ以上詰めると誤検出が増える側に入る
 * ためで、その 0.3秒 のあいだの表示誤差は 0.06dB（表示の丸め幅以下）である。
 */
const STEP_MIN_FRAMES = 200 / FRAME_MS;

/** 長さ補正の基準となる区間長(0.5秒)。これ以上長い区間には補正をかけない */
const STEP_FULL_FRAMES = 500 / FRAME_MS;

/**
 * 短いほうの区間が `frames` のときに要求する段差量[dB]。
 *
 * 平均の標準誤差が 1/√n で縮むことに合わせて `√(基準長/実長)` を掛ける。
 * 0.2秒(2フレーム)なら 1.5dB の約1.6倍、2.4dB を超えないと段差と呼ばない。
 */
function stepThresholdDb(frames: number): number {
  return STEP_DB * Math.sqrt(STEP_FULL_FRAMES / Math.min(frames, STEP_FULL_FRAMES));
}

// ==========================================================================
// メーター
// ==========================================================================

export interface MeterState {
  /** 直近フレームのA特性レベル[dBFS]。バーを動かすための瞬時値 */
  instantDb: number;
  /** 直近 LEQ_WINDOW_SEC の等価レベル[dBFS]。比較に使うのはこちら */
  leqDb: number;
  /**
   * 直近 LEQ_WINDOW_SEC の等価レベル[dBFS]、**重み付け無し(Z特性)**。
   *
   * A特性の差と食い違ったときにだけ画面へ出す。差が正しいのは「全帯域が
   * 一律に動いたとき」だけで、低域だけを動かす操作では両者が離れる——
   * 実測で、120Hz以下に +6dB のシェルフをかけたとき A特性は +1.01dB、
   * Z特性は +2.45dB を示した。A特性ひとつでは、その食い違いに気づけない。
   */
  leqZDb: number;
  /**
   * 直近 PEAK_HOLD_SEC の**サンプルピーク**[dBFS]。重み付け前の波形で取る。
   *
   * 100msのRMSではない。RMSの最大値だと波高を示さないうえ、A特性後では
   * 入力段の話にもならない——振り切った60Hzのサイン波(-0.01dBFS)が
   * -30dBFS と表示される。ピークを出す言い分は「校正と無関係に入力段が0に
   * 当たるかを示す」ことなので、当たるかどうかを見ている値でなければならない。
   */
  peakHoldDb: number;
  /**
 * 直近 CLIP_WINDOW_SEC のうち、音割れが含まれていた時間[秒]。
 *
 * 「回数」では数えられない。クリップした波形は半周期ごとに閾値を下回るので、
 * 閾値の再突入を数えると 1kHz の正弦波を3dB突っ込んだだけで10秒間に20000回になる。
 * かといって近接した突入をまとめて「1回」にすると、鳴りっぱなしのときに
 * 移動窓が始点を通り過ぎた時点で0に戻ってしまう。
 * フレーム単位の時間で持てば、単発は 0.1秒、鳴りっぱなしは 10.0秒 と素直に出る。
 */
  clipSeconds: number;
  /**
   * 直近 CLIP_WINDOW_SEC のうち、入力段が限界に近かった時間[秒]。
   * 割れてはいないが差が縮み始める領域（NEAR_CLIP_THRESHOLD 参照）。
   */
  nearClipSeconds: number;
  /** Leq の窓が埋まったか。埋まる前の値は参考値 */
  leqReady: boolean;
  /** 更新されたフレーム数。テストと「まだ測っていない」の判定に使う */
  frames: number;
  /** Leq の窓が埋まるまでの残り秒数。0 なら埋まっている */
  warmupRemainingSec: number;
  /**
   * 窓の中で見つかった段差[dB]。0 なら窓は単一のレベルで満たされている。
   * 符号は「新しいほうが大きければ正」。
   *
   * **画面には出さない。** 変化量は基準との差が伝えており、段差量を並べても
   * 読む相手が増えるだけである。ここに置いてあるのは、検出が正しい大きさを
   * 見つけているかをテストから確かめるため——`settlingRemainingSec` だけだと
   * 「たまたま何かを見つけた」と「+6dB を見つけた」が区別できない。
   */
  stepDb: number;
  /**
   * 段差の前のフレームが窓から出るまでの残り秒数。0 なら収束済み。
   *
   * **これが 0 でない間、leqDb は2つのレベルの混合である。** 移動窓の必然で
   * あって実装の不具合ではない——+6dB のフェーダー操作から5秒後、10秒窓の
   * 半分はまだ操作前なので、表示は理論値どおり +4.0dB になる。問題は、
   * その +4.0 が収束済みの +4.0 と見分けがつかないことのほうにある。
   */
  settlingRemainingSec: number;
  /**
   * 測り終えた基準レベル[dBFS]。まだ揃っていなければ null。
   *
   * **押した時点から先の10秒**で測る。遡って測ると、押す前に起きたレベル変化が
   * 基準に焼き付く——開始してから客席へ歩き、着席直後に押すと、歩行中の音が
   * 基準の半分を占める。実測で、押す5秒前に +6dB のレベル変化があった場合、
   * 遡る窓は真値から 2.0dB（実音声では 4.7dB）ずれ、押してからの窓は
   * 0.02dB（同 0.60dB）に収まった。レベル変化が無い場合も遡る窓より悪くならない
   * （実音声で RMS 2.04dB → 1.33dB）。
   */
  referenceDb: number | null;
  /** 同じ区間の重み付け無し(Z特性)の基準レベル[dBFS] */
  referenceZDb: number | null;
  /** 基準を測っている最中か */
  referenceCapturing: boolean;
  /** 基準が揃うまでの残り秒数 */
  referenceRemainingSec: number;
}

/** 無音（完全な0）のときに返す下限。-Infinity を画面に出さないため */
export const FLOOR_DB = -120;

/**
 * 窓の中の段差を探す。
 *
 * 分割点を1つ動かしながら、前後のパワー平均がいちばん離れる位置を選ぶ。
 * 本物の段差に対しては正確で、定常ピンクノイズに +6dB を与えた3秒後に
 * 「5.99dB / 旧フレーム残 70」（真値 70）を返す。
 *
 * ただし分割点は窓の両端 STEP_MIN_FRAMES フレームには置けないので、**操作の
 * 直後と直前だけは位置が端に張り付く**。そのぶん残り秒数は 0.5〜9.5秒の範囲に
 * 収まり、真値が 9.5秒を超える最初の0.5秒間は動かない。
 *
 * 「フェーダーが動いたか」は分からない。分かるのは**10秒前と今でレベルが
 * 違うこと**だけで、それがこの表示に必要な全部である。
 */
function detectStep(powers: readonly number[]): { stepDb: number; oldFrames: number } {
  const n = powers.length;
  if (n < STEP_MIN_FRAMES * 2) return { stepDb: 0, oldFrames: 0 };

  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + powers[i];

  // 分割ごとに要求する段差量が違うので、**閾値をどれだけ上回ったか**で選ぶ。
  // 絶対値で選ぶと、短くて当てにならない区間の大きな値が常に勝つ
  let bestMargin = 0;
  let bestDb = 0;
  let bestSplit = 0;
  for (let i = STEP_MIN_FRAMES; i <= n - STEP_MIN_FRAMES; i++) {
    const older = prefix[i] / i;
    const newer = (prefix[n] - prefix[i]) / (n - i);
    if (older <= 0 || newer <= 0) continue;
    const db = 10 * Math.log10(newer / older);
    // 素材の自然な揺れを段差と呼ぶと、「収束中」が消えなくなって
    // 注意書きとして機能しなくなる
    const margin = Math.abs(db) - stepThresholdDb(Math.min(i, n - i));
    if (margin > bestMargin) { bestMargin = margin; bestDb = db; bestSplit = i; }
  }

  return bestSplit > 0 ? { stepDb: bestDb, oldFrames: bestSplit } : { stepDb: 0, oldFrames: 0 };
}

/**
 * 流れてくるPCMを受け取り、100msごとに測定値を更新する。
 *
 * 設計上の要点は「バーは瞬時値、比較は平均」。PAから流れる音楽や話し声は
 * 瞬間ごとに10dB以上揺れるので、瞬時値どうしを引き算してもフェーダーを
 * 何dB動かせばよいか決まらない。
 */
export class VolumeMeter {
  private readonly filter: AWeightingFilter;
  private readonly framer: FrameSplitter;

  /** フレーム未満の端数。波形そのものは要らないので二乗和だけ持つ */
  private pendingSum = 0;
  private pendingSumZ = 0;
  /** フレーム内のサンプルピーク（重み付け前）。割れ・限界・波高を1回の走査で賄う */
  private pendingPeak = 0;

  /** フレームごとのA特性パワー（振幅の二乗平均）。Leq の窓 */
  private readonly powers: RingWindow;
  /** フレームごとの重み付け無しパワー。帯域別の操作を見抜くための窓 */
  private readonly powersZ: RingWindow;
  /** フレームごとのサンプルピーク（振幅）。ピークホールドの窓 */
  private readonly peaks: RingWindow;
  /** フレームごとに、そのフレームが音割れを含んでいたか（1/0）。クリップの窓 */
  private readonly clips: RingWindow;
  /** 同上、入力段が限界に近かったか（1/0） */
  private readonly nearClips: RingWindow;

  private lastInstantDb = FLOOR_DB;
  private frames = 0;

  /** 基準の測定。`refTarget` が 0 なら測っていない */
  private refSum = 0;
  private refSumZ = 0;
  private refFrames = 0;
  private refTarget = 0;
  private refDb: number | null = null;
  private refZDb: number | null = null;

  constructor(sampleRate: number) {
    this.filter = new AWeightingFilter(sampleRate);
    this.framer = new FrameSplitter((sampleRate * FRAME_MS) / 1000);
    this.powers    = new RingWindow((LEQ_WINDOW_SEC * 1000) / FRAME_MS);
    this.powersZ   = new RingWindow((LEQ_WINDOW_SEC * 1000) / FRAME_MS);
    this.peaks     = new RingWindow((PEAK_HOLD_SEC * 1000) / FRAME_MS);
    this.clips     = new RingWindow((CLIP_WINDOW_SEC * 1000) / FRAME_MS);
    this.nearClips = new RingWindow((CLIP_WINDOW_SEC * 1000) / FRAME_MS);
  }

  /**
   * 基準の測定を始める。ここから LEQ_WINDOW_SEC 秒ぶんのフレームを平均する。
   *
   * **遡らないのが要点。** 「基準にする」は「いまの音を憶えておけ」という意思表示
   * であって、「さっきまでの音を憶えておけ」ではない。遡って測ると、押す前に
   * 起きたレベル変化——客席へ歩く、演目が変わる——が基準に混ざり、
   * **フェーダーに触れていないのに差が出る**（`MeterState.referenceDb` 参照）。
   */
  beginReference(): void {
    this.refSum = 0;
    this.refSumZ = 0;
    this.refFrames = 0;
    this.refTarget = (LEQ_WINDOW_SEC * 1000) / FRAME_MS;
    this.refDb = null;
    this.refZDb = null;
  }

  /** 基準を捨てる。測定中なら中止する */
  clearReference(): void {
    this.refSum = 0;
    this.refSumZ = 0;
    this.refFrames = 0;
    this.refTarget = 0;
    this.refDb = null;
    this.refZDb = null;
  }

  /**
   * PCMチャンクを流し込む。フレームが1つ以上完成したら true を返す
   * （呼び出し側が画面を更新すべきタイミング）。
   */
  push(chunk: Float32Array): boolean {
    // A特性は生の波形にかける。フィルタは状態を持つのでチャンクをまたいで連続する
    const weighted = this.filter.process(chunk);

    return this.framer.push(chunk, (offset, length, completed) => {
      for (let i = offset; i < offset + length; i++) {
        const w = weighted[i];
        this.pendingSum += w * w;
        const z = chunk[i];
        this.pendingSumZ += z * z;
      }
      // 振幅は重み付け前の値で見る。割れているかどうかは入力段の話であって
      // 聞こえ方の話ではない——60Hz はA特性で27dB落ちるが、入力段では割れている
      const peak = maxAbs(chunk, offset, length);
      if (peak > this.pendingPeak) this.pendingPeak = peak;

      if (completed) this.commitFrame();
    });
  }

  private commitFrame(): void {
    const power  = this.pendingSum  / this.framer.frameSize;
    const powerZ = this.pendingSumZ / this.framer.frameSize;
    this.powers.push(power);
    this.powersZ.push(powerZ);

    // 基準は押した時点から先へ積む。遡らないので、押す前のレベル変化は混ざらない
    if (this.refTarget > 0) {
      this.refSum  += power;
      this.refSumZ += powerZ;
      this.refFrames++;
      if (this.refFrames >= this.refTarget) {
        const m  = this.refSum  / this.refFrames;
        const mz = this.refSumZ / this.refFrames;
        this.refDb  = m  > 0 ? dbfs(Math.sqrt(m))  : FLOOR_DB;
        this.refZDb = mz > 0 ? dbfs(Math.sqrt(mz)) : FLOOR_DB;
        this.refTarget = 0;
      }
    }

    this.peaks.push(this.pendingPeak);
    this.clips.push(this.pendingPeak >= CLIP_THRESHOLD ? 1 : 0);
    this.nearClips.push(this.pendingPeak >= NEAR_CLIP_THRESHOLD ? 1 : 0);
    this.lastInstantDb = power > 0 ? dbfs(Math.sqrt(power)) : FLOOR_DB;

    this.pendingSum = 0;
    this.pendingSumZ = 0;
    this.pendingPeak = 0;
    this.frames++;
  }

  get state(): MeterState {
    if (this.frames === 0) {
      return {
        instantDb: FLOOR_DB, leqDb: FLOOR_DB, leqZDb: FLOOR_DB, peakHoldDb: FLOOR_DB,
        clipSeconds: 0, nearClipSeconds: 0, leqReady: false, frames: 0,
        warmupRemainingSec: LEQ_WINDOW_SEC,
        stepDb: 0, settlingRemainingSec: 0,
        ...this.referenceState,
      };
    }
    // Leq はパワーの平均を dB にする（dB の平均ではない）
    const meanPower  = this.powers.mean();
    const meanPowerZ = this.powersZ.mean();
    const peak = this.peaks.max();

    // 窓が埋まる前は「あと何秒で収束するか」を言えない（そもそも全体が
    // 収束前である）。埋まってから初めて段差を探す
    const step = this.powers.full
      ? detectStep(this.powers.values)
      : { stepDb: 0, oldFrames: 0 };

    return {
      instantDb:  this.lastInstantDb,
      leqDb:      meanPower  > 0 ? dbfs(Math.sqrt(meanPower))  : FLOOR_DB,
      leqZDb:     meanPowerZ > 0 ? dbfs(Math.sqrt(meanPowerZ)) : FLOOR_DB,
      peakHoldDb: peak > 0 ? dbfs(peak) : FLOOR_DB,
      clipSeconds:     (this.clips.count((c) => c === 1) * FRAME_MS) / 1000,
      nearClipSeconds: (this.nearClips.count((c) => c === 1) * FRAME_MS) / 1000,
      leqReady:   this.powers.full,
      frames:     this.frames,
      warmupRemainingSec:
        Math.max(0, (this.powers.capacity - this.powers.length) * FRAME_MS) / 1000,
      stepDb: step.stepDb,
      settlingRemainingSec: (step.oldFrames * FRAME_MS) / 1000,
      ...this.referenceState,
    };
  }

  private get referenceState(): Pick<
    MeterState, 'referenceDb' | 'referenceZDb' | 'referenceCapturing' | 'referenceRemainingSec'
  > {
    return {
      referenceDb:  this.refDb,
      referenceZDb: this.refZDb,
      referenceCapturing: this.refTarget > 0,
      referenceRemainingSec:
        this.refTarget > 0 ? ((this.refTarget - this.refFrames) * FRAME_MS) / 1000 : 0,
    };
  }
}

/**
 * バーの表示位置(0..1)。
 *
 * 会場では絶対的な「適正位置」が無いので、目盛りは意味を持たない。
 * -70dBFS を左端、0dBFS を右端に置いて、動きが見えることだけを目的にする。
 */
export function barRatio(db: number): number {
  const lo = -70;
  if (!Number.isFinite(db)) return 0;
  return Math.min(1, Math.max(0, (db - lo) / (0 - lo)));
}
