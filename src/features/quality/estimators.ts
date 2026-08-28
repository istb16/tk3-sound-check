/**
 * 物理量の推定。
 *
 * スコア（点数）ではなく物理量を返す。点数だと推定誤差を測れないため、
 * 「SNRは何dBか」「RT60は何秒か」を返して真値と直接比べられるようにする。
 * 採点は AudioAnalyzer 側の責務。
 *
 * DOM非依存。Node からそのまま呼べること。
 */

import {
  clamp, dbfs, frameRmsList, linearFit, linearRegression, movingAverage, percentile,
  powerDb, rms, stdev,
} from '../../lib/dsp/stats.ts';
import {
  ACTIVITY_RANGE_DB, FFT_SIZE, activePowerSpectrum, bandPowers,
} from '../../lib/dsp/spectrum.ts';

/** 解析に使うフレーム長[秒] */
const FRAME_SEC = 0.02;
/** クリッピングと見なす振幅の絶対値 */
const CLIP_THRESHOLD = 0.98;
/** クリップ率の分母に数える「音が鳴っている」サンプルの下限 */
const CLIP_ACTIVE_THRESHOLD = 0.01;

/** 1次元2-meansの反復回数 */
const VAD_ITERATIONS = 20;
/** 下側の群がこの割合未満なら無音区間として信用しない */
const VAD_MIN_LOWER_RATIO = 0.05;
/** 下側の群がこの割合を超えたら、発話のほうが少数派で分割を信用できない */
const VAD_MAX_LOWER_RATIO = 0.9;
/** 2群の中心がこれ以上離れていなければ分離できたとみなさない[dB] */
const VAD_MIN_GAP_DB = 6;
/** ノイズは定常。下側の群のばらつきがこれを超えたら「小さな声」であってノイズではない[dB] */
const VAD_MAX_NOISE_STDEV_DB = 5;

/**
 * 無音フレームが取れないときにノイズフロアとして使うパーセンタイル。
 * 実測の走査(p2〜p35)で全体MAEが最小になる位置。詳細は estimateSnr 内の注記。
 */
const NOISE_FLOOR_FALLBACK_PERCENTILE = 0.20;

/**
 * ノイズパワーの推定に最低限必要なフレーム数（20msフレームで0.3秒ぶん）。
 * これを下回ると推定値が不安定になり、実測でSNRを +13dB 過大評価していた。
 */
const MIN_NOISE_FRAMES = 15;

function frameSizeFor(sampleRate: number): number {
  return Math.max(1, Math.floor(sampleRate * FRAME_SEC));
}

// ==========================================================================
// レベル
// ==========================================================================

export interface LevelEstimate {
  /** 全体のRMS[dBFS] */
  overallDbfs: number;
  /** 有効音声レベル[dBFS]。ITU-T P.56 の考え方で無音を除く。分離できなければ null */
  activeSpeechDbfs: number | null;
}

/**
 * レベルの推定。
 *
 * 全体RMSではなく有効音声レベル（発話しているフレームだけのRMS）を主に使う。
 * 全体RMSには無音が含まれるので、間の多い録音ほど音量が小さいと誤判定される。
 */
export function estimateLevel(data: Float32Array, sampleRate: number): LevelEstimate {
  const overallDbfs = dbfs(rms(data, 0, data.length));
  const frames = frameRmsList(data, frameSizeFor(sampleRate));
  if (frames.length === 0) return { overallDbfs, activeSpeechDbfs: null };

  const threshold = percentile(frames, 0.95) * Math.pow(10, -ACTIVITY_RANGE_DB / 20);
  let sum = 0;
  let n = 0;
  for (const f of frames) {
    if (f >= threshold) { sum += f * f; n++; }
  }
  return {
    overallDbfs,
    activeSpeechDbfs: n === 0 ? null : dbfs(Math.sqrt(sum / n)),
  };
}

// ==========================================================================
// SNR
// ==========================================================================

export interface SnrEstimate {
  snrDb: number | null;
  noiseFloorRms: number;
  speechRms: number;
  /** 無音と判定されたフレームの割合。null なら推定できていない */
  silenceRatio: number | null;
  /** ノイズパワーの推定に使えたフレーム数。0 なら代替手段に落ちている */
  noiseFrames: number;
}

