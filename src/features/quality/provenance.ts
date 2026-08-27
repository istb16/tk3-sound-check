/**
 * 音声の「出自」検出 — この録音は環境評価に使えるのか？
 *
 * Zoom / Teams / スマホの録音アプリを通った音声は、すでにノイズ抑制・AGC・
 * 帯域制限がかかっている。そこから録音環境を推定することは原理的に不可能で、
 * しかも黙って高得点を返してしまう（騒がしい部屋でも「ノイズがなく静か」と出る）。
 *
 * ここでは音声そのものから加工の痕跡を検出する。判定結果はスコアを変えず、
 * UIに警告バッジとして表示するためだけに使う（該当軸に直接付ける）。
 *
 * 注意: `decodeFile` は OfflineAudioContext(…, 44100) で復号するため
 * `audioBuffer.sampleRate` は常に44100になり、元ファイルの帯域を全く反映しない。
 * したがって帯域上限はスペクトルから実測するしかない。
 */

import { dbfs, frameRmsList, percentile, powerDb } from '../../lib/dsp/stats.ts';
import { FFT_SIZE, averagePowerSpectrum, bandPowers } from '../../lib/dsp/spectrum.ts';

/** 加工の痕跡の種類 */
export type ProvenanceFlag =
  | 'band-limited'    // 帯域上限が音声用途として不足（低ビットレート圧縮 / 電話品質）
  | 'digital-silence' // 無音区間が不自然に静か（ノイズ抑制ゲートの痕跡）
  | 'zero-run';       // 完全な無音サンプルが連続（ゲート or DTXの痕跡）

export interface Provenance {
  /** 実測した帯域上限[Hz]。カットオフが見つからなければナイキスト周波数 */
  bandwidthHz: number;
  /** カットオフの崖の深さ[dB]。大きいほど人工的な帯域制限 */
  cutoffDropDb: number;
  /** 無音区間のノイズフロア[dBFS] */
  silenceFloorDb: number;
  /** 完全な無音(値0)が連続した最長区間[ms] */
  maxZeroRunMs: number;
  /** 加工済みと判定されたか */
  processed: boolean;
  flags: ProvenanceFlag[];
}

// ---- 判定閾値 ----
// いずれも validation/ の実測レポートを見て調整する前提の初期値。
/**
 * これ以下の帯域上限は加工の痕跡とみなす[Hz]。
 *
 * 意味のある区切りは「電話品質(3.4k)」「16kHzサンプリング由来(8k)」「32kHz以上(14k+)」。
 * 8kHz近辺に上限がある音声は16kHz由来と判断してよく、正当な素材が8.3kHzで切れる
 * ことはない。
 *
 * 8000ではなく8500にしてある。**実測した上限は8000ちょうどには来ない。**
 * リサンプラのフィルタ形状で±100〜200Hzずれるため、実録音3本では 8000〜8100Hz に
 * 散った。8000を閾値にすると 8100Hz の16kHz由来音声を「帯域制限なし」と報告して
 * しまう（実際に起きた）。次の意味のある区切り（11kHz以上の中身）までは十分距離が
 * あるので、余裕を持たせても誤検出は増えない。
 */
const BAND_LIMIT_HZ = 8500;
/** カットオフの崖と認める最小の落差。自然な音声のロールオフはこの値に達しない */
const CLIFF_DB = 25;
/** 崖を探す下限周波数。これ未満は音声の基本的なエネルギー帯なので対象外 */
const CLIFF_SCAN_FROM_HZ = 1500;
/** 無音区間がこれより静かなら、ノイズ抑制で削られたと判断する */
const DIGITAL_SILENCE_DB = -75;
/** 完全無音の連続がこの長さを超えたらゲートの痕跡と判断する */
const ZERO_RUN_MS = 100;
/** 崖検出に使う集約バンド幅 */
const BAND_WIDTH_HZ = 100;
/**
 * 崖の前後を平均するバンド数の候補（100Hz単位 = 500/1000/1500Hz）。
 *
 * **1つの窓幅では足りない。** 遷移幅は経路によって大きく違う。
 *   合成した帯域制限（1023タップFIR） … 約200Hz
 *   実録音（Windowsの音声処理パイプライン経由の44.1kHz WAV） … 約1000Hz
 *
 * 500Hz固定の窓は後者の遷移域をまたぐため落差を過小評価する。実測では 8000Hz→
 * -44dB、9400Hz→-84dB という明白な崖（40dB）を 20.1dB としか測れず、閾値25dBに
 * 届かないので「帯域制限なし」と誤判定していた。同じことが実録音のAAC（22.5dB）でも
 * 起きていた。2件とも閾値の直下という偏りは偶然ではない。
 *
 * 窓を広げても自然なロールオフを崖と誤検出する危険は増えない。8kHz付近では
 * 1オクターブが8kHz幅なので、1500Hzの窓対（計3000Hz）で見える自然な落差は
 * -12dB/oct でも3〜4dB程度にすぎない。
 */
