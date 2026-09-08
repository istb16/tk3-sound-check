/**
 * ボリュームチェックの測定。DOM非依存。
 *
 * 会場でPAから流れている音を客席で拾い、ミキサーを調整するための相対レベル計。
 * **絶対音圧(dBA)は出さない。** マイクの感度が判別できないので、dBFS からの
 * 換算は原理的に不可能である。したがってここが返すのは「フルスケールに対する
 * A特性重み付けレベル」であり、それ自体には意味が無い。意味を持つのは差だけ。
 *
 * **測るのは「声の10秒」であって「実時間の10秒」ではない。** 会場で鳴っているのは
 * マイクを通した人の声で、間が空く。実時間の窓で全フレームを平均すると、平均が
 * 喋りの密度で動く——フェーダーに触れていなくても、よく喋る区間で基準を取って
 * 間の多い区間と比べれば数dBの差が出る。有音フレームだけを、決まった枚数ぶん
 * 集めて平均する（`ActiveWindow`）。
 */

import { dbfs, maxAbs, percentile } from '../../lib/dsp/stats.ts';
import { AWeightingFilter } from '../../lib/dsp/weighting.ts';
import { FrameSplitter, RingWindow, SampleRing } from '../../lib/stream/frames.ts';
import { blackmanHarrisWindow, fft } from '../../lib/dsp/fft.ts';

/** 表示とレベルの更新間隔。バーの手応えと計算量の折り合い */
export const FRAME_MS = 100;

/**
 * 比較に使う等価レベルの窓。**実時間ではなく有音フレームで数える。**
 *
 * 10秒を選んだ理由は元々「PAの音は瞬間ごとに10dB以上揺れるので平均で見る」で、
 * これは平均に要る長さの話である。無音を混ぜても揺れは平らにならない（むしろ
 * 喋りの密度という別の変数が入る）ので、10秒は**声の10秒**として読み替える。
 */
export const ACTIVE_WINDOW_SEC = 10;

/**
 * 有音フレームの窓が実時間で遡ってよい上限[秒]。
 *
 * 喋りが疎な会場では、直近100枚の有音フレームが数分前まで遡りうる。設計文書は
 * 中断の扱いで「実時間の何分にもまたがった平均」を明確に拒否している——その間に
 * 会場は何度でも変わる。上限に当たった古い有音フレームは窓から落とし、窓が
 * 埋まらなくなった時点で数値を保持に落とす。
 *
 * **この値は「どれだけ喋っていれば数値を出すか」も同時に決めている。**
 * 30秒に10秒ぶんなので、有音率 33% を下回ると数値が出なくなる。別に比率の
 * しきい値を持たないのは、2つの数字が食い違ったときにどちらが効いているのかが
 * 画面から分からなくなるためである。
 */
export const ACTIVE_MAX_SPAN_SEC = 30;

/**
 * ゲートの閾値を決めるための履歴の長さ[秒]。実時間で数える。
 *
 * 閾値は「この履歴のp95から `ACTIVE_RANGE_DB` 下」に置く。履歴が短いと、長い間の
 * あいだに履歴が無音だけで埋まり、閾値が無音まで下がって**間を有音と判定する**。
 * 長すぎると、フェーダーを大きく下げた直後に古い大きな音が p95 を支え続け、
 * 下げた後の声を無音と判定する。20秒はその折り合いである（`ACTIVE_RANGE_DB` を
 * 超える下げ幅では、履歴が入れ替わるまで声を取り落とす）。
 */
export const GATE_HISTORY_SEC = 20;

/**
 * 有音とみなすレベル範囲[dB]。履歴のp95からこれだけ下までを有音とする。
 *
 * **平均ではなくp95を基準にするのが要点である。** BS.1770 の相対ゲートは「全体
 * 平均から -10dB」だが、その全体平均は喋りの密度そのもので動く——直したい病気で
 * 閾値が動くことになる。p95 は「いちばん大きく喋っているところ」にぶら下がるので、
 * 間の多寡でほとんど動かない。音質チェックの `estimateLevel`（ITU-T P.56 の
 * 考え方）と同じ形だが、**定数は共有しない**——あちらは録音全体から有効音声レベルを
 * 出すための幅(25dB)で、こちらは会場で声の下に敷かれた BGM を落とすための幅である。
 *
 * 値の根拠は `validation/volume-gate.md` の実測表。
 */
export const ACTIVE_RANGE_DB = 12;

/** 音割れ回数を数える窓[秒]。実時間。原因を取り除けば自動で消える長さ */
export const CLIP_WINDOW_SEC = 10;
/** ピークホールドの保持時間[秒]。実時間 */
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
 * （STEP_MIN_FRAMES の表を参照）。
 *
 * **有音フレームだけの窓で見るようになったぶん、話し声での誤検出は減る。**
 * 以前は無音区間が窓に入るせいで10秒平均が本当に動いており、それを段差として
 * 拾っていた（それは誤検出ではなかった）。窓から無音が消えたので、いま残る段差は
 * 会場のレベルが動いたときのものである。
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
 * 基準と「違う音」とみなすスペクトル距離[dB]。
 *
 * **ゲートは声の検出器ではなく「大きい側の検出器」である。** 拍手は大きく、10秒
 * 持続する。ゲートは全通しするので有音率は 100% になり、「声が足りません」は
 * 発火しない。ゲートを入れたぶん拍手だけが平均を占めるので、**入れる前よりはっきり
 * 間違った数値**が出る。そこで基準を取ったときのスペクトルの形を憶えておき、形が
 * 違う音を測っている間は数値を出さない。
 *
 * 判定するのは「基準と違う音か」だけで、**声かどうかは判定しない**。話者性の判定は
 * 無校正のマイクとオクターブ6バンドでできることではないし、この道具に要るのは
 * 「憶えた音と同じものを測り続けているか」だけである。
 *
 * 値の根拠は `validation/volume-gate.md` の実測表。**同じ話者の別の発話・話者交代で
 * 超えず、拍手・BGM・映像で超える**位置を探し、迷ったら検出する側（黙る側）に
 * 倒している——空振りしても数値は保持に落ちるだけで、嘘は出ない。
 */