/**
 * SNRの推定。
 *
 * 旧実装は「上位85パーセンタイルのフレームRMS ÷ 下位10パーセンタイル」だった。
 * これは実測で +2.66dB の系統的な楽観バイアスを持ち、最悪ケースでは
 * SNR 0dB を 5.6dB と読んでいた（validation/report.md の snr 条件）。原因は2つ。
 *
 *  1. 分子の p85 は有音区間の平均レベルより数dB高い。
 *  2. 有音区間の観測値は「発話 + ノイズ」の合成であり、SNR 0dB では
 *     発話単体より 3dB 高くなる。差し引いていなかった。
 *
 * ここでは有音／無音をレベル閾値で分け、無音区間のパワーをノイズパワーとして
 * 有音区間から差し引く。定義を注入時の真値と揃えたうえで、混合の影響を補正する。
 *
 * rt60Sec を渡すと、発話終了から残響が減衰しきるまでのフレームをノイズフロアの
 * 推定から除外する。残響エネルギーは信号由来であり背景雑音ではないので、これを
 * 含めると残響の長い部屋がノイズ軸でも二重に減点される（実測で rt60 と noise
 * スコアの相関が -0.889 まで出ていた）。
 */
export function estimateSnr(
  data: Float32Array,
  sampleRate: number,
  rt60Sec?: number | null,
): SnrEstimate {
  const frameSize = frameSizeFor(sampleRate);
  const frames = frameRmsList(data, frameSize);
  const empty = { snrDb: null, noiseFloorRms: 0, speechRms: 0, silenceRatio: null, noiseFrames: 0 };

  if (frames.length < 4) return empty;

  const active = splitActive(frames);

  // 残響が減衰しきるまでのフレームはノイズフロアの推定から除外する。
  //
  // ただしガードを厳格に適用すると、間の短い話者では無音がほぼ全部消える。
  // 実測では残る無音が3〜4フレームまで枯渇し、ノイズパワーの推定が不安定になって
  // SNRを +13dB 過大評価していた。測れる量が確保できるまでガードを縮める。
  //
  // 「無音のうち最も静かなN個を使う」方式も試したが、無音フレームの分布に
  // 長い下裾があるため選択バイアスが大きく、同じく +13dB の過大評価になった。
  // ガードを縮めるほうが実測で明確に良い（最大誤差 13.1dB → 4.3dB）。
  let guardFrames = rt60Sec == null
    ? 0
    : Math.round(clamp(rt60Sec, 0, 2) / (frameSize / sampleRate));
  let usableForNoise = markUsableForNoise(active, guardFrames);
  while (guardFrames > 0 && countTrue(usableForNoise) < MIN_NOISE_FRAMES) {
    guardFrames = Math.floor(guardFrames / 2);
    usableForNoise = markUsableForNoise(active, guardFrames);
  }

  // ガードを 0 まで縮めても下限に届かないことがある——間を置かずに喋る話者、
  // あるいは残響が測れずガードが最初から 0 の録音。
  //
  // **下限の判定がガードの縮小ループの中にしか無いのは欠陥だった。** while の条件が
  // `guardFrames > 0` なので、ガードが無い経路では無音1フレームでもそのまま
  // ノイズパワーの推定に使われる。少数フレームの推定は楽観方向に外れる
  // （静かな瞬間を引きやすい）ので、**黙って「そこまで悪くない」と言う経路**になる。
  //
  // 下限に届かないときは、少数フレームを使うより下のパーセンタイル代替に落とす。
  // そちらは実測で較正してある（NOISE_FLOOR_FALLBACK_PERCENTILE の注記）。
  //
  // **この行は現在の検証セットでは一度も発動しない。** 間を間引いた条件(pauses)でも
  // 無音と判定されるフレームは100件以上残る。公開コーパスは発話を連結して素材に
  // しているので、そもそも間が多い。守りとして置くが、**実測で確かめた修正ではない。**
  if (countTrue(usableForNoise) < MIN_NOISE_FRAMES) usableForNoise = usableForNoise.map(() => false);

  let activePower = 0, activeCount = 0;
  let noisePower = 0, noiseCount = 0;
  for (let i = 0; i < frames.length; i++) {
    const p = frames[i] * frames[i];
    if (active[i]) { activePower += p; activeCount++; }
    else if (usableForNoise[i]) { noisePower += p; noiseCount++; }
  }

  if (activeCount === 0) return empty;

  // 無音フレームが1つも取れなかった場合の代替。
  //
  // これに落ちるのはSNRが極端に低いとき——発話と無音のレベル差が数dBしか無く、
  // 2群に分離できず、固定閾値(p95-25dB)も分布の下端に届かない領域。
  // 実測ではSNR 0dBの全16条件がここに落ちた。
  //
  // 以前は第2パーセンタイルを使っていたが、これは標本の最小値に近いので
  // 系統的に低く出る。実測でノイズパワーを -1.52dB 過小評価し、SNRを
  // +1.53dB 楽観的に読んでいた（一番騒がしい録音を「そこまで悪くない」と
  // 言う方向の誤り）。
  //
  // この領域ではほぼ全フレームが雑音支配なので、下端の極値ではなく分布の
  // 下寄りの水準を取るほうが素直。実測のパーセンタイル走査(p2〜p35)では
  // p20 が全体MAE最小（1.665→1.539dB）で、SNR 0dB の誤差が
  // +1.53 → -0.46dB（楽観から安全側）になった。
  //
  // 「2群の間隔の閾値(VAD_MIN_GAP_DB)を緩めて実際の無音フレームを使う」ほうが
  // 筋は良いはずだが、実測では悪化した（6→3.5でバイアス 0.956→1.093）。
  // 分離を通すと有音側が大きい声に偏り、分子が余計に膨らむため。棄却済み。
  const noiseMeanPower = noiseCount > 0
    ? noisePower / noiseCount
    : Math.pow(percentile(frames, NOISE_FLOOR_FALLBACK_PERCENTILE), 2);

  // 有音区間の観測パワーは「発話 + ノイズ」。ノイズ分を差し引く。
  const speechPower = Math.max(activePower / activeCount - noiseMeanPower, 1e-20);
  const silenceFrames = active.filter((a) => !a).length;

  return {
    snrDb: 10 * Math.log10(speechPower / (noiseMeanPower + 1e-20)),
    noiseFloorRms: Math.sqrt(noiseMeanPower) + 1e-9,
    speechRms: Math.sqrt(speechPower),
    silenceRatio: silenceFrames / frames.length,
    noiseFrames: noiseCount,
  };
}