const CLIFF_WINDOW_BAND_CANDIDATES = [5, 10, 15];
/** 境界を詰めるときに使う基準の窓幅 */
const CLIFF_WINDOW_BANDS = 5;
/**
 * 帯域上限として報告する点。**通過域の傾きを外挿した線から**これだけ下がったところ[dB]。
 *
 * 遷移幅が経路によって5倍違うので、「急降下が始まった位置」のような形に依存する
 * 定義では経路ごとにずれる。実録音では遷移が緩やかで1バンドあたりの落差が小さく、
 * 以前の詰め方は遷移域の中ほど(8700Hz)を返していた。
 *
 * ただし**「通過域の平均から6dB下」でも駄目**だった。音声のスペクトルは通過域内でも
 * -6〜-12dB/oct で落ちているので、平均を基準にすると基準が高く出て境界が下にずれる。
 * 実測で -12dB/oct の信号の 3400Hz カットオフを 2300Hz と報告した（-1100Hz）。
 * 通過域の傾きを直線近似して外挿し、その線からの落差で定義する。
 *
 * **6dBという値は実測で選んだ。** -8dB にすると合成条件の誤差が完全に0になるが
 * （-6dBでは MAE 8.3Hz / 最大100Hz）、実録音の帯域上限を 8300Hz と読んでしまい、
 * 加工痕跡の閾値(8000Hz)を超えて band-limited の警告が出なくなる。16kHz由来の
 * 音声を「帯域制限なし」と報告することになり、この検出器が存在する目的を損なう。
 * 合成条件の100Hz（1バンド）の誤差は周波数軸のスコアを0.04点動かすだけで実害が無い。
 * -6dB は振幅半減点として標準的な定義でもあり、独立した根拠がある。
 */
const CUTOFF_POINT_DB = 6;
/** 通過域の傾きを近似する区間の長さ（窓幅の倍数） */
const TREND_SPAN_WINDOWS = 3;
/** 近似に必要な最小バンド数 */
const TREND_MIN_BANDS = 4;
/**
 * 走査下限より上が「窓関数のリーク床」であると判定する条件。
 *
 * 崖の走査は 1500Hz から始まるので、それより上に何も無い入力（純音・低域だけの
 * ランブル）では崖が見つからず、ナイキストを返してしまう。実際に100Hzの正弦波が
 * 帯域幅で満点を取っていた。
 *
 * **絶対レベルの閾値で塞いではいけない。** 一度 SIGNAL_SPAN_DB=60 で塞ごうとして、
 * -12dB/oct で自然に落ちる広帯域信号（7.3オクターブで-88dB）を 3800Hz の
 * 帯域制限と誤検出した。このファイルの冒頭で警告しているとおりの誤りだった。
 *
 * 判別できるのは**形**のほう。信号が無い領域は窓関数のリーク床なので、
 * レベルがほぼ一定（振れ幅が小さい）でピークから遠い。自然なロールオフは
 * 落ち続けるので振れ幅が大きい。
 */
const EMPTY_BAND_SPREAD_DB = 6;
const EMPTY_BAND_GAP_DB = 60;

export function detectProvenance(data: Float32Array, sampleRate: number): Provenance {
  const nyquist = sampleRate / 2;
  const flags: ProvenanceFlag[] = [];

  const { bandwidthHz, cutoffDropDb } = measureBandwidth(data, sampleRate);
  const silenceFloorDb = measureSilenceFloor(data, sampleRate);
  const maxZeroRunMs   = measureMaxZeroRun(data, sampleRate);

  if (bandwidthHz <= BAND_LIMIT_HZ && bandwidthHz < nyquist) flags.push('band-limited');
  if (silenceFloorDb < DIGITAL_SILENCE_DB) flags.push('digital-silence');
  if (maxZeroRunMs >= ZERO_RUN_MS) flags.push('zero-run');

  return {
    bandwidthHz,
    cutoffDropDb,
    silenceFloorDb,
    maxZeroRunMs,
    processed: flags.length > 0,
    flags,
  };
}

/**
 * 帯域上限の実測。
 *
 * 絶対レベルの閾値では判定できない。自然な音声のスペクトルは1kHz以上で
 * -6〜-12dB/oct で落ちるため、16kHzではピークから50dB下がることが普通にあり、
 * 「レベルが低い＝帯域制限」とは言えない。
 *
 * 人工的なカットオフの特徴は落差の「急峻さ」にある。コーデックやリサンプラの
 * アンチエイリアスフィルタは数百Hzの幅で30dB以上落ちる崖を作る。
 * そこで、前後500Hzの平均レベル差が最大になる周波数を探し、
 * その落差が CLIFF_DB を超えたときだけ帯域制限と判定する。
 */