export const SHAPE_DISTANCE_DB = 5.0;

/**
 * 段差判定で前後それぞれに許す最小フレーム数(0.2秒ぶんの声)。
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
 * 保持中の段差判定に使う、届いた有音フレームの枚数と、判定に要る最小枚数。
 *
 * 少ない枚数の平均は当てにならないので、1秒ぶん（10枚）届くまでは判定しない。
 * 単発のフレームで保持を捨てると、拍手の1発で数値が消える。
 */
const POST_HOLD_FRAMES = 2000 / FRAME_MS;
const POST_HOLD_MIN_FRAMES = 1000 / FRAME_MS;

/** 有音フレームの窓が満たされる枚数 */
const ACTIVE_WINDOW_FRAMES = (ACTIVE_WINDOW_SEC * 1000) / FRAME_MS;
/** 有音フレームが遡ってよい上限（フレーム数） */
const ACTIVE_MAX_SPAN_FRAMES = (ACTIVE_MAX_SPAN_SEC * 1000) / FRAME_MS;

/** スペクトルの形を測るFFT長。100msフレームごとに直近この長さを見る */
const SHAPE_FFT_SIZE = 2048;

/**
 * 形を測るオクターブバンドの中心周波数[Hz]。
 *
 * ハウリングチェックの表示バンドと同じ並びを使う。下を250Hzで切るのは同じ理由
 * （48kHz・FFT では下側のビンが足りない）に加えて、**低域は定在波で場所ごとに
 * 10dB以上変わる**ので、形の比較にいちばん向かない成分だからである。
 */
const SHAPE_BANDS_HZ = [250, 500, 1000, 2000, 4000, 8000] as const;

/**
 * 形が持つバンドの数。**保存した基準を読み戻すときの検算に使う。**
 *
 * `shapeDistanceDb` は短いほうに合わせて比べるので、長さの違う形が紛れ込んでも
 * 例外にならず、**少ないバンドで比べた小さめの距離**が黙って出る。保存の側で
 * 弾けるように公開している。
 */
export const SHAPE_BAND_COUNT = SHAPE_BANDS_HZ.length;

/**
 * 形を測るときに、いちばん大きいバンドから何dB下までを見るか。
 *
 * これ以上下のバンドはFFTの漏れと暗騒音で決まるので、音源の識別には使えない。
 * 床を置かないと、そういうバンドの値がそのまま距離に効いてしまう。
 */
const SHAPE_FLOOR_DB = 60;

/**
 * 有音とみなす下限[dBFS]。履歴のp95から `rangeDb` 下。
 * 履歴が無い／完全な無音しか無いなら null（下限を引けない）。
 *
 * **基準があるときは、閾値を基準より下へ降ろさない。** p95 だけで決めると、間が
 * 履歴（`GATE_HISTORY_SEC`）より長く続いたときに履歴が暗騒音だけで埋まり、閾値が
 * そこまで下がって**暗騒音を有音と判定し始める**。窓は暗騒音で満たされ、確定した顔で
 * `-27.9 dB` が出る——この道具がいちばん避けたい壊れ方である（実装して実際にそうなった）。
 * 基準は「測りたい音のレベル」そのものなので、そこを床にすれば起きない。
 *
 * 代償として、**基準から `ACTIVE_RANGE_DB` を超えて下げた音は追えなくなる**。
 * 12dB を超える下げは画面に「声が足りません」を出し、基準の取り直しを促す形になる。
 * 黙るほうへ倒したのは、この道具で重いのは沈黙ではなく確信を持った誤りだからである。
 *
 * **関数として切り出してあるのは、検証スクリプトが幅を振るためである。**
 * 幅を決めるための実測（`validation/volume-gate.ts`）が、製品が使うのと違う規則を
 * 測っていたら意味が無い。
 */
export function gateThresholdDb(
  historyDb: readonly number[], rangeDb: number = ACTIVE_RANGE_DB,
  referenceDb: number | null = null,
): number | null {
  if (historyDb.length === 0) return null;
  const p95 = percentile([...historyDb], 0.95);
  if (p95 <= FLOOR_DB) return null;
  // 基準があるなら、閾値は基準より下へは降りない（`anchor` の注記を参照）
  const anchor = referenceDb === null ? p95 : Math.max(p95, referenceDb);
  return anchor - rangeDb;
}

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
// スペクトルの形
// ==========================================================================

/**
 * バンドパワーを「形」に直す。**レベルを落として形だけを残す。**
 *
 * 各バンドを dB にしてから全体の平均を引く。こうすると、同じ音源のままフェーダーを
 * 動かしても形は変わらない——変わったら音源が変わったことになる。
 */
export function shapeOf(bandPowers: readonly number[]): number[] {
  const raw = bandPowers.map((p) => (p > 0 ? 10 * Math.log10(p) : -Infinity));
  // **床はいちばん大きいバンドからの相対で置く。** 絶対値で置くと、床に当たる
  // バンドがあるときにフェーダーを動かすだけで形が変わる——1kHz の正弦波で
  // 実際にそうなった（他のバンドは漏れしか無く、その漏れは音量に比例するのに
  // 床は動かないので、+6dB で形が別物になった）。60dB 下のバンドは漏れと
  // 暗騒音で決まっており、音源が何かについて何も語っていない。
  const max = Math.max(...raw);
  if (!Number.isFinite(max)) return bandPowers.map(() => 0);
  const db = raw.map((v) => Math.max(v, max - SHAPE_FLOOR_DB));
  const mean = db.reduce((a, b) => a + b, 0) / db.length;
  return db.map((v) => v - mean);
}