/**
 * ノイズフロアの推定に使えるフレームに印を付ける。
 * 有音フレームの直後 guardFrames 分は残響が残っているため除外する。
 */
function markUsableForNoise(active: boolean[], guardFrames: number): boolean[] {
  const usable = active.map((a) => !a);
  if (guardFrames <= 0) return usable;
  for (let i = 0; i < active.length; i++) {
    if (!active[i]) continue;
    for (let j = i + 1; j <= i + guardFrames && j < active.length; j++) usable[j] = false;
  }
  return usable;
}

function countTrue(flags: boolean[]): number {
  let n = 0;
  for (const f of flags) if (f) n++;
  return n;
}

// ==========================================================================
// 有音／無音の分離
// ==========================================================================

/**
 * フレームレベルを1次元 2-means で有音／無音に分ける。
 *
 * 固定閾値（ピークから25dB下）だけでは、SNRが25dBを下回ると無音フレームを
 * 1つも分離できなくなる。分布が二峰であればその谷で切るほうが素直。
 * 二峰に分かれない（=無音区間が無い）場合は固定閾値に戻す。
 */
function splitActive(frames: number[]): boolean[] {
  const levels = frames.map(dbfs);

  // ---- 1次元 2-means ----
  let lo = Math.min(...levels);
  let hi = Math.max(...levels);
  for (let iter = 0; iter < VAD_ITERATIONS; iter++) {
    const mid = (lo + hi) / 2;
    let sLo = 0, nLo = 0, sHi = 0, nHi = 0;
    for (const v of levels) {
      if (v < mid) { sLo += v; nLo++; } else { sHi += v; nHi++; }
    }
    if (nLo === 0 || nHi === 0) break;
    const nextLo = sLo / nLo;
    const nextHi = sHi / nHi;
    if (Math.abs(nextLo - lo) < 0.01 && Math.abs(nextHi - hi) < 0.01) {
      lo = nextLo; hi = nextHi;
      break;
    }
    lo = nextLo; hi = nextHi;
  }

  const mid = (lo + hi) / 2;
  const lower = levels.filter((v) => v < mid);

  const separated =
    lower.length >= levels.length * VAD_MIN_LOWER_RATIO &&
    lower.length <= levels.length * VAD_MAX_LOWER_RATIO &&
    hi - lo >= VAD_MIN_GAP_DB &&
    stdev(lower) <= VAD_MAX_NOISE_STDEV_DB;

  // 「分離できたか」を信頼性の指標として外に出すことを試み、棄却した。
  // 検証セットで測ると**クリーンな素材の100%が「分離できず」**になる（劣化なし・
  // 残響・帯域制限・レベルの条件はいずれも 100%、定常ノイズでも 39%）。
  // 静かな録音では無音区間のばらつきが大きく、2群の間隔もこの閾値に届かないため。
  // これを参考値の根拠にすると、ほとんどの録音に「参考値」バッジが付く。
  // **空振りは見落としより重い**ので採らない。下の固定閾値は例外処理ではなく主経路である。
  if (separated) return levels.map((v) => v >= mid);

  // 二峰に分かれない = 無音区間が無い。固定閾値に戻す。
  const fallback = percentile(levels, 0.95) - ACTIVITY_RANGE_DB;
  return levels.map((v) => v >= fallback);
}

