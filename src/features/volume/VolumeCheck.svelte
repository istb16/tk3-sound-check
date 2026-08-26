<script lang="ts">
  /**
   * ボリュームチェック。会場のPA音を拾って、ミキサーで動かした量を数値で見る。
   *
   * 音質チェックとは形が違う。終わりが無く、点数も無く、停止しても何も残らない。
   * だから AppState（idle/recording/analyzing/done）は共有しない。
   */
  import { onDestroy } from 'svelte';
  import type { Lang } from '../../shell/i18n.ts';
  import { startMonitor, type Monitor } from '../../lib/audio.ts';
  import { T } from './i18n.ts';
  import {
    VolumeMeter, barRatio, formatDiff, FLOOR_DB, LEQ_WINDOW_SEC,
    type MeterState,
  } from './level.ts';

  let { lang }: { lang: Lang } = $props();
  const t = $derived(T[lang]);

  type State = 'idle' | 'starting' | 'listening' | 'error';
  type ErrorKind = '' | 'mic-denied' | 'failed';

  let state       = $state<State>('idle');
  let errorKind   = $state<ErrorKind>('');
  let errorDetail = $state('');
  let deviceLabel = $state('');

  let instantDb   = $state(FLOOR_DB);
  let leqDb       = $state(FLOOR_DB);
  let peakHoldDb  = $state(FLOOR_DB);
  let clipSeconds = $state(0);
  let leqReady    = $state(false);
  let warmupSec   = $state(LEQ_WINDOW_SEC);

  /** 基準にした時点の Leq。null なら未設定 */
  let reference = $state<number | null>(null);

  let monitor: Monitor | null = null;
  let meter: VolumeMeter | null = null;
  /** 破棄済みか。await の途中で画面を離れられたときにマイクを閉じるため */
  let disposed = false;
  /** 起動ごとに増やす。古い起動から届くチャンクを捨てる */
  let session = 0;

  const diffDb = $derived(reference === null ? null : leqDb - reference);

  // 文面ではなく種別で持つ。言語を切り替えたときにエラー行だけ元の言語で残らないように
  const errorMsg = $derived(
    errorKind === 'mic-denied' ? t.errorMicDenied :
    errorKind === 'failed'     ? t.errorFailed(errorDetail) :
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

  async function start(): Promise<void> {
    if (state === 'starting') return; // 二重に押されるとマイクが2本開く
    errorKind   = '';
    errorDetail = '';
    state = 'starting';
    const token = ++session;

    try {
      const m = await startMonitor((chunk) => {
        // メーターが出来るまでの数ms分と、古い起動のぶんは捨てる。
        // A特性の係数はサンプルレート依存なので、AudioContext のレートが
        // 確定してからでないとメーターを作れない
        if (token !== session || !meter) return;
        if (meter.push(chunk)) applyState(meter.state);
      });

      // 許可ダイアログが出ている間に画面を離れられた場合。
      // ここで閉じないとマイクが開きっぱなしになる
      if (disposed || token !== session) { m.stop(); return; }

      monitor     = m;
      meter       = new VolumeMeter(m.sampleRate);
      deviceLabel = m.deviceLabel;
      state = 'listening';
    } catch (e) {
      if (disposed || token !== session) return;
      stop();
      if (e instanceof Error && e.name === 'NotAllowedError') {
        errorKind = 'mic-denied';
      } else {
        errorKind   = 'failed';
        errorDetail = e instanceof Error ? e.message : String(e);
      }
      state = 'error';
    }
  }

  function stop(): void {
    session++; // 起動途中のものがあれば無効にする
    monitor?.stop();
    monitor = null;
    meter   = null;
    reference   = null;
    instantDb   = leqDb = peakHoldDb = FLOOR_DB;
    clipSeconds = 0;
    leqReady    = false;
    warmupSec   = LEQ_WINDOW_SEC;
    deviceLabel = '';
    if (state === 'listening' || state === 'starting') state = 'idle';
  }

  // 画面を離れたらマイクを必ず閉じる。録音インジケータが点いたままになるのは事故
  onDestroy(() => { disposed = true; stop(); });

  const fmt = (db: number): string => (db <= FLOOR_DB ? '--' : db.toFixed(1));
</script>

{#if state !== 'listening'}
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

      {#if diffDb === null}
        <p class="big big-current">{fmt(leqDb)}<span class="unit">dB</span></p>
        <p class="hint">{t.noReference}</p>
      {:else}
        <p class="big" class:up={diffDb > 0.05} class:down={diffDb < -0.05}>
          {formatDiff(diffDb)}<span class="unit">dB</span>
        </p>
        <dl class="values">
          <div><dt>{t.referenceLabel}</dt><dd>{fmt(reference ?? FLOOR_DB)} dB</dd></div>
          <div><dt>{t.currentLabel}</dt><dd>{fmt(leqDb)} dB</dd></div>
        </dl>
      {/if}

      <p class="leq-note" class:pending={!leqReady}>
        {leqReady ? t.leqNote : t.warmingUp(Math.ceil(warmupSec))}
      </p>

      <div class="meter" aria-hidden="true">
        <div class="meter-fill" style="width: {barRatio(instantDb) * 100}%"></div>
        {#if peakHoldDb > FLOOR_DB}
          <div class="meter-peak" style="left: {barRatio(peakHoldDb) * 100}%"></div>
        {/if}
      </div>
      <p class="peak-row">
        <span>{t.peakLabel}</span>
        <span class="mono">{fmt(peakHoldDb)} dB</span>
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
        <button class="btn-primary" onclick={() => (reference = leqDb)} disabled={!leqReady}>
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
  .big-current { font-size: 2.6rem; }

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

  .values {
    margin-top: 0.9rem;
    display: flex;
    justify-content: center;
    gap: 1.6rem;
  }

  .values dt {
    font-size: 0.6rem;
    font-weight: 700;
    letter-spacing: 0.1em;
    color: var(--muted);
    text-transform: uppercase;
  }

  .values dd {
    font-size: 0.95rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    color: var(--ink);
  }

  .leq-note {
    margin-top: 0.7rem;
    font-size: 0.68rem;
    color: var(--muted);
  }

  /* 窓が埋まるまでの値は参考値なので、そうと分かる見た目にする */
  .leq-note.pending { opacity: 0.5; }

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