/** 2つの形の距離[dB]。バンドごとの差の絶対値の平均 */
export function shapeDistanceDb(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(a[i] - b[i]);
  return sum / n;
}

// ==========================================================================
// 有音フレームの窓
// ==========================================================================

interface ActiveFrame {
  /** A特性パワー */
  power: number;
  /** 重み付け無し(Z特性)パワー */
  powerZ: number;
  /** オクターブバンドのパワー。形の比較に使う */
  bands: number[];
  /** 何フレーム目に取ったか。実時間での古さを見るため */
  at: number;
}

/**
 * 有音フレームだけを、決まった枚数まで保つ窓。
 *
 * `RingWindow` と分けたのは、**捨てる条件が2つある**ためである——枚数で溢れたら
 * 古いほうから捨て、実時間で古すぎるものも捨てる。後者があるので、この窓は
 * 「満たされている」状態から、何も足さなくても「満たされていない」状態に落ちる。
 * その落ちる瞬間が、画面が数値を保持に切り替える瞬間になる。
 */
class ActiveWindow {
  private items: ActiveFrame[] = [];

  push(frame: ActiveFrame): void {
    this.items.push(frame);
    if (this.items.length > ACTIVE_WINDOW_FRAMES) this.items.shift();
  }

  /** `now` から見て古すぎる有音フレームを落とす。毎フレーム呼ぶ */
  expire(now: number): void {
    const oldest = now - ACTIVE_MAX_SPAN_FRAMES;
    let drop = 0;
    while (drop < this.items.length && this.items[drop].at < oldest) drop++;
    if (drop > 0) this.items = this.items.slice(drop);
  }

  get length(): number { return this.items.length; }
  get full(): boolean { return this.items.length >= ACTIVE_WINDOW_FRAMES; }
  get powers(): number[] { return this.items.map((f) => f.power); }

  clear(): void { this.items = []; }

  meanPower(): number {
    if (this.items.length === 0) return 0;
    let s = 0;
    for (const f of this.items) s += f.power;
    return s / this.items.length;
  }

  meanPowerZ(): number {
    if (this.items.length === 0) return 0;
    let s = 0;
    for (const f of this.items) s += f.powerZ;
    return s / this.items.length;
  }

  /** 窓に入っている有音フレームの平均バンドパワー。形の比較に使う */
  meanBands(): number[] | null {
    if (this.items.length === 0) return null;
    const n = this.items[0].bands.length;
    const out = new Array<number>(n).fill(0);
    for (const f of this.items) for (let i = 0; i < n; i++) out[i] += f.bands[i];
    for (let i = 0; i < n; i++) out[i] /= this.items.length;
    return out;
  }
}

// ==========================================================================
// 基準
// ==========================================================================

/**
 * 測り終えた基準。
 *
 * **これを持つのは画面側である。** 中断から再開すると解析器は作り直されるが、
 * 基準は持ち越すのが約束なので、解析器の寿命に縛られる場所には置けない。
 * 解析器へは `adoptReference` で渡し直す。localStorage へ保存するのもこの形。
 */
export interface Reference {
  /** A特性の基準レベル[dBFS] */
  db: number;
  /** 同じ区間の重み付け無し(Z特性)の基準レベル[dBFS] */
  zDb: number;
  /** 同じ区間のスペクトルの形。違う音を測り始めたことに気づくため */
  shape: number[];
  /**
   * 測っている間にレベルが変わったか。**取り直すまで消えない。**
   *
   * 遡らないだけでは足りない——測っている最中に変われば混合した基準が焼き付く。
   * 窓が入れ替われば収束中の断りは消えるので、これが無いと確定した数値の顔で
   * 誤った差が出続ける。
   */
  unsettled: boolean;
}

/** 数値を出せない理由。画面はこれで文面を選ぶ */
export type BlockedBy =
  /** 有音フレームが足りない。間・休憩・無音 */
  | 'not-enough-speech'
  /** 基準を取ったときと違う音を測っている。拍手・BGM・映像 */
  | 'different-sound';

/** 保持している数値。声が足りない間、最後に十分な声で測れた差を出し続ける */
export interface HeldReading {
  diffDb: number;
  diffZDb: number | null;
  /** 測ってから何秒経ったか（実時間） */
  ageSec: number;
}

// ==========================================================================
// メーター
// ==========================================================================