/**
 * 有音／無音の分離結果を外に出す（検証基盤が真値の計算に使う）。
 *
 * 真値の側で別の定義（固定パーセンタイル）を使うと、推定器が正しいのに
 * 誤差があるように見える。定義を共有する。
 */
export function separateActiveFrames(frames: number[]): boolean[] {
  return splitActive(frames);
}

// ==========================================================================
// クリッピング
// ==========================================================================

export interface ClipEstimate {
  /** 有音サンプルに対するクリップ率。有音サンプルが無い場合は null */
  clipRate: number | null;
  clippedCount: number;
  activeCount: number;
  /** 連続してクリップした最長のサンプル数。バースト歪みの指標 */
  longestRunSamples: number;
}

/**
 * クリッピングの推定。
 *
 * 分母は全サンプルではなく「音が鳴っているサンプル」。全サンプルを分母にすると
 * 無音の多い録音ほどクリップ率が低く出る。
 */
export function estimateClipping(data: Float32Array): ClipEstimate {
  let clippedCount = 0;
  let activeCount = 0;
  let longestRunSamples = 0;
  let run = 0;

  for (let i = 0; i < data.length; i++) {
    const a = Math.abs(data[i]);
    if (a > CLIP_ACTIVE_THRESHOLD) activeCount++;
    if (a >= CLIP_THRESHOLD) {
      clippedCount++;
      run++;
      if (run > longestRunSamples) longestRunSamples = run;
    } else {
      run = 0;
    }
  }

  return {
    clipRate: activeCount === 0 ? null : clippedCount / activeCount,
    clippedCount,
    activeCount,
    longestRunSamples,
  };
}

// ==========================================================================
// スペクトル傾斜（こもり）
// ==========================================================================

/** 傾斜を近似する下限周波数。基本周波数と第1フォルマントより上に置く */
const SLOPE_FROM_HZ = 1000;
/** 近似する上限周波数。会議音声の明瞭度に効く上限 */
const SLOPE_TO_HZ = 7000;
/** 近似に使う集約バンド幅 */
const SLOPE_BAND_HZ = 200;
/** 近似に必要な最小オクターブ数。これ未満では傾きが決まらない */
const SLOPE_MIN_OCTAVES = 1;
/** 近似に必要な最小バンド数 */
const SLOPE_MIN_BANDS = 4;
/**
 * 近似区間に信号があると認める最小レベル（スペクトルのピークから何dB下まで）。
 * これを下回る区間は数値的な床なので、そこで測った傾きは意味を持たない。
 */
const SLOPE_SIGNAL_SPAN_DB = 60;

