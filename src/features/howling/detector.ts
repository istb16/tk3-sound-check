/**
 * ハウリングの検出。DOM非依存。
 *
 * 答える問いは1つだけ——**「いま鳴いているのは、どの周波数か。」**
 * 鳴っていること自体は部屋の全員が耳で分かっている。分からないのは
 * 3.2kHz なのか 4.5kHz なのかだけであり、そこだけを数値にする。
 *
 * ここに残してあるのは**この道具の判断だけ**である。FFT・ピークの補間・突出度の
 * 測り方・オクターブバンドの定義・流れのフレーム化は `lib/` にある。
 * 逆に、閾値と「何を発振と呼ぶか」は `lib/` に置かない——用途ごとに意味が違うので、
 * 共有すると片方を動かしたときにもう片方が黙って壊れる。
 *
 * 設計上の非対称: **空振り（誤検出）は見落としより重い。** ただし理由が
 * 音質チェックとは違う。あちらは「無駄な作業をさせるから」だが、ここでは
 * **利用者に検算の手段が無いから**である。利用者は耳でハウリングを聞いているので、
 * 見落としには気づける（鳴いたのに画面が動かなかった、と分かる）。空振りには
 * 気づけない——鳴っていないのに出た数字を、さっきの鳴きの正体だと信じてしまう。
 * 気づける失敗より、気づけない失敗のほうが重い。
 */

import { blackmanHarrisWindow, fft } from '../../lib/dsp/fft.ts';
import { octaveBandEdges, octaveBandOf } from '../../lib/dsp/octave.ts';
import {
  findStrongestPeak, interpolatePeakFreq, peakProminenceDb,
  type ProminenceOptions,
} from '../../lib/dsp/peaks.ts';
import { anyAbove } from '../../lib/dsp/stats.ts';
import { FrameSplitter, RingWindow, SampleRing } from '../../lib/stream/frames.ts';

/**
 * FFT長。音質チェックの 2048 とは**別に持つ**。
 *
 * 48kHz で 2048 はビン幅 23.4Hz。125Hz はビン5本目、63Hz はビン2.7本目で、
 * 「周辺の中央値と比べて何dB持ち上がっているか」を測るための下側のビンが
 * 存在しない。光らないバーを並べることになる。
 * 4096 なら 11.7Hz / 85ms で、演台マイクの 200〜500Hz の鳴きが測れる。
 * ホップは 100ms のままなので表示レイテンシは変わらず、増えるのは計算量だけ。
 */
export const FFT_SIZE = 4096;

/** 解析と表示の間隔。見ながら操作する道具なのでレイテンシが製品価値そのもの */
export const FRAME_MS = 100;

/**
 * 発振と断じるのに必要な連続フレーム数。
 *
 * 設計時は500msだったが、腕のいいオペレーターはハウリングを 0.2〜0.5秒で殺す。
 * 500ms を要求すると**その人の現場では一つも捕まらない**——「下手な現場でだけ
 * 動く道具」になる。拍手や机を叩く音はインパルス（10〜20ms）で桁が2つ違うので、
 * 3フレームでも弾ける。ここと500msの差で新たに拾うのは口笛や楽器の短い音であり、
 * そこは倍音列の判定が落とす。
 *
 * **3フレーム＝250ms ではない。** 窓(85ms)がホップ(100ms)より短く重なりが無いので、
 * 実際に要求している連続長は**約300ms**である（実測: 0.15秒 0% / 0.2秒 20% /
 * 0.25秒 70% / 0.3秒 100%）。0.2〜0.5秒のうち下半分は捕まらない。詰めるには
 * ホップを縮めて窓を重ねるしかなく、計算量と引き換えになる。
 */
export const SUSTAIN_FRAMES = 3;

/**
 * 発振とみなす突出度[dB]。周辺の中央値からの持ち上がり。
 *
 * 合成信号で決めた（detector.test.ts が適合率と再現率を実測している）。
 * ノイズだけを12通りの乱数系列で流すと、単一フレームの突出度は最大 16.5dB まで
 * 上がる（2000本のビンの最大値なので、これは偶然の産物である）。18dB では
 * 余裕が1.5dBしか無く、現場の少しの違いで空振りが出る。そこに余裕を積んだ値。
 */
export const PROMINENCE_DB = 21;