export interface MeterState {
  /** 直近フレームのA特性レベル[dBFS]。バーを動かすための瞬時値 */
  instantDb: number;
  /**
   * 有音フレームの窓のA特性等価レベル[dBFS]。比較に使うのはこちら。
   * **無音は入っていない**ので、喋りの密度では動かない。
   */
  leqDb: number;
  /**
   * 同じ窓の等価レベル[dBFS]、**重み付け無し(Z特性)**。
   *
   * A特性の差と食い違ったときにだけ画面へ出す。差が正しいのは「全帯域が一律に
   * 動いたとき」だけで、低域だけを動かす操作では両者が離れる——実測で、120Hz以下に
   * +6dB のシェルフをかけたとき A特性は +1.01dB、Z特性は +2.45dB を示した。
   * A特性ひとつでは、その食い違いに気づけない。
   */
  leqZDb: number;
  /**
   * 直近 PEAK_HOLD_SEC の**サンプルピーク**[dBFS]。重み付け前の波形で取る。
   *
   * 100msのRMSではない。RMSの最大値だと波高を示さないうえ、A特性後では入力段の
   * 話にもならない——振り切った60Hzのサイン波(-0.01dBFS)が -30dBFS と表示される。
   * ピークを出す言い分は「校正と無関係に入力段が0に当たるかを示す」ことなので、
   * 当たるかどうかを見ている値でなければならない。
   */
  peakHoldDb: number;
  /**
   * 直近 CLIP_WINDOW_SEC のうち、音割れが含まれていた時間[秒]。
   *
   * 「回数」では数えられない。クリップした波形は半周期ごとに閾値を下回るので、
   * 閾値の再突入を数えると 1kHz の正弦波を3dB突っ込んだだけで10秒間に20000回になる。
   * かといって近接した突入をまとめて「1回」にすると、鳴りっぱなしのときに移動窓が
   * 始点を通り過ぎた時点で0に戻ってしまう。フレーム単位の時間で持てば、単発は
   * 0.1秒、鳴りっぱなしは 10.0秒 と素直に出る。
   */
  clipSeconds: number;
  /**
   * 直近 CLIP_WINDOW_SEC のうち、入力段が限界に近かった時間[秒]。
   * 割れてはいないが差が縮み始める領域（NEAR_CLIP_THRESHOLD 参照）。
   */
  nearClipSeconds: number;
  /** 有音フレームの窓が満たされたか。満たされていない間は数値を出さない */
  activeReady: boolean;
  /**
   * 窓が満たされるまでに足りない**声の秒数**。0 なら満たされている。
   *
   * **実時間ではない。** 壁時計に換算するには未来の喋りの密度を予測することになり、
   * 外れれば数字が動く。
   *
   * **この数字は増えることがある。** 間が `ACTIVE_MAX_SPAN_SEC` を超えて続くと、
   * 窓の古いほうから有音フレームが落ちていくので、足りない秒数は増えていく
   * （実測: 窓が満たされた状態から無音を流すと 0.0 → 0.7 → 3.2 → 5.4 → 7.7 →
   * 10.0秒 と伸びる）。これは会場で実際に起きていること——**さっきの声はもう
   * 古すぎて使えない**——をそのまま映しているので、止めたり latch したりしない。
   * 「0秒でよい」と言い続けて数値が出ないほうが質の悪い嘘になる。
   *
   * **`settlingRemainingSec` のほうは増えない。** あちらは「次の操作をしていいのは
   * いつか」を決めるために読まれる数字で、増えると読めなくなる。窓が満たされて
   * いる間しか出さないので、フレームが落ちた時点で 0 に戻る（増えない）。
   */
  activeRemainingSec: number;
  /** 更新されたフレーム数。テストと「まだ測っていない」の判定に使う */
  frames: number;
  /**
   * 窓の中で見つかった段差[dB]。0 なら窓は単一のレベルで満たされている。
   * 符号は「新しいほうが大きければ正」。
   *
   * **画面には出さない。** 変化量は基準との差が伝えており、段差量を並べても読む
   * 相手が増えるだけである。ここに置いてあるのは、検出が正しい大きさを見つけて
   * いるかをテストから確かめるため——`settlingRemainingSec` だけだと「たまたま何かを
   * 見つけた」と「+6dB を見つけた」が区別できない。
   */
  stepDb: number;
  /**
   * 段差の前の有音フレームが窓から出るまでの**声の秒数**。0 なら収束済み。
   *
   * **これが 0 でない間、leqDb は2つのレベルの混合である。** 移動窓の必然であって
   * 実装の不具合ではない——+6dB のフェーダー操作から声5秒ぶん後、窓の半分はまだ
   * 操作前なので、表示は理論値どおり +4.0dB になる。問題は、その +4.0 が収束済みの
   * +4.0 と見分けがつかないことのほうにある。
   *
   * **これも実時間ではない。** この数字は「次の操作をしていいのはいつか」を決める
   * ために読まれるので、壁時計と取り違えられるといちばん重い誤読になる。画面には
   * 「声があと N 秒ぶんで確定します」と書く。
   */
  settlingRemainingSec: number;

  /** 基準を測っている最中か */
  referenceCapturing: boolean;
  /** 基準が揃うまでに足りない**声の秒数** */
  referenceRemainingSec: number;
  /** いま解析器が持っている基準。測り終えた瞬間にここへ現れる */
  referenceResult: Reference | null;

  /**
   * いま出してよい差[dB]。出せないときは null。
   *
   * 出せるのは「基準がある かつ 有音フレームの窓が満たされている かつ 基準と同じ音を
   * 測っている」ときだけ。
   */
  diffDb: number | null;
  /** 同じ瞬間の重み付け無しの差。主役とは別物なので、食い違うときだけ画面に出す */
  diffZDb: number | null;
  /** 数値を出せない理由。出せているときは null */
  blockedBy: BlockedBy | null;
  /** 基準の形との距離[dB]。基準か窓が無ければ null */
  shapeDistanceDb: number | null;
  /**
   * 声が足りない間、最後に十分な声で測れた差。
   *
   * **凍らせるのは「声が消えた瞬間の値」ではない。** 声は瞬間的に消えるのではなく
   * 窓から抜けていくので、消えた瞬間の値は残り2〜3枚の有音フレームで計算された
   * **その回でいちばん当てにならない平均**である。窓が満たされている間ずっと更新し
   * 続け、満たされなくなった時点で更新を止めることで、保持される値は必ず「十分な声で
   * 測られた値」になる。
   */
  held: HeldReading | null;
}