/**
 * 1kHz以上のスペクトル傾斜[dB/oct]。負の値が急なほど高域が落ちている。
 *
 * 「こもり」（マイクが服の下・机の下・口から遠い）は帯域上限を切るのではなく
 * 高域を緩やかに落とす。これを帯域比率で測ってはいけない。
 *
 * 以前は明瞭度比率（500〜3000Hz ÷ 有効帯域全体）で測っていたが、分母に
 * 0〜500Hzを含むため基本周波数の低い声で構造的に下がる。実測（実音声4話者）では
 * 傾き -12dB/oct を注入しても周波数軸が動いたのは 0.5/25点、一方で劣化なしの
 * 話者間のばらつきは 7点あった。**こもりより声質に14倍敏感**で、環境ではなく
 * 誰が喋っているかを測っていた。
 *
 * 傾斜は基本周波数と第1フォルマントより上だけを見るので声質の影響が小さく、
 * 注入する物理量そのものなので真値と直接比べられる。実測では注入量に
 * ほぼ1:1で追随した（0→-12dB/oct の注入で実測が -10.95〜-13.76 動いた）。
 *
 * 帯域制限された音声では近似区間が取れないので null を返す。その場合の減点は
 * 帯域幅の内訳が担う。
 */
export function estimateSpectralSlope(
  data: Float32Array,
  sampleRate: number,
  bandwidthHz: number,
): number | null {
  const spectrum = activePowerSpectrum(data, FFT_SIZE, 'hamming');
  if (spectrum === null) return null;

  const top = Math.min(SLOPE_TO_HZ, bandwidthHz, sampleRate / 2);
  if (top / SLOPE_FROM_HZ < Math.pow(2, SLOPE_MIN_OCTAVES)) return null;

  const { powers } = bandPowers(spectrum, sampleRate, FFT_SIZE, SLOPE_BAND_HZ);
  const xs: number[] = [];
  const ys: number[] = [];
  for (let b = 0; b < powers.length; b++) {
    const f = (b + 0.5) * SLOPE_BAND_HZ;
    if (f < SLOPE_FROM_HZ || f > top) continue;
    xs.push(Math.log2(f / SLOPE_FROM_HZ));
    ys.push(powerDb(powers[b]));
  }
  if (xs.length < SLOPE_MIN_BANDS) return null;

  // 近似区間がスペクトルの底（信号が無い領域）なら傾きに意味は無い。
  // 7.5kHzの純音のような入力では 1〜7kHz が数値的な床になり、
  // 平坦な床の傾き0を「良好」と読んでしまう。
  let peakLevel = -Infinity;
  for (let b = 0; b < powers.length; b++) {
    peakLevel = Math.max(peakLevel, powerDb(powers[b]));
  }
  const fitMean = ys.reduce((a, b) => a + b, 0) / ys.length;
  if (fitMean < peakLevel - SLOPE_SIGNAL_SPAN_DB) return null;

  return linearRegression(xs, ys)?.slope ?? null;
}

// ==========================================================================
// 残響（RT60）
// ==========================================================================

/** 減衰の追跡に使うフレーム長[秒] */
const DECAY_FRAME_SEC = 0.02;
/** 減衰の追跡に使うホップ[秒] */
const DECAY_HOP_SEC = 0.01;
/** レベル列を平滑化する窓（フレーム数） */
const DECAY_SMOOTH_FRAMES = 3;
/**
 * 減衰の近似を始める点。発話が止まる直前のレベルから何dB下がったところから測るか。
 *
 * **3dBから10dBに上げた。** 発話が止まった直後の下降は部屋の残響ではなく発話自体の
 * 立ち下がりで、そこを含めると傾きが急に出てRT60を過小評価する。直接音が残響より
 * 十分下がるまで待つ必要があり、その待つ量は直接音対残響比(DRR)で決まる。
 *
 * 3dBのままでも以前は問題が見えなかった。検証基盤のインパルス応答が DRR -12〜-21dB
 * （大聖堂並み）で、残響が直接音より最初から大きかったためである。DRRを実際の録音の
 * 範囲にすると誤差が露出した。
 *
 * **値は単一のDRRで決めてはいけない。** RT60を振る条件はすべて既定のDRR(+10dB)で
 * 生成されるので、その条件だけを見ると -10dB が最良に見える（MAE 0.096）。しかし
 * DRRを +20〜-10dB に振った条件で見ると別の答えになる:
 *
 *            rt60条件      DRR全域
 *            MAE   n      測定    平均MAE  最大バイアス  参考値
 *   -6dB    0.170  46     48/48    0.183     0.290      10/48
 *   -8dB    0.141  43     43/48    0.160     0.243      20/48   ← 採用
 *   -10dB   0.096  40     40/48    0.174     0.242      31/48
 *   -12dB   0.118  32     35/48    0.181     0.324      41/48
 *   -14dB   0.109  26     20/48    0.176     0.266      47/48
 *
 * -8dB が全域の平均誤差と最大バイアスを最小にし、測定できる条件も多い。
 * 一点に合わせて全体を悪くするのは、削除した補正係数1.35と同じ誤りになる。
 *
 * 深く待つほど測定できる条件が減る（RT60 0.7秒以上で減衰イベントが足りなくなる）。
 * 測れなかった条件と、イベント数が足りない条件は参考値として開示される。
 */