/**
 * 倍音列の判定で「有意なピークがある」とみなす突出度[dB]の下限。
 * 発振の閾値より緩くする——ここで見たいのは「そこに音があるか」であって
 * 「そこが発振しているか」ではない。
 */
const HARMONIC_DB = 12;

/**
 * 倍音列の相手として認めるのに、注目しているピークから何dB以内であればよいか。
 *
 * 絶対値の下限だけでは足りない。声の倍音列は 180Hz おきに立つので、**どんな
 * 周波数の 1/2 の近くにも、たまたま何かの倍音が居る**。ピンクノイズの偶然の
 * ピークも同じことをする。それで本物の発振が「倍音だ」と誤って落とされる。
 *
 * 本物の倍音列なら、下の倍音は注目しているピークと同程度に強い（たいていは
 * それより強い）。桁違いに弱いものを倍音列の相手として認めないことで、
 * 「たまたま近くに何かある」と「倍音列の一員である」を分ける。
 */
const HARMONIC_REL_DB = 12;

/** 倍音の位置を探す許容幅[ビン]。楽器も声も完全な整数倍にはならない */
const HARMONIC_SEARCH_BINS = 3;

/** 発振が途切れたとみなすまでの猶予フレーム数。表示のちらつきを防ぐ */
const GAP_FRAMES = 2;

/**
 * 「同じ鳴きの続き」とみなす周波数の近さ[比]。**±1ビンと併せて要求する。**
 *
 * ビンだけで見ると、同じ「±1ビン」が帯域の下端と上端でまるで違う厳しさになる。
 * 48kHz・FFT4096 のビン幅 11.7Hz は 3.2kHz に対して ±0.37% だが、
 * **210Hz に対しては ±5.6%（約95セント）**——半音近く動いても同じビンに入る。
 * 同じ規則が下端では約15倍緩い。
 *
 * その緩さを実際に通り抜けるのが**女性話者の声の基音**である。250Hz帯
 * (176.8〜353.6Hz) の候補にとって `f/2` は検出範囲の外なので、倍音判定は
 * 「2f と 3f の両方」の一本しか残らない。声の倍音の強さはフレームごとに揺れるので、
 * その AND が3フレーム連続で外れることは普通に起き、持続判定がそれを止められない。
 * 実音声（CMU Arctic 65本・レベル9条件・計585試行）で 26件(4.4%) の空振りが出て、
 * **全件が 189〜314Hz、うち24件が女性話者**だった。相対で締めると 2件(0.3%) になる。
 *
 * 本物は落ちない——発振の周波数はループの位相条件で決まるので動かない。±20セント
 * (1.2%)の揺れを与えても検出率は変わらなかった。0.5%〜3% のどこに置いても結果は
 * 同じで、閾値に敏感な値ではない。
 */
const SAME_RUN_RATIO = 0.02;

/** 突出度を測るときの近傍の取り方 */
const PROMINENCE_SHAPE = {
  /** 中央値を取る近傍の広さ。中心周波数に比例させる（対数軸で一定幅にする） */
  neighborRatio: 0.25,
  /** 近傍の最小幅[ビン]。高域で近傍が痩せないよう下支えする */
  minNeighborBins: 24,
  /** ピーク自身とその裾を中央値から外す幅[ビン] */
  guardBins: 6,
  /** 中央値を取るのに片側で最低限必要なビン数。これを割ったら「測れない」とする */
  minSideBins: 4,
  /** 近傍に含める最下ビン。これより下は直流と超低域の暴れなので使わない */
  floorMinBin: 3,
} as const;

/**
 * 入力が飽和したとみなす振幅。
 *
 * ボリュームチェックの CLIP_THRESHOLD と同じ値だが**定数は共有しない**。
 * あちらは会場の音割れの目安、こちらは「この道具がいま正しく動いていない」という
 * 自己申告であり、尺度が違う。
 */
const CLIP_THRESHOLD = 0.985;

/** 飽和表示を保持する窓[秒] */
const CLIP_WINDOW_SEC = 2;

/** 履歴に残す件数。スマホの画面で一目で読める上限 */
export const MAX_EVENTS = 3;

/** 同じ鳴きとみなす周波数の近さ。これ以内なら履歴の同じ行にまとめる */
const SAME_FREQ_RATIO = 0.03;

