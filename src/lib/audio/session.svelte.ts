/**
 * 受動リアルタイム機能のマイク状態機械。
 *
 * ボリュームチェックとハウリングチェックが共有する。ここに入っているのは
 * 「マイクを開いて、閉じて、失敗を分類する」だけで、解析は一切知らない——
 * 解析パイプラインは機能ごとに独立させる（docs/design/realtime-monitor.md）。
 *
 * 切り出した理由は行数ではなく、**間違えても気づきにくい**からである。
 * 二重に開始ボタンを押されるとマイクが2本開く、許可ダイアログが出ている間に
 * 画面を離れられるとマイクが開きっぱなしになる、古い起動から届くチャンクが
 * 新しい解析器に混ざる——どれも動かして気づけない種類の壊れ方で、
 * 書き写すと写し間違いにも気づけない。
 *
 * フレーム化と移動窓は `lib/stream/frames.ts` にあるが、**何を積むかは
 * 共通化していない**。ボリュームは波形を捨てて二乗和だけ持てばよく、
 * ハウリングはFFTのために波形を4096点保持する必要がある。
 */

import { startMonitor, type Monitor } from './capture.ts';

/**
 * 状態。`stalled` は「利用者は止めていないのに計測が止まった」——
 * 端末の画面が消えて `AudioContext` が止まったときに入る。
 */
export type MonitorState = 'idle' | 'starting' | 'listening' | 'stalled' | 'error';

/**
 * 文面ではなく種別で持つ。文面で持つと、言語を切り替えたときにエラー行だけ
 * 元の言語で残る。
 */
export type MonitorErrorKind = '' | 'mic-denied' | 'failed';

/**
 * 計測が止まった理由。解析器を捨てるかどうかを機能側が決めるために渡す。
 *
 * `failed` を `user` と分けているのは、**起動に失敗しただけで、利用者は
 * 止めていない**からである。中断からの再開に失敗したときにこれを `user` と
 * 扱うと、「基準は保持しています」と約束した直後にその基準を黙って捨てることになる。
 */
export type StopReason = 'user' | 'stalled' | 'failed';

/**
 * チャンクが途切れたと判断するまでの時間[ms]。
 *
 * ワークレットは 4096サンプルごと（48kHzで約85ms）に届くので、これは
 * 17回ぶんの取りこぼしにあたる。短くすると、タブの切り替えや GC の一瞬の
 * 詰まりで計測を止めてしまう。長くすると、止まったことに気づくのが遅れる。
 */
export const DEFAULT_STALL_MS = 1500;

export interface MonitorStartContext {
  sampleRate: number;
  deviceLabel: string;
  /**
   * 直前に開いていたマイク名。中断からの再開でなければ空文字。
   *
   * 再開したときに**同じ機材が戻ってきたか**を機能側が確かめるためにある。
   * 違う機材なら、中断前に取った基準値はもう比較に使えない。
   */
  previousDeviceLabel: string;
}

export interface MonitorSessionOptions {
  /**
   * マイクが開けた直後、サンプルレートが確定してから一度だけ呼ばれる。
   * 解析器はここで作る——A特性の係数もFFTのホップ長もレート依存なので、
   * レートが確定する前には作れない。
   */
  onStart: (ctx: MonitorStartContext) => void;
  /** onStart のあとだけ届く。古い起動のチャンクは渡らない */
  onChunk: (chunk: Float32Array) => void;
  /**
   * 停止時。解析器を捨てる。
   *
   * `reason` を渡すのは、中断は停止と同じではないからである。利用者が止めたなら
   * 全部捨ててよいが、中断なら「再開したら続きから読みたいもの」が機能側にある。
   */
  onStop: (reason: StopReason) => void;
  /**
   * チャンクの途切れを見張るか。指定するとこの時間[ms]届かなかった時点で
   * マイクを閉じ、状態を `stalled` にする。
   *
   * **「何も起きていない」と「何も測っていない」が同じ見た目になるのを防ぐ**
   * ための仕掛けである。固まった数字は、正しい測定値と見分けがつかない。
   */
  stallMs?: number;
  /**
   * 画面の自動ロックを抑止するか。best-effort であり、取れなくても失敗にしない。
   * 長時間運用のための機能ではない——数分待つつもりの計測を、端末の
   * 30秒オートロックが黙って殺すのを防ぐだけ。
   */
  wakeLock?: boolean;
}

interface WakeLockLike {
  release: () => Promise<void>;
}

/**
 * 開始・停止・中断・失敗だけを持つ。値の表示は各機能が自分の $state に写して行う。
 */
export class MonitorSession {
  state = $state<MonitorState>('idle');
  errorKind = $state<MonitorErrorKind>('');
  errorDetail = $state('');
  /** 実際に開いたマイクの名前。測定対象を取り違えたまま数字を出さないため */
  deviceLabel = $state('');
  /** 中断前に開いていたマイク名。`stalled` の間だけ残る */
  interruptedDeviceLabel = $state('');