const DECAY_START_DROP_DB = 8;
/** 走行最小値からこれ以上戻ったら下降区間の終わりとみなす[dB] */
const DECAY_RISE_TOL_DB = 1.5;
/**
 * ノイズフロアからこの余裕を残して打ち切る[dB]。
 * ノイズフロアを取るパーセンタイルと合わせて実音声で調整した。p05+3dB では
 * 残響がフロアを持ち上げて測定区間が途中で打ち切られ、RT60 1.0秒以上が
 * ほとんど測定不能になっていた（実測: 3件中1件しか取れず、0.7秒も +0.26秒 の過大評価）。
 * p02+2dB にすると 1.0秒が3件すべて測定でき、0.7秒の誤差も +0.10秒に縮んだ。
 */
const DECAY_FLOOR_MARGIN_DB = 2;
/** ノイズフロアを取るパーセンタイル。残響がフロアを持ち上げるため低めに取る */
const DECAY_FLOOR_PERCENTILE = 0.02;
/** 直線近似に必要な最小フレーム数(=80ms) */
const DECAY_MIN_FRAMES = 8;
/** 直線近似に必要な最小の落差[dB] */
const DECAY_MIN_DROP_DB = 10;
/** 直線近似の決定係数の下限 */
const DECAY_MIN_R2 = 0.9;
/** 物理的にありえない推定値を捨てる範囲[秒] */
const RT60_MIN_SEC = 0.05;
const RT60_MAX_SEC = 5;
/**
 * RT60を返すのに必要な減衰イベント数。
 * 落差の最小値(DECAY_MIN_DROP_DB)を緩めればイベントは増えるが、実測では
 * 0.2〜1.0秒の精度が悪化した（真値1.0秒に対し誤差 -0.11秒 → -0.41秒）。
 * 精度を優先し、代わりに2件でも値は返して「低信頼」として扱う。
 */
const DECAY_MIN_EVENTS = 2;
/**
 * これ以上のイベント数があれば推定値を信頼できるとみなす。
 *
 * 実測（CMU ARCTIC 4話者・16k/48kHz・43条件）でのイベント数と誤差:
 *
 *   >=3: MAE 0.069 / 最大 0.361     <3: MAE 0.168 / 最大 0.370
 *   >=4: MAE 0.053 / 最大 0.249     <4: MAE 0.196 / 最大 0.370
 *   >=5: MAE 0.053 / 最大 0.249    (4以上と同じ。5に上げる利得はない)
 *
 * 4件を境に3.7倍の差が付くので4を採る。RT60 0.7秒以下では常に4件以上
 * 得られるので、判定に効く範囲を「参考値」に落とす副作用はない
 * （イベントが減るのは1.0秒以上で、その領域は残響軸がすでに最低点）。
 *
 * 推定値のばらつき（イベントごとのRT60の四分位範囲）でも同じことを試したが、
 * 誤差とは単調にならず判別に使えなかった。件数のほうが素直な指標だった。
 */