/**
 * 表示するオクターブバンドの中心周波数[Hz]。下端は 250Hz帯（176.8Hz〜）。
 *
 * **63Hz帯と125Hz帯は載せない。測れないものの箱だけ並べないためである。**
 *
 * 突出度は「ピーク − 周辺の中央値」であり、周辺は**ピークの上下両側**から
 * 取らないと意味を持たない。スペクトルは低域ほど右下がりなので、上側だけの
 * 中央値は本来より低く出て、突出度が実際より大きく出る。48kHz・FFT4096 では
 * ビン幅が 11.7Hz なので、125Hz はビン10.7本目——ガード幅(±6)を引くと
 * **下側に使えるビンが1本も残らない**。
 *
 * これは机上の心配ではない。125Hz帯を載せていたとき、基音110Hzの歌声を
 * 「110Hz で発振中」と誤検出した（detector.test.ts の基音掃引で発覚）。
 */
export const BANDS_HZ = [250, 500, 1000, 2000, 4000, 8000] as const;

const DETECT_LO_HZ = octaveBandEdges(BANDS_HZ[0]).lowHz;
const DETECT_HI_HZ = octaveBandEdges(BANDS_HZ[BANDS_HZ.length - 1]).highHz;

/** バンドの上端は開区間なので、そこへ丸めるときは僅かに内側へ寄せる */
const EDGE_EPSILON_HZ = 1e-6;

/**
 * 補間した周波数を、走査したバンドの中へ収める。
 *
 * 放物線補間はピークをビン中心から最大±0.5ビン動かすので、**バンドの縁では
 * 走査した範囲の外へはみ出しうる**。48kHz・FFT4096 では最上位ビン(965)が
 * 11308.6Hz、+0.5ビンで 11314.5Hz となり、8kHz帯の上端 11313.7Hz を超える。
 * そのまま `bandOf` に渡すと null が返り、**「発振中」なのにバンド名が無い**
 * という状態が生まれる——画面は赤くなるのに文字は「聞いています」のままになり、
 * この道具が最も避けたい自己矛盾そのものになる。履歴にも残らない。
 *
 * 収める先を検出範囲全体ではなく**走査したバンド**にしているのは、
 * 「表示する周波数は、表示するバンドの中にある」を構造的に保証するためである。
 * ずれは 0.1Hz 未満で、ビン幅 11.7Hz に対して意味を持たない。
 */
function clampToBand(freqHz: number, lowHz: number, highHz: number): number {
  return Math.min(Math.max(freqHz, lowHz), highHz - EDGE_EPSILON_HZ);
}

/** バーの満点にする突出度[dB]。閾値をやや超えたあたりで振り切る */
export const BAR_FULL_DB = PROMINENCE_DB * 1.4;

/** 周波数の属する表示バンドの中心[Hz]。表示範囲の外なら null */
export function bandOf(freqHz: number): number | null {
  return octaveBandOf(freqHz, BANDS_HZ);
}

export interface HowlingEvent {
  /** 鳴いた周波数[Hz]。パラメトリックEQ用 */
  freqHz: number;
  /** 属するオクターブバンドの中心[Hz]。固定バンドのグライコ用 */
  bandHz: number;
  /** 同じ周波数で何回鳴いたか */
  count: number;
  /** 合計で何秒鳴いたか */
  totalSeconds: number;
  /** 最後に鳴き終わってから何秒経ったか */
  agoSeconds: number;
}

export interface HowlingState {
  /** いま発振しているか */
  ringing: boolean;
  /** 発振中の周波数[Hz]。発振していなければ null */
  freqHz: number | null;
  /** 発振中のオクターブバンド中心[Hz]。発振していなければ null */
  bandHz: number | null;
  /** 発振が始まってからの秒数 */
  ringingSeconds: number;
  /**
   * バンドごとの突出度[dB]。BANDS_HZ と同じ並び。
   *
   * レベル(RTA)ではない。素直なレベルだと会議室で最も高いバーは常に
   * 250〜500Hz（人の声）になり、**検出しているものがバーに現れない**。
   * 突出度なら表示と判定が同じ量になり、閾値に近づいていくのが見える。
   * これは測定値の提示であって「危険」という断定ではない。
   */
  bandProminenceDb: number[];
  /** 直近の検出履歴。新しい順、最大 MAX_EVENTS 件 */
  events: HowlingEvent[];
  /** 入力が飽和しているか（直近 CLIP_WINDOW_SEC） */
  clipping: boolean;
  /** 解析したフレーム数 */
  frames: number;
}