/** 無音（完全な0）のときに返す下限。-Infinity を画面に出さないため */
export const FLOOR_DB = -120;

/**
 * 窓が単一のレベルで満たされるまでに、あと何フレーム古い側が出ればよいかを返す。
 *
 * **「最も margin の大きい段差を1つ選ぶ」ではなく「残りが均一になる位置を探す」。**
 * 前者だと窓に段差が2つあるとき、古くて大きいほうが勝つので**残り秒数が巻き戻る**。
 * 実測では +6dB(t=12s) → -2dB(t=15s) で、カウントダウンが 0.2秒 まで進んだ直後に
 * 3.1秒 へ跳ね上がった。読む相手はカウントダウンを見て次の操作の可否を決めるので、
 * 操作していないのに増える数字は使えない。
 *
 * そこで先頭を1フレームずつ削りながら段差を探し直し、**最後に見つかった段差の
 * 位置**を答えとする。古い段差は削られて消えるので、残るのは最も新しい段差である。
 * 段差が1つなら従来と同じ位置を返す。新しい操作をしたときだけ残り秒数が増える
 * （それは正しい挙動）。
 *
 * 分割点は両端 STEP_MIN_FRAMES フレーム(0.2秒)には置けないので、**操作の直後と
 * 直前だけは位置が端に張り付く**。そのぶん残り秒数は 0.2〜9.8秒の範囲に収まり、
 * 真値が 9.8秒を超える最初の0.2秒間は動かない。
 *
 * **上げてから戻す操作には限界がある。** 粗く動かして行き過ぎに気づき戻す——現場の
 * 普通の手順だが、そのとき窓は3レベルの混合になり、山が中ほどにある間はどの単一
 * 分割でも前後がどちらも混合なので閾値を超えない。この走査でも捕まらない。
 * 見逃す量は実測で STEP_DB の水準に収まる（山の高さ・保持時間を振った測定）:
 *
 *   山の高さ | 見逃す時間 | そのときの表示誤差
 *   1.5dB    | 最大 11.1秒 | 最大 1.10dB
 *   2dB      | 最大  4.7秒 | 最大 1.12dB
 *   3dB      | 最大  0.1秒 | 最大 0.04dB
 *   4dB以上  |       0.0秒 |      0.00dB
 *
 * **3dB 以上の山は捕まえられるので、残るのは「宣言した分解能(STEP_DB=1.5dB)と
 * 同じ大きさの山」だけ**である。それ以上を捕まえるには STEP_DB を下げるしかなく、
 * それは誤検出（操作していないのに「収束中」）と直接取り引きになる。下げるなら
 * 実素材で誤検出率を測り直してからにすること。
 *
 * 「フェーダーが動いたか」は分からない。分かるのは**声10秒ぶん前と今でレベルが
 * 違うこと**だけで、それがこの表示に必要な全部である。
 */
function detectStep(powers: readonly number[]): { stepDb: number; oldFrames: number } {
  const n = powers.length;
  if (n < STEP_MIN_FRAMES * 2) return { stepDb: 0, oldFrames: 0 };

  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + powers[i];

  /** [from, at) と [at, n) のパワー平均の比[dB]。どちらかが無音なら null */
  const gapDb = (from: number, at: number): number | null => {
    const older = (prefix[at] - prefix[from]) / (at - from);
    const newer = (prefix[n] - prefix[at]) / (n - at);
    if (older <= 0 || newer <= 0) return null;
    return 10 * Math.log10(newer / older);
  };

  /**
   * [from, n) の中でいちばんはっきりした段差の位置。無ければ null。
   *
   * 分割ごとに要求する段差量が違うので、**閾値をどれだけ上回ったか**で選ぶ。
   * 絶対値で選ぶと、短くて当てにならない区間の大きな値が常に勝つ。素材の自然な
   * 揺れを段差と呼ぶと「収束中」が消えなくなって注意書きとして機能しなくなるので、
   * 閾値を超えたものだけを段差と呼ぶ。
   */
  const stepIn = (from: number): number | null => {
    let bestMargin = 0;
    let bestSplit = -1;
    for (let i = from + STEP_MIN_FRAMES; i <= n - STEP_MIN_FRAMES; i++) {
      const db = gapDb(from, i);
      if (db === null) continue;
      const margin = Math.abs(db) - stepThresholdDb(Math.min(i - from, n - i));
      if (margin > bestMargin) { bestMargin = margin; bestSplit = i; }
    }
    return bestSplit < 0 ? null : bestSplit;
  };

  // 先頭を1フレームずつ削り、段差が見つからなくなるまで進む。答えは
  // **最後に見つかった段差の位置**——古い段差は削られて消えるので、
  // 残るのは最も新しい段差である。短い区間には分割点を置けないので必ず終わる。
  let newestSplit = 0;
  for (let from = 0; from < n; from++) {
    const at = stepIn(from);
    if (at === null) break;
    newestSplit = at;
  }
  if (newestSplit === 0) return { stepDb: 0, oldFrames: 0 };

  return { stepDb: gapDb(0, newestSplit) ?? 0, oldFrames: newestSplit };
}

/**
 * 流れてくるPCMを受け取り、100msごとに測定値を更新する。
 *
 * 設計上の要点は2つ。「バーは瞬時値、比較は平均」——PAから流れる音楽や話し声は
 * 瞬間ごとに10dB以上揺れるので、瞬時値どうしを引き算してもフェーダーを何dB
 * 動かせばよいか決まらない。そして「平均するのは声だけ」——無音を混ぜると平均が
 * 喋りの密度で動く。
 */
export class VolumeMeter {
  private readonly filter: AWeightingFilter;
  private readonly framer: FrameSplitter;