function measureBandwidth(
  data: Float32Array,
  sampleRate: number,
): { bandwidthHz: number; cutoffDropDb: number } {
  const nyquist = sampleRate / 2;
  if (data.length < FFT_SIZE * 2) return { bandwidthHz: nyquist, cutoffDropDb: 0 };

  // 帯域上限の実測には低リーク窓が必須。ハミング窓ではリーク床が約-70dBに
  // 居座り、コーデックが削った領域と窓自身のリークを区別できない。
  const spectrum = averagePowerSpectrum(data, FFT_SIZE, 'blackman-harris');
  const { powers } = bandPowers(spectrum, sampleRate, FFT_SIZE, BAND_WIDTH_HZ);

  // バンドごとのレベル[dB]
  const levels = new Float32Array(powers.length);
  for (let b = 0; b < powers.length; b++) levels[b] = powerDb(powers[b]);

  const scanFrom = Math.floor(CLIFF_SCAN_FROM_HZ / BAND_WIDTH_HZ);
  const from = Math.max(CLIFF_WINDOW_BANDS, scanFrom);

  // 遷移幅がわからないので複数の窓幅で走査する。
  //
  // 採用するのは「閾値を超えた**最も狭い**窓」。最も深い落差を採ると、急峻な崖でも
  // 常に最大幅の窓が勝ってしまい（幅が広いほど落差の総量を拾うため）、境界の局在性が
  // 落ちて通過域の近似区間も遷移域から遠ざかる。狭い窓で足りるならそれが最も正確。
  let bestDrop = 0;
  let bestEdge = -1;
  let bestW = CLIFF_WINDOW_BANDS;

  for (const W of CLIFF_WINDOW_BAND_CANDIDATES) {
    let drop = 0;
    let edge = -1;
    const lo = Math.max(W, scanFrom);
    for (let e = lo; e < powers.length - W; e++) {
      let below = 0, above = 0;
      for (let i = 1; i <= W; i++) below += levels[e - i];
      for (let i = 0; i < W; i++)  above += levels[e + i];
      const d = below / W - above / W;
      if (d > drop) { drop = d; edge = e; }
    }
    // 報告する落差は最大値（どの窓でも崖に届かなかったことを示すため）
    if (drop > bestDrop) { bestDrop = drop; bestEdge = edge; bestW = W; }
    if (drop >= CLIFF_DB) { bestDrop = drop; bestEdge = edge; bestW = W; break; }
  }

  if (bestEdge < 0 || bestDrop < CLIFF_DB) {
    // 崖が無い場合、走査下限より上が「窓関数のリーク床」でないかを確かめる。
    // 床であれば、そこに信号は無いので帯域上限はナイキストではない。
    return { bandwidthHz: bandwidthWhenNoCliff(levels, from, nyquist), cutoffDropDb: bestDrop };
  }

  const edge = locateCutoff(levels, bestEdge, bestW, from);
  return { bandwidthHz: Math.min(nyquist, edge * BAND_WIDTH_HZ), cutoffDropDb: bestDrop };
}

/**
 * 崖の位置を1バンド単位まで詰める。
 *
 * 「そのバンドへ入るときの落差」が DESCENT_STEP_DB を超えているバンドを
 * 急降下の一部とみなし、その連なりの最下位バンドを返す。
 * そのバンドの下端が帯域上限になる。
 */
/**
 * 崖が見つからなかったときの帯域上限。
 *
 * 走査下限より上のレベルが「ほぼ一定でピークから遠い」なら、そこは窓関数の
 * リーク床であって信号ではない。その場合はピーク近傍のバンドまでを帯域とする。
 * そうでなければ自然なロールオフなので、ナイキストまで中身があるとみなす。
 */