interface Candidate {
  bin: number;
  freqHz: number;
  prominenceDb: number;
}

interface ActiveEvent {
  bin: number;
  freqSum: number;
  freqCount: number;
  startFrame: number;
  lastFrame: number;
}

interface StoredEvent {
  freqHz: number;
  bandHz: number;
  count: number;
  totalSeconds: number;
  lastFrame: number;
}

/**
 * 流れてくるPCMを受け取り、100msごとに判定を更新する。
 */
export class HowlingDetector {
  private readonly binHz: number;
  private readonly minBin: number;
  private readonly maxBin: number;
  private readonly prominence: ProminenceOptions;

  private readonly framer: FrameSplitter;
  private readonly ring = new SampleRing(FFT_SIZE);

  private readonly samples = new Float32Array(FFT_SIZE);
  private readonly re = new Float32Array(FFT_SIZE);
  private readonly im = new Float32Array(FFT_SIZE);
  private readonly spectrum = new Float32Array(FFT_SIZE >> 1);
  private readonly scratch = new Float32Array(FFT_SIZE >> 1);

  private frames = 0;
  private bandProminence: number[] = BANDS_HZ.map(() => 0);

  /** 連続を数えている途中の候補 */
  private runBin = -1;
  private runFrames = 0;
  private runFreqSum = 0;

  private active: ActiveEvent | null = null;
  private readonly stored: StoredEvent[] = [];

  private pendingClipped = false;
  private readonly clips: RingWindow;

  constructor(sampleRate: number) {
    this.binHz = sampleRate / FFT_SIZE;
    this.framer = new FrameSplitter((sampleRate * FRAME_MS) / 1000);
    this.clips = new RingWindow((CLIP_WINDOW_SEC * 1000) / FRAME_MS);

    const halfN = FFT_SIZE >> 1;
    this.minBin = Math.max(1, Math.ceil(DETECT_LO_HZ / this.binHz));
    this.maxBin = Math.min(halfN - 2, Math.floor(DETECT_HI_HZ / this.binHz));
    // 中央値の近傍は検出範囲の外のビンまで使ってよい。床を測るだけなので
    this.prominence = { ...PROMINENCE_SHAPE, floorMaxBin: halfN - 1 };
  }

  /**
   * PCMチャンクを流し込む。フレームが1つ以上完成したら true を返す
   * （呼び出し側が画面を更新すべきタイミング）。
   */
  push(chunk: Float32Array): boolean {
    return this.framer.push(chunk, (offset, length, completed) => {
      this.ring.write(chunk, offset, length);
      // 飽和はホップの隙間も含めて全サンプルを見る。48kHz では窓(85ms)より
      // ホップ(100ms)のほうが長く、窓の外に約15msの隙間ができるため
      if (!this.pendingClipped && anyAbove(chunk, offset, length, CLIP_THRESHOLD)) {
        this.pendingClipped = true;
      }
      if (!completed) return;

      this.clips.push(this.pendingClipped ? 1 : 0);
      this.pendingClipped = false;
      if (this.ring.filled >= FFT_SIZE) this.analyze();
    });
  }

  /**
   * 鳴っている最中の発振を履歴へ確定させ、最後の状態を返す。
   *
   * 計測が中断されたときに呼ぶ。これが無いと、**画面が消えた瞬間に鳴っていた
   * 周波数だけが消える**——中断前の記録を残す動機がまさにそれなので、
   * 一番肝心な1件を落とすことになる。
   */
  finish(): HowlingState {
    this.closeActive();
    return this.state;
  }

  get state(): HowlingState {
    const active = this.active;
    const freqHz = active ? active.freqSum / active.freqCount : null;
    return {
      ringing: active !== null,
      freqHz,
      bandHz: freqHz === null ? null : bandOf(freqHz),
      ringingSeconds: active
        ? ((active.lastFrame - active.startFrame + 1) * FRAME_MS) / 1000
        : 0,
      bandProminenceDb: [...this.bandProminence],
      events: this.stored.map((e) => ({
        freqHz: e.freqHz,
        bandHz: e.bandHz,
        count: e.count,
        totalSeconds: e.totalSeconds,
        agoSeconds: ((this.frames - e.lastFrame) * FRAME_MS) / 1000,
      })),
      clipping: this.clips.count((c) => c === 1) > 0,
      frames: this.frames,
    };
  }

