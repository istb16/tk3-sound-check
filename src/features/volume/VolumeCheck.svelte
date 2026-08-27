<script lang="ts">
  /**
   * ボリュームチェック。会場のPA音を拾って、ミキサーで動かした量を数値で見る。
   *
   * 音質チェックとは形が違う。終わりが無く、点数も無く、停止しても何も残らない。
   * だから AppState（idle/recording/analyzing/done）は共有しない。
   */
  import { onDestroy } from 'svelte';
  import type { Lang } from '../../shell/i18n.ts';
  import { DEFAULT_STALL_MS, MonitorSession } from '../../lib/audio/session.svelte.ts';
  import { T } from './i18n.ts';
  import { formatSigned } from '../../lib/format.ts';
  import {
    VolumeMeter, barRatio, FLOOR_DB, LEQ_WINDOW_SEC,
    type MeterState,
  } from './level.ts';

  let { lang }: { lang: Lang } = $props();
  const t = $derived(T[lang]);

  let instantDb   = $state(FLOOR_DB);
  let leqDb       = $state(FLOOR_DB);
  let peakHoldDb  = $state(FLOOR_DB);
  let clipSeconds = $state(0);
  let leqReady    = $state(false);
  let warmupSec   = $state(LEQ_WINDOW_SEC);

  /** 基準にした時点の Leq。null なら未設定 */
  let reference = $state<number | null>(null);
  /** 再開時に別のマイクが開いたため基準を捨てたか */
  let referenceDropped = $state(false);

  let meter: VolumeMeter | null = null;

  // マイクの開閉と失敗の分類は共有の状態機械に任せる。ここが持つのは測定だけ
  const session = new MonitorSession({
    // A特性の係数はサンプルレート依存なので、レートが確定してからでないと作れない
    onStart: ({ sampleRate, deviceLabel, previousDeviceLabel }) => {
      meter = new VolumeMeter(sampleRate);
      // 中断からの再開で別のマイクが開いていたら、中断前の基準はもう比較に使えない。
      // 感度が違う機材の値を引き算しても意味の無い数字が出るだけである
      if (previousDeviceLabel && previousDeviceLabel !== deviceLabel) {
        reference = null;
        referenceDropped = true;
      }
    },
    onChunk: (chunk) => {
      if (meter?.push(chunk)) applyState(meter.state);
    },
    onStop: (reason) => {
      meter = null;
      instantDb   = leqDb = peakHoldDb = FLOOR_DB;
      clipSeconds = 0;
      leqReady    = false;
      warmupSec   = LEQ_WINDOW_SEC;
      // 中断（stalled）でも起動失敗（failed）でも基準を捨てない。同じ端末・
      // 同じ場所なら、再開しても基準はそのまま比較に使える——そして中断中に
      // 会場の状態は変わっているので、捨てると「さっきと比べてどうか」を
      // 取り戻す手立てが無くなる。**「基準は保持しています」と出した直後に
      // 再開が失敗して黙って捨てる**のが、いちばん質の悪い裏切り方になる
      if (reason === 'user') { reference = null; referenceDropped = false; }
    },
    // 画面が消えて計測が止まったとき、固まった「+3.5dB」は正しい測定値と
    // 見分けがつかない。そのままフェーダーを動かされるのが最悪の結末なので、
    // 止まったことを必ず出す
    stallMs: DEFAULT_STALL_MS,
    // 数分の計測を端末のオートロックが殺すのを防ぐだけ。取れなくても失敗にしない
    wakeLock: true,
  });

  const state = $derived(session.state);
  const deviceLabel = $derived(session.deviceLabel);

  /**
   * 画面に dB を出してよいか。**規則はこれ一本にする。**
   *
   * 校正されていない絶対 dBFS は単独では何も指していない。意味を持つのは差だけで、
   * 差が正しいのは 10秒窓が埋まっているときだけである。中断からの再開では基準を
   * 持ち越すが解析器は作り直すので、**基準があっても窓は空**——そのまま差を出すと
   * フェーダーを触っていないのに `+7.3 dB` が出て、10秒かけて真値に寄っていく。
   * 基準前の `-32.8`（意味が無いだけ）より質が悪い、意味のある形をした嘘になる。
   */
  const showDb = $derived(leqReady && reference !== null);

  const diffDb = $derived(showDb && reference !== null ? leqDb - reference : null);

  // 文面ではなく種別で持つ。言語を切り替えたときにエラー行だけ元の言語で残らないように
  const errorMsg = $derived(
    session.errorKind === 'mic-denied' ? t.errorMicDenied :
    session.errorKind === 'failed'     ? t.errorFailed(session.errorDetail) :
    ''
  );

  function applyState(s: MeterState): void {
    instantDb   = s.instantDb;
    leqDb       = s.leqDb;
    peakHoldDb  = s.peakHoldDb;
    clipSeconds = s.clipSeconds;
    leqReady    = s.leqReady;
    warmupSec   = s.warmupRemainingSec;
  }

  const start = (): void => { referenceDropped = false; void session.start(); };

  /** 基準を取り直したら、破棄の断りは役目を終える（残すと数値と矛盾する） */
  function setReference(): void {
    reference = leqDb;
    referenceDropped = false;
  }
  /** 中断からの再開。基準は持ち越す（別のマイクなら onStart が捨てる） */
  const resume = (): void => { void session.start(); };
  const stop  = (): void => session.stop();

  // 画面を離れたらマイクを必ず閉じる。録音インジケータが点いたままになるのは事故
  onDestroy(() => session.dispose());

  const fmt = (db: number): string => (db <= FLOOR_DB ? '--' : db.toFixed(1));