  private readonly opts: MonitorSessionOptions;
  private monitor: Monitor | null = null;
  private started = false;
  /** 破棄済みか。await の途中で画面を離れられたときにマイクを閉じるため */
  private disposed = false;
  /** 起動ごとに増やす。古い起動から届くチャンクと Wake Lock を捨てる */
  private token = 0;
  private lastChunkAt = 0;
  private stallTimer: ReturnType<typeof setInterval> | null = null;
  private wakeLock: WakeLockLike | null = null;

  constructor(opts: MonitorSessionOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    // 二重に押されるとマイクが2本開く。listening 中の再起動も同じ事故になる
    if (this.state === 'starting' || this.state === 'listening') return;
    this.errorKind = '';
    this.errorDetail = '';
    this.state = 'starting';
    const token = ++this.token;

    try {
      const m = await startMonitor((chunk) => {
        // 解析器が出来るまでの数ms分と、古い起動のぶんは捨てる
        if (token !== this.token || !this.started) return;
        this.lastChunkAt = performance.now();
        this.opts.onChunk(chunk);
      });

      // 許可ダイアログが出ている間に画面を離れられた場合。
      // ここで閉じないとマイクが開きっぱなしになる
      if (this.disposed || token !== this.token) { m.stop(); return; }

      this.monitor = m;
      this.opts.onStart({
        sampleRate: m.sampleRate,
        deviceLabel: m.deviceLabel,
        previousDeviceLabel: this.interruptedDeviceLabel,
      });
      this.started = true;
      this.deviceLabel = m.deviceLabel;
      this.interruptedDeviceLabel = '';
      this.state = 'listening';
      this.beginStallWatch();
      void this.acquireWakeLock(token);
    } catch (e) {
      if (this.disposed || token !== this.token) return;
      this.teardown('failed');
      this.state = 'error';
      if (e instanceof Error && e.name === 'NotAllowedError') {
        this.errorKind = 'mic-denied';
      } else {
        this.errorKind = 'failed';
        this.errorDetail = e instanceof Error ? e.message : String(e);
      }
    }
  }

  /** 利用者が止めた。何も残さない */
  stop(): void {
    this.interruptedDeviceLabel = '';
    this.teardown('user');
    if (this.state !== 'error') this.state = 'idle';
  }

  /** 画面を離れるとき。録音インジケータが点いたままになるのは事故 */
  dispose(): void {
    this.disposed = true;
    this.stop();
  }

  /**
   * 計測が途切れた。マイクを閉じて `stalled` に入る。
   *
   * 開いたまま「止まっています」と出すのではなく閉じるのは、再開したときに
   * **必ず作り直した解析器で測り直す**ためである。途切れた前後のフレームが
   * 同じ移動窓に混ざると、10秒平均が実時間の何分にもまたがった値になる。
   */
  private halt(): void {
    const label = this.deviceLabel;
    this.teardown('stalled');
    this.interruptedDeviceLabel = label;
    this.state = 'stalled';
  }

  private teardown(reason: StopReason): void {
    this.token++; // 起動途中のものがあれば無効にする
    this.monitor?.stop();
    this.monitor = null;
    this.started = false;
    this.deviceLabel = '';
    this.endStallWatch();
    this.releaseWakeLock();
    this.opts.onStop(reason);
  }

  // ---- チャンクの途切れ ----

  private beginStallWatch(): void {
    const limit = this.opts.stallMs;
    if (!limit) return;
    this.lastChunkAt = performance.now();
    this.stallTimer = setInterval(() => {
      if (performance.now() - this.lastChunkAt > limit) this.halt();
    }, Math.max(100, Math.round(limit / 3)));
  }

  private endStallWatch(): void {
    if (this.stallTimer !== null) clearInterval(this.stallTimer);
    this.stallTimer = null;
  }

  // ---- 画面の自動ロック抑止（best-effort） ----

  private async acquireWakeLock(token: number): Promise<void> {
    if (!this.opts.wakeLock) return;
    const nav = navigator as Navigator & {
      wakeLock?: { request: (type: 'screen') => Promise<WakeLockLike> };
    };
    if (!nav.wakeLock) return;
    try {
      const lock = await nav.wakeLock.request('screen');
      // 取れた頃には別の起動に入れ替わっていることがある。状態ではなく
      // トークンで見る——「また listening になっている」は同じ起動を意味しない
      if (token !== this.token) { void lock.release().catch(() => {}); return; }
      this.wakeLock = lock;
    } catch {
      // 取れないことは普通にある。失敗にしない
    }
  }

  private releaseWakeLock(): void {
    this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
  }
}