  // ======================================================================
  // 1フレームの解析
  // ======================================================================

  private analyze(): void {
    this.frames++;
    this.computeSpectrum();

    const candidates = this.bandCandidates();
    this.bandProminence = candidates.map((c) => (c ? Math.max(0, c.prominenceDb) : 0));

    this.track(this.pick(candidates));
  }

  private computeSpectrum(): void {
    // Blackman-Harris（遠方サイドローブ −92dB）を使う。ハミング窓(−43dB)だと
    // 強いピークのリークが周辺に偽のピークを作り、それは「持続する」ので
    // 持続判定では落とせない。空振りを重く見る以上ここは譲れない
    const win = blackmanHarrisWindow(FFT_SIZE);
    this.ring.readInto(this.samples);
    for (let i = 0; i < FFT_SIZE; i++) {
      this.re[i] = this.samples[i] * win[i];
      this.im[i] = 0;
    }
    fft(this.re, this.im);
    for (let k = 0; k < this.spectrum.length; k++) {
      this.spectrum[k] = this.re[k] * this.re[k] + this.im[k] * this.im[k];
    }
  }

  /** バンドごとに、最もパワーの大きい極大点の突出度を測る */
  private bandCandidates(): Array<Candidate | null> {
    return BANDS_HZ.map((center) => {
      const { lowHz, highHz } = octaveBandEdges(center);
      const lo = Math.max(this.minBin, Math.ceil(lowHz / this.binHz));
      const hi = Math.min(this.maxBin, Math.floor(highHz / this.binHz));

      const bin = findStrongestPeak(this.spectrum, lo, hi);
      if (bin < 0) return null;
      return {
        bin,
        freqHz: clampToBand(
          interpolatePeakFreq(this.spectrum, bin, this.binHz), lowHz, highHz,
        ),
        prominenceDb: this.prominenceAt(bin),
      };
    });
  }

  /**
   * 突出したバンドから順に、倍音列の一員でないものを選ぶ。
   *
   * 最上位が倍音列で落ちても次を見るのは、歌声の倍音が一番立っている裏で
   * 本物の発振が起きている場合を取りこぼさないため。
   */
  private pick(candidates: Array<Candidate | null>): Candidate | null {
    const sorted = candidates
      .filter((c): c is Candidate => c !== null && c.prominenceDb >= PROMINENCE_DB)
      .sort((a, b) => b.prominenceDb - a.prominenceDb);

    for (const c of sorted) {
      if (!this.isHarmonicOfSomething(c.freqHz, c.prominenceDb)) return c;
    }
    return null;
  }

  /**
   * 倍音列の一員か。ハウリングは単独のピークとして立ち、倍音を伴わない。
   *
   * 本番中（BGMや喋りが流れている最中）を対象に含めた以上、この判定は省けない。
   * 伸ばした歌声・シンセのパッド・楽器の音は、細いピークとして数秒持続するので
   * 「突出＋持続」の2条件だけではハウリングと区別がつかない。
   *
   * 2方向から見る:
   * - f/2 〜 f/5 に有意なピークがある → f は上の倍音（例: 声の第3倍音）
   * - 2f と 3f の両方に有意なピークがある → f は倍音列の基音
   *
   * 入力が飽和していると本物の発振にも倍音が生えるため、ここで落ちることがある。
   * その場合は飽和の表示が出るので、利用者は黙って落ちた理由を知ることができる。
   */
  private isHarmonicOfSomething(freqHz: number, prominenceDb: number): boolean {
    const need = Math.max(HARMONIC_DB, prominenceDb - HARMONIC_REL_DB);
    for (let n = 2; n <= 5; n++) {
      if (this.hasPeakNear(freqHz / n, need)) return true;
    }
    return this.hasPeakNear(freqHz * 2, need) && this.hasPeakNear(freqHz * 3, need);
  }