function bandwidthWhenNoCliff(levels: Float32Array, scanFrom: number, nyquist: number): number {
  if (scanFrom >= levels.length) return nyquist;

  let peak = -Infinity;
  for (let b = 0; b < levels.length; b++) peak = Math.max(peak, levels[b]);

  let hi = -Infinity;
  let lo = Infinity;
  for (let b = scanFrom; b < levels.length; b++) {
    hi = Math.max(hi, levels[b]);
    lo = Math.min(lo, levels[b]);
  }
  const isLeakFloor = hi - lo < EMPTY_BAND_SPREAD_DB && peak - hi > EMPTY_BAND_GAP_DB;
  if (!isLeakFloor) return nyquist;

  // 床から抜けている最上のバンドまでを帯域とする
  let edge = 0;
  for (let b = levels.length - 1; b >= 0; b--) {
    if (levels[b] > hi + EMPTY_BAND_SPREAD_DB) { edge = b + 1; break; }
  }
  return Math.min(nyquist, Math.max(BAND_WIDTH_HZ, edge * BAND_WIDTH_HZ));
}
/**
 * 帯域上限のバンド位置を決める。
 *
 * 走査で得られる `bestEdge` は「上側の窓が完全にストップバンドに入る位置」なので、
 * 遷移幅のぶん高く出る。遷移幅は経路によって200Hz〜1000Hzと5倍違うため、
 * 形に依存する詰め方（1バンドあたりの落差が閾値を超える間だけ下る）では
 * 経路ごとにずれる。実録音では落差が緩やかすぎて詰めが早期に止まり、
 * 遷移域の中ほどを返していた。
 *
 * 通過域のレベルから CUTOFF_POINT_DB 下がった点で定義すれば遷移幅に依存しない。
 */
function locateCutoff(
  levels: Float32Array,
  bestEdge: number,
  windowBands: number,
  floorBand: number,
): number {
  // 通過域（遷移域より下）の傾きを直線近似する。x は log2(周波数)。
  const trendHi = Math.max(floorBand + 1, bestEdge - windowBands);
  const trendLo = Math.max(1, trendHi - windowBands * TREND_SPAN_WINDOWS);
  const xs: number[] = [];
  const ys: number[] = [];
  for (let b = trendLo; b < trendHi; b++) {
    xs.push(Math.log2(b + 0.5));
    ys.push(levels[b]);
  }
  if (xs.length < TREND_MIN_BANDS) return bestEdge;

  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) * (xs[i] - mx);
  }
  const slope = den === 0 ? 0 : num / den;
  const predict = (b: number): number => my + slope * (Math.log2(b + 0.5) - mx);

  // 外挿した線から CUTOFF_POINT_DB 以上落ちていない最上のバンド
  const limit = Math.min(levels.length - 1, bestEdge + windowBands);
  let edge = trendHi;
  for (let b = trendHi; b <= limit; b++) {
    if (levels[b] >= predict(b) - CUTOFF_POINT_DB) edge = b + 1;
  }
  return edge;
}

/** 無音区間(下位10%フレーム)のノイズフロア[dBFS] */
function measureSilenceFloor(data: Float32Array, sampleRate: number): number {
  const frameSize = Math.max(1, Math.floor(sampleRate * 0.02));
  const frames = frameRmsList(data, frameSize);
  if (frames.length < 4) return 0;
  return dbfs(percentile(frames, 0.10));
}

/** 完全な無音(値がちょうど0)が連続した最長区間[ms] */
function measureMaxZeroRun(data: Float32Array, sampleRate: number): number {
  let run = 0;
  let longest = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 0) {
      run++;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  return (longest / sampleRate) * 1000;
}

/**
 * 加工痕跡によって信用できなくなる軸。**現在は常に空を返す。**
 *
 * 以前は、ノイズ抑制が入っていればノイズ軸と残響軸、帯域制限があれば周波数軸を
 * 参考値として扱い、総合判定に「良好」を出さないようにしていた。加工済みの音声から
 * 録音環境は推定できないという理由である。
 *
 * **この道具が答えるのは「できあがった音声が会議の録音として使えるか」であって、
 * 「部屋の音響がよいか」ではない。** ノイズ抑制が入っていて、その結果の音声に
 * 問題がなければ、音質はよい。加工そのものを欠点として扱わない。
 *
 * 帯域制限も同様に扱う。削られた高域は周波数軸の帯域幅の内訳が直接減点するので、
 * 二重に扱う必要がない。
 *
 * 残っている限界: ノイズ抑制の副作用（ミュージカルノイズ、レベルのポンピング）は
 * 聞き取りやすさを損なうのにSNRの測定値を上げる。この道具はそれを捉えられない。
 *
 * 関数は残してある。痕跡の情報自体は表示するので、将来「この加工は聞き取りやすさを
 * 損なう」と言える根拠が得られたときにここへ戻せるようにしておく。
 */
export function unreliableAxes(_p: Provenance): ProvenanceAffectedAxis[] {
  return [];
}

/**
 * provenance が影響しうる軸。AudioAnalyzer の ScoreAxis の部分集合。
 * ここで型を閉じているのは provenance.ts が AudioAnalyzer.ts に依存しないため
 * （AudioAnalyzer が provenance を import しており、逆向きは循環になる）。
 */
type ProvenanceAffectedAxis = 'volume' | 'frequency' | 'reverb' | 'clip' | 'noise';