  /** フレーム未満の端数。波形そのものは要らないので二乗和だけ持つ */
  private pendingSum = 0;
  private pendingSumZ = 0;
  /** フレーム内のサンプルピーク（重み付け前）。割れ・限界・波高を1回の走査で賄う */
  private pendingPeak = 0;

  /** 有音フレームだけの窓。Leq と段差はここから出す */
  private readonly active = new ActiveWindow();
  /** ゲートの閾値を決めるための、全フレームのA特性レベル[dBFS]の履歴 */
  private readonly gateHistory: RingWindow;
  /** フレームごとのサンプルピーク（振幅）。ピークホールドの窓 */
  private readonly peaks: RingWindow;
  /** フレームごとに、そのフレームが音割れを含んでいたか（1/0）。クリップの窓 */
  private readonly clips: RingWindow;
  /** 同上、入力段が限界に近かったか（1/0） */
  private readonly nearClips: RingWindow;

  /** 形を測るための生波形。FFT長ぶんだけ持つ */
  private readonly shapeRing = new SampleRing(SHAPE_FFT_SIZE);
  private readonly shapeWindow = blackmanHarrisWindow(SHAPE_FFT_SIZE);
  private readonly shapeSamples = new Float32Array(SHAPE_FFT_SIZE);
  private readonly shapeRe = new Float32Array(SHAPE_FFT_SIZE);
  private readonly shapeIm = new Float32Array(SHAPE_FFT_SIZE);
  /** バンドごとの [開始ビン, 終了ビン)。サンプルレートが決まれば固定 */
  private readonly bandBins: Array<[number, number]>;

  private lastInstantDb = FLOOR_DB;
  private frames = 0;

  /** 画面から渡された基準。解析器はこれを写しで持つだけで、寿命を持たない */
  private reference: Reference | null = null;

  /** 基準の測定。`refCapturing` が false なら測っていない */
  private refCapturing = false;
  private refPowers: number[] = [];
  private refPowersZ: number[] = [];
  private refBands: number[][] = [];
  /** 基準に積んだ有音フレームを何フレーム目に取ったか。古すぎるものを落とすため */
  private refAt: number[] = [];

  /** 保持している差。窓が満たされている間ずっと更新し、満たされなくなったら止める */
  private heldDiffDb: number | null = null;
  private heldDiffZDb: number | null = null;
  private heldAtFrame = 0;
  /** 保持を始めた時点の有音窓のレベル[dBFS]。保持中に段差が来たかを見る */
  private heldLeqDb = FLOOR_DB;
  /** 保持を始めた後に届いた有音フレームのパワー。これと比べて段差を見る */
  private postHoldPowers: number[] = [];

  constructor(sampleRate: number) {
    this.filter = new AWeightingFilter(sampleRate);
    this.framer = new FrameSplitter((sampleRate * FRAME_MS) / 1000);
    this.gateHistory = new RingWindow((GATE_HISTORY_SEC * 1000) / FRAME_MS);
    this.peaks     = new RingWindow((PEAK_HOLD_SEC * 1000) / FRAME_MS);
    this.clips     = new RingWindow((CLIP_WINDOW_SEC * 1000) / FRAME_MS);
    this.nearClips = new RingWindow((CLIP_WINDOW_SEC * 1000) / FRAME_MS);

    const binHz = sampleRate / SHAPE_FFT_SIZE;
    const half  = SHAPE_FFT_SIZE >> 1;
    this.bandBins = SHAPE_BANDS_HZ.map((center) => {
      const lo = Math.max(1, Math.floor((center * Math.SQRT1_2) / binHz));
      const hi = Math.min(half, Math.ceil((center * Math.SQRT2) / binHz));
      return [lo, Math.max(lo + 1, hi)] as [number, number];
    });
  }

  /**
   * 画面が持っている基準を渡す。中断からの再開・localStorage からの復元で使う。
   *
   * 解析器は中断のたびに作り直されるので、基準の所有者にはなれない。ここが持つのは
   * 差を計算するための写しだけである。
   */
  adoptReference(reference: Reference | null): void {
    this.reference = reference;
    this.heldDiffDb = null;
    this.heldDiffZDb = null;
  }

  /**
   * 基準の測定を始める。ここから**有音フレームが `ACTIVE_WINDOW_SEC` 秒ぶん**
   * たまるまで平均する。壁時計では何秒かかるか分からない。
   *
   * **遡らないのが要点。** 「基準にする」は「いまの音を憶えておけ」という意思表示で
   * あって、「さっきまでの音を憶えておけ」ではない。遡って測ると、押す前に起きた
   * レベル変化——客席へ歩く、演目が変わる——が基準に混ざり、**フェーダーに触れて
   * いないのに差が出る**。
   */
  beginReference(): void {
    this.refCapturing = true;
    this.refPowers = [];
    this.refPowersZ = [];
    this.refBands = [];
    this.refAt = [];
    this.reference = null;
    this.heldDiffDb = null;
    this.heldDiffZDb = null;
  }