  /** その周波数の近くに、求める強さの突出を持つ極大点があるか */
  private hasPeakNear(freqHz: number, needDb: number): boolean {
    const target = Math.round(freqHz / this.binHz);
    if (target < this.minBin || target > this.maxBin) return false;

    const bin = findStrongestPeak(
      this.spectrum,
      Math.max(this.minBin, target - HARMONIC_SEARCH_BINS),
      Math.min(this.maxBin, target + HARMONIC_SEARCH_BINS),
    );
    return bin >= 0 && this.prominenceAt(bin) >= needDb;
  }

  private prominenceAt(bin: number): number {
    return peakProminenceDb(this.spectrum, bin, this.prominence, this.scratch);
  }

  // ======================================================================
  // 持続と履歴
  // ======================================================================

  /**
   * 候補が、追っている鳴きの続きとみなせるか。
   *
   * **ビンの近さと周波数の近さの両方**を要求する。片方では足りない——ビンだけだと
   * 低域で緩くなりすぎ（声の基音が通る）、比だけだと高域で隣のビンへ次々に
   * 乗り移りながら追い続けてしまう。
   */
  private continues(cand: Candidate, bin: number, freqHz: number): boolean {
    if (Math.abs(cand.bin - bin) > 1) return false;
    return Math.abs(cand.freqHz - freqHz) / freqHz <= SAME_RUN_RATIO;
  }

  private track(cand: Candidate | null): void {
    if (this.active) {
      const mean = this.active.freqSum / this.active.freqCount;
      if (cand && this.continues(cand, this.active.bin, mean)) {
        this.active.bin = cand.bin;
        this.active.freqSum += cand.freqHz;
        this.active.freqCount++;
        this.active.lastFrame = this.frames;
        return;
      }
      // 一瞬の途切れで表示がちらつかないよう猶予を置く
      if (this.frames - this.active.lastFrame > GAP_FRAMES) this.closeActive();
      else return;
    }

    // runBin >= 0 なら runFrames >= 1（cand が無い回で両方とも落としている）
    if (cand && this.runBin >= 0
        && this.continues(cand, this.runBin, this.runFreqSum / this.runFrames)) {
      this.runFrames++;
      this.runFreqSum += cand.freqHz;
    } else if (cand) {
      this.runFrames = 1;
      this.runFreqSum = cand.freqHz;
    } else {
      this.runFrames = 0;
      this.runFreqSum = 0;
    }
    this.runBin = cand ? cand.bin : -1;

    if (this.runFrames >= SUSTAIN_FRAMES) {
      this.active = {
        bin: this.runBin,
        freqSum: this.runFreqSum,
        freqCount: this.runFrames,
        startFrame: this.frames - this.runFrames + 1,
        lastFrame: this.frames,
      };
      this.runBin = -1;
      this.runFrames = 0;
      this.runFreqSum = 0;
    }
  }

  /**
   * 鳴き終わった発振を履歴へ移す。
   *
   * 同じ周波数(±3%)は1行にまとめる。まとめないと、繰り返し鳴いているという
   * **利用者がこの道具を開いた理由そのもの**が、同じ行の重複で画面を埋めてしまう。
   * 回数として持てば「3回鳴いている」が情報になる。
   */
  private closeActive(): void {
    const a = this.active;
    if (!a) return;
    this.active = null;

    const freqHz = a.freqSum / a.freqCount;
    const band = bandOf(freqHz);
    if (band === null) return;
    const seconds = ((a.lastFrame - a.startFrame + 1) * FRAME_MS) / 1000;

    const idx = this.stored.findIndex(
      (e) => Math.abs(e.freqHz - freqHz) / e.freqHz <= SAME_FREQ_RATIO,
    );

    if (idx >= 0) {
      const e = this.stored[idx];
      // 秒数で重み付けする。長く鳴いたほうが周波数として確からしい
      const w = e.totalSeconds + seconds;
      e.freqHz = w > 0 ? (e.freqHz * e.totalSeconds + freqHz * seconds) / w : freqHz;
      e.bandHz = bandOf(e.freqHz) ?? e.bandHz;
      e.count++;
      e.totalSeconds = w;
      e.lastFrame = a.lastFrame;
      this.stored.splice(idx, 1);
      this.stored.unshift(e);
    } else {
      this.stored.unshift({
        freqHz, bandHz: band, count: 1, totalSeconds: seconds, lastFrame: a.lastFrame,
      });
      if (this.stored.length > MAX_EVENTS) this.stored.length = MAX_EVENTS;
    }
  }
}