const DECAY_CONFIDENT_EVENTS = 4;
/**
 * 減衰率の分布から採る位置。
 *
 * 「速い減衰は話者の動き、遅い減衰が部屋」と考えて上側パーセンタイル(0.75)を
 * 試したが、実測では中央値のほうが明確に正確だった（validation の rt60 条件で
 * 真値0.2〜1.0秒に対し p50 の誤差0.02〜0.11秒、p75 は0.02〜0.27秒）。
 * 残響が掛かった時点で発話自体の減衰も残響に律速されるため、分布全体が
 * 部屋を反映する。上側を採ると外れ値を拾うだけだった。
 */
const RT60_PERCENTILE = 0.5;

export interface ReverbEstimate {
  /** 推定RT60[秒]。測定できない場合は null */
  rt60Sec: number | null;
  /**
   * 推定値を信頼できるか。減衰イベントが少ないときは false。
   * 残響が非常に長い部屋では息継ぎの間に減衰が収まらずイベントが減るため、
   * 「値はあるが根拠が薄い」状態が起こる。UI側で参考値として明示する。
   */
  confident: boolean;
  /** 採用できた減衰イベント数 */
  events: number;
  /** イベントごとの推定値[秒]（ばらつきの確認用） */
  perEventRt60: number[];
}

export function estimateReverb(data: Float32Array, sampleRate: number): ReverbEstimate {
  const frameLen = Math.max(1, Math.floor(sampleRate * DECAY_FRAME_SEC));
  const hop      = Math.max(1, Math.floor(sampleRate * DECAY_HOP_SEC));
  const hopSec   = hop / sampleRate;

  const raw: number[] = [];
  for (let i = 0; i + frameLen <= data.length; i += hop) {
    raw.push(dbfs(rms(data, i, frameLen)));
  }
  if (raw.length < DECAY_MIN_FRAMES * 4) {
    return { rt60Sec: null, confident: false, events: 0, perEventRt60: [] };
  }

  const levels  = movingAverage(raw, DECAY_SMOOTH_FRAMES);
  const floorDb = percentile(levels, DECAY_FLOOR_PERCENTILE) + DECAY_FLOOR_MARGIN_DB;
  const perEventRt60: number[] = [];

  let i = 1;
  while (i < levels.length) {
    // 下降の始まりを探す。直前のフレームがそのイベントのピーク。
    if (levels[i] >= levels[i - 1]) { i++; continue; }
    const peak = i - 1;

    // ---- 最大の下降区間を伸ばす（走行最小値からの小さな戻りは許容する）----
    let end = i;
    let runMin = levels[i];
    while (end + 1 < levels.length) {
      const next = levels[end + 1];
      if (next > runMin + DECAY_RISE_TOL_DB) break;
      if (next < runMin) runMin = next;
      end++;
    }
    const runEnd = end + 1; // 排他的

    // ---- 直接音の急峻な部分をスキップして起点を決める ----
    let start = peak;
    while (start < runEnd && levels[start] > levels[peak] - DECAY_START_DROP_DB) start++;

    // ---- ノイズフロアに沈む前で打ち切る ----
    let fitEnd = start;
    while (fitEnd < runEnd && levels[fitEnd] > floorDb) fitEnd++;

    const n = fitEnd - start;
    if (n >= DECAY_MIN_FRAMES && levels[start] - levels[fitEnd - 1] >= DECAY_MIN_DROP_DB) {
      const fit = linearFit(levels, start, fitEnd, hopSec);
      if (fit.slope < 0 && fit.r2 >= DECAY_MIN_R2) {
        const rt60 = -60 / fit.slope;
        if (rt60 >= RT60_MIN_SEC && rt60 <= RT60_MAX_SEC) perEventRt60.push(rt60);
      }
    }

    i = Math.max(i + 1, runEnd); // 同じ下降区間を重複して数えない
  }

  if (perEventRt60.length < DECAY_MIN_EVENTS) {
    return { rt60Sec: null, confident: false, events: perEventRt60.length, perEventRt60 };
  }
  return {
    rt60Sec: percentile(perEventRt60, RT60_PERCENTILE),
    confident: perEventRt60.length >= DECAY_CONFIDENT_EVENTS,
    events: perEventRt60.length,
    perEventRt60,
  };
}