</script>

{#if state === 'stalled'}
  <div class="narrow-wrap">
    <div class="panel" role="alert">
      <p class="panel-label stalled-label">{t.stalledTitle}</p>
      <p class="note">{t.stalledBody}</p>
      {#if reference !== null}
        <p class="kept">{t.stalledKeepsReference}</p>
      {/if}
      <button class="btn-primary" onclick={resume}>{t.resumeBtn}</button>
    </div>
    <div class="actions">
      <button class="btn-quiet" onclick={stop}>{t.stopBtn}</button>
    </div>
  </div>
{:else if state !== 'listening'}
  <div class="narrow-wrap">
    <div class="panel">
      <p class="note">{t.note}</p>
      {#if state === 'error'}
        <p class="error" role="alert">{errorMsg}</p>
      {/if}
      <button class="btn-primary" onclick={start} disabled={state === 'starting'}>
        {state === 'error' ? t.retryBtn : t.startBtn}
      </button>
    </div>
  </div>
{:else}
  <div class="narrow-wrap">
    <div class="panel readout">
      <p class="panel-label">{t.measuring}</p>

      {#if referenceDropped}
        <p class="error" role="alert">{t.referenceDropped}</p>
      {/if}

      <!-- 主役の位置は常に埋める。①待ち→②基準待ち→③差 と移るとき、途中で
           空くと「終わってしまった」と読まれる -->
      {#if !leqReady}
        <p class="state-title">{t.warmingUpTitle}</p>
        <p class="big big-count">{t.warmingUpRemaining(Math.ceil(warmupSec))}</p>
        {#if reference !== null}
          <!-- 再開直後。差は出せないが、基準が生きていることは伝える -->
          <p class="hint">{t.stalledKeepsReference}</p>
        {/if}
      {:else if diffDb === null}
        <p class="state-title">{t.setReferenceTitle}</p>
        <p class="hint">{t.noReference}</p>
      {:else}
        <p class="big" class:up={diffDb > 0.05} class:down={diffDb < -0.05}>
          {formatSigned(diffDb)}<span class="unit">dB</span>
        </p>
        <p class="leq-note">{t.leqNote}</p>
      {/if}

      <div class="meter" aria-hidden="true">
        <div class="meter-fill" style="width: {barRatio(instantDb) * 100}%"></div>
        {#if peakHoldDb > FLOOR_DB}
          <div class="meter-peak" style="left: {barRatio(peakHoldDb) * 100}%"></div>
        {/if}
      </div>
      <p class="peak-row">
        <span>{t.peakLabel}</span>
        <!-- 差を出していない間は画面に dB を残さない。主役を隠して脇に dB が
             1つだけあると、それが「いまのレベル」として読まれる -->
        <span class="mono">{showDb ? `${fmt(peakHoldDb)} dB` : '--'}</span>
      </p>

      <p class="clip-row" class:clipping={clipSeconds > 0}>
        <span>{t.clipLabel}</span>
        <span class="mono">{clipSeconds > 0 ? t.clipDuration(clipSeconds) : t.clipNone}</span>
      </p>

      <p class="device">
        {t.deviceLabel}: {deviceLabel || t.deviceUnknown}
      </p>
      <p class="relative-note">{t.relativeNote}</p>
    </div>

    <div class="actions">
      {#if reference === null}
        <!-- 窓が埋まる前の Leq を基準にすると、現在値だけが収束していって
             フェーダーを触っていないのに差が出る -->
        <button class="btn-primary" onclick={setReference} disabled={!leqReady}>
          {t.setReferenceBtn}
        </button>
      {:else}
        <button class="btn-quiet" onclick={() => (reference = null)}>{t.clearReferenceBtn}</button>
      {/if}
      <button class="btn-quiet" onclick={stop}>{t.stopBtn}</button>
    </div>
  </div>
{/if}

<style>
  .note {
    font-size: 0.84rem;
    line-height: 1.8;
    color: var(--body);
    white-space: pre-line;
  }

  .error {
    margin-top: 0.9rem;
    font-size: 0.82rem;
    line-height: 1.6;
    color: #B00020;
  }

  .btn-primary {
    width: 100%;
    margin-top: 1.1rem;
    padding: 0.85rem;
    background: var(--ink);
    color: #ECEEF5;
    border: 1px solid var(--ink);
    border-radius: 6px;
    font-size: 0.9rem;
    font-weight: 700;
    cursor: pointer;
  }

  .btn-primary:disabled { opacity: 0.4; cursor: default; }
  .btn-primary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  .stalled-label { color: #B00020; }

  .kept {
    margin-top: 0.7rem;
    font-size: 0.78rem;
    color: var(--body);
  }

  .readout { text-align: center; }
  .readout .panel-label { text-align: left; margin-bottom: 0.8rem; }

  /* 変化量が主役。会場では一目で読めることがすべて */
  .big {
    font-size: 3.2rem;
    font-weight: 900;
    letter-spacing: -0.04em;
    line-height: 1;
    font-variant-numeric: tabular-nums;
    color: var(--ink);
  }

  .big.up   { color: #B00020; }
  .big.down { color: #006E80; }
  /* 残り秒数。基準を取る前の主役はこれになる */
  .big-count { font-size: 2.6rem; }

  .state-title {
    font-size: 1rem;
    font-weight: 700;
    color: var(--ink);
  }

  .state-title + .big-count { margin-top: 0.35rem; }

  .unit {
    font-size: 0.9rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    margin-left: 0.3rem;
    color: var(--muted);
  }

  .hint {
    margin-top: 0.7rem;
    font-size: 0.78rem;
    line-height: 1.6;
    color: var(--muted);
  }

  .leq-note {
    margin-top: 0.7rem;
    font-size: 0.68rem;
    color: var(--muted);
  }

  .meter {
    position: relative;
    margin-top: 1.1rem;
    height: 12px;
    background: #E3E5EF;
    border-radius: 2px;
    overflow: hidden;
  }

  .meter-fill {
    height: 100%;
    background: var(--accent);
    transition: width 0.06s linear;
  }

  .meter-peak {
    position: absolute;
    top: 0;
    width: 2px;
    height: 100%;
    background: var(--ink);
  }

  .peak-row,
  .clip-row {
    display: flex;
    justify-content: space-between;
    margin-top: 0.5rem;
    font-size: 0.72rem;
    color: var(--muted);
  }

  .clip-row.clipping { color: #B00020; font-weight: 700; }

  .mono { font-variant-numeric: tabular-nums; }

  .device {
    margin-top: 0.9rem;
    font-size: 0.7rem;
    color: var(--muted);
    text-align: left;
    word-break: break-word;
  }

  .relative-note {
    margin-top: 0.35rem;
    font-size: 0.68rem;
    line-height: 1.5;
    color: var(--muted);
    text-align: left;
  }

  .actions {
    margin-top: 1.1rem;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
</style>