  /** 基準を捨てる。測定中なら中止する */
  clearReference(): void {
    this.refCapturing = false;
    this.refPowers = [];
    this.refPowersZ = [];
    this.refBands = [];
    this.refAt = [];
    this.reference = null;
    this.heldDiffDb = null;
    this.heldDiffZDb = null;
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
      // 形は生波形から取る。音源が何かの話なので、聞こえ方の重み付けは要らない
      this.shapeRing.write(chunk, offset, length);

      if (completed) this.commitFrame();
    });
  }

  /**
   * このフレームが有音か。**履歴のp95から `ACTIVE_RANGE_DB` 下までを有音とする。**
   *
   * 完全な無音（デジタルの0）だけは、履歴もろとも下限に張り付くので明示的に外す。
   * それ以外に絶対的な下限は置かない——会場の暗騒音がどのレベルに来るかはマイクの
   * 感度次第で、この道具はそれを知らない。
   */
  private isActive(levelDb: number): boolean {
    if (levelDb <= FLOOR_DB) return false;
    const threshold = gateThresholdDb(
      this.gateHistory.values, ACTIVE_RANGE_DB, this.reference?.db ?? null,
    );
    return threshold === null || levelDb >= threshold;
  }

  /** 直近 SHAPE_FFT_SIZE サンプルのオクターブバンドパワー */
  private currentBands(): number[] {
    const out = new Array<number>(this.bandBins.length).fill(0);
    if (this.shapeRing.filled < SHAPE_FFT_SIZE) return out;

    this.shapeRing.readInto(this.shapeSamples);
    for (let i = 0; i < SHAPE_FFT_SIZE; i++) {
      this.shapeRe[i] = this.shapeSamples[i] * this.shapeWindow[i];
      this.shapeIm[i] = 0;
    }
    fft(this.shapeRe, this.shapeIm);

    for (let b = 0; b < this.bandBins.length; b++) {
      const [lo, hi] = this.bandBins[b];
      let sum = 0;
      for (let k = lo; k < hi; k++) {
        sum += this.shapeRe[k] * this.shapeRe[k] + this.shapeIm[k] * this.shapeIm[k];
      }
      out[b] = sum / (hi - lo);
    }
    return out;
  }

  private commitFrame(): void {
    const power  = this.pendingSum  / this.framer.frameSize;
    const powerZ = this.pendingSumZ / this.framer.frameSize;
    const levelDb = power > 0 ? dbfs(Math.sqrt(power)) : FLOOR_DB;

    const active = this.isActive(levelDb);
    this.gateHistory.push(levelDb);

    if (active) {
      const bands = this.currentBands();
      this.active.push({ power, powerZ, bands, at: this.frames });
      if (this.heldDiffDb !== null) {
        this.postHoldPowers.push(power);
        if (this.postHoldPowers.length > POST_HOLD_FRAMES) this.postHoldPowers.shift();
      }

      // 基準も有音フレームだけを数える。壁時計で10秒ではなく、声で10秒
      if (this.refCapturing) {
        this.refPowers.push(power);
        this.refPowersZ.push(powerZ);
        this.refBands.push(bands);
        this.refAt.push(this.frames);
        if (this.refPowers.length >= ACTIVE_WINDOW_FRAMES) this.finishReference();
      }
    }
    this.active.expire(this.frames);
    if (this.refCapturing) this.expireReferenceFrames();

    this.peaks.push(this.pendingPeak);
    this.clips.push(this.pendingPeak >= CLIP_THRESHOLD ? 1 : 0);
    this.nearClips.push(this.pendingPeak >= NEAR_CLIP_THRESHOLD ? 1 : 0);
    this.lastInstantDb = levelDb;

    this.pendingSum = 0;
    this.pendingSumZ = 0;
    this.pendingPeak = 0;
    this.frames++;

    this.updateHold();
  }

  /**
   * 基準に積んだフレームのうち、実時間で古すぎるものを落とす。
   *
   * **比較側と同じ上限（`ACTIVE_MAX_SPAN_SEC`）を基準側にもかける。** これが無いと、
   * 喋りが疎な会場で100枚たまるまでに何分もかかり、**その間に会場が何度変わっても
   * 一本の基準として焼き付く**。段差検出が拾えるのは持続した1回の変化だけなので、
   * じわじわ動いた分はそのまま通ってしまう。設計文書が比較側で拒否している
   * 「実時間の何分にもまたがった平均」を、基準側だけ許す理由が無い。
   *
   * 落とした結果、残り秒数は増える（`activeRemainingSec` と同じ理屈）。会場が
   * 上限より疎ならカウントダウンは進まなくなるが、**進まないことが画面に出る**
   * ぶん、黙って数分の平均を基準にするより良い。
   */
  private expireReferenceFrames(): void {
    const oldest = this.frames - ACTIVE_MAX_SPAN_FRAMES;
    let drop = 0;
    while (drop < this.refAt.length && this.refAt[drop] < oldest) drop++;
    if (drop === 0) return;
    this.refPowers  = this.refPowers.slice(drop);
    this.refPowersZ = this.refPowersZ.slice(drop);
    this.refBands   = this.refBands.slice(drop);
    this.refAt      = this.refAt.slice(drop);
  }

  private finishReference(): void {
    const mean  = this.refPowers.reduce((a, b) => a + b, 0)  / this.refPowers.length;
    const meanZ = this.refPowersZ.reduce((a, b) => a + b, 0) / this.refPowersZ.length;

    const nBands = this.refBands[0].length;
    const bands = new Array<number>(nBands).fill(0);
    for (const b of this.refBands) for (let i = 0; i < nBands; i++) bands[i] += b[i];
    for (let i = 0; i < nBands; i++) bands[i] /= this.refBands.length;

    this.reference = {
      db:  mean  > 0 ? dbfs(Math.sqrt(mean))  : FLOOR_DB,
      zDb: meanZ > 0 ? dbfs(Math.sqrt(meanZ)) : FLOOR_DB,
      shape: shapeOf(bands),
      // 測ったフレームそのものに段差があれば、この基準は2つのレベルの混合である
      unsettled: detectStep(this.refPowers).stepDb !== 0,
    };
    this.refCapturing = false;
    this.refPowers = [];
    this.refPowersZ = [];
    this.refBands = [];
    this.refAt = [];
    this.heldDiffDb = null;
    this.heldDiffZDb = null;
  }

  /**
   * 保持する値の更新。
   *
   * 窓が満たされ、基準と同じ音を測っている間は毎フレーム更新する。そうでなくなった
   * 時点で更新を止め、**そこから先はその値を経過秒つきで出す**。凍結点を後から
   * 探さないので、保持される値は必ず「十分な声で測られた値」になる。
   *
   * **保持中に有音のレベルが段差ぶん動いたら捨てる。** 時間では消さない
   * （ハウリングチェックが鳴き終わった周波数を残すのと同じ理由——画面を開いた理由
   * そのものが消える）が、こちらが残しているのはフェーダーの位置に依存する差で
   * あり、動かされた瞬間に嘘になる。声が無くても、拍手や BGM のようにゲートを通る音が
   * あればレベルの変化は見える。**間の最中に動かされた場合は見えない**——そのときは
   * 声が戻った時点で段差として検出され、保持は捨てられる。
   */
  private updateHold(): void {
    const diff = this.liveDiff();
    if (diff !== null) {
      this.heldDiffDb  = diff.diffDb;
      this.heldDiffZDb = diff.diffZDb;
      this.heldAtFrame = this.frames;
      this.heldLeqDb   = this.activeLeqDb();
      this.postHoldPowers = [];
      return;
    }
    if (this.heldDiffDb === null) return;

    // **比べるのは「保持を始めた後に届いた有音フレーム」だけである。**
    // いま窓に入っているものと比べると、窓が痩せていく途中で中身が入れ替わり、
    // レベルが動いていなくても差が出る（実装したら、間が続くだけで保持が
    // 消えるようになった）。届いた側だけを見れば、それは起きない。
    if (this.postHoldPowers.length < POST_HOLD_MIN_FRAMES) return;
    const mean = this.postHoldPowers.reduce((a, b) => a + b, 0) / this.postHoldPowers.length;
    const now = mean > 0 ? dbfs(Math.sqrt(mean)) : FLOOR_DB;
    if (now > FLOOR_DB && this.heldLeqDb > FLOOR_DB
        && Math.abs(now - this.heldLeqDb) >= STEP_DB) {
      this.heldDiffDb = null;
      this.heldDiffZDb = null;
    }
  }

  private activeLeqDb(): number {
    const m = this.active.meanPower();
    return m > 0 ? dbfs(Math.sqrt(m)) : FLOOR_DB;
  }

  /** いま差を出してよいか。出してよければ差を返す */
  private liveDiff(): { diffDb: number; diffZDb: number | null } | null {
    if (this.reference === null || !this.active.full) return null;
    const distance = this.shapeDistance();
    if (distance !== null && distance >= SHAPE_DISTANCE_DB) return null;

    const meanZ = this.active.meanPowerZ();
    const leqZ  = meanZ > 0 ? dbfs(Math.sqrt(meanZ)) : FLOOR_DB;
    return {
      diffDb:  this.activeLeqDb() - this.reference.db,
      diffZDb: leqZ - this.reference.zDb,
    };
  }

  private shapeDistance(): number | null {
    if (this.reference === null) return null;
    const bands = this.active.meanBands();
    if (bands === null) return null;
    return shapeDistanceDb(shapeOf(bands), this.reference.shape);
  }

  get state(): MeterState {
    const peak = this.peaks.max();
    const meanPower  = this.active.meanPower();
    const meanPowerZ = this.active.meanPowerZ();

    // 窓が満たされる前は「あと何秒で収束するか」を言えない（そもそも全体が
    // 収束前である）。満たされてから初めて段差を探す
    const step = this.active.full
      ? detectStep(this.active.powers)
      : { stepDb: 0, oldFrames: 0 };

    const live = this.liveDiff();
    const distance = this.shapeDistance();
    const blockedBy: BlockedBy | null =
      live !== null || this.reference === null ? null
      : distance !== null && distance >= SHAPE_DISTANCE_DB ? 'different-sound'
      : 'not-enough-speech';

    return {
      instantDb:  this.lastInstantDb,
      leqDb:      meanPower  > 0 ? dbfs(Math.sqrt(meanPower))  : FLOOR_DB,
      leqZDb:     meanPowerZ > 0 ? dbfs(Math.sqrt(meanPowerZ)) : FLOOR_DB,
      peakHoldDb: peak > 0 ? dbfs(peak) : FLOOR_DB,
      clipSeconds:     (this.clips.count((c) => c === 1) * FRAME_MS) / 1000,
      nearClipSeconds: (this.nearClips.count((c) => c === 1) * FRAME_MS) / 1000,
      activeReady: this.active.full,
      activeRemainingSec:
        Math.max(0, (ACTIVE_WINDOW_FRAMES - this.active.length) * FRAME_MS) / 1000,
      frames:     this.frames,
      stepDb: step.stepDb,
      settlingRemainingSec: (step.oldFrames * FRAME_MS) / 1000,

      referenceCapturing: this.refCapturing,
      referenceRemainingSec: this.refCapturing
        ? ((ACTIVE_WINDOW_FRAMES - this.refPowers.length) * FRAME_MS) / 1000
        : 0,
      referenceResult: this.reference,

      diffDb:  live?.diffDb  ?? null,
      diffZDb: live?.diffZDb ?? null,
      blockedBy,
      shapeDistanceDb: distance,
      held: live === null && this.heldDiffDb !== null
        ? {
            diffDb:  this.heldDiffDb,
            diffZDb: this.heldDiffZDb,
            ageSec:  ((this.frames - this.heldAtFrame) * FRAME_MS) / 1000,
          }
        : null,
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
