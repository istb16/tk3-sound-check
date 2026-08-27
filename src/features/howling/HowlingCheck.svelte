<script lang="ts">
  /**
   * ハウリングチェック。いま鳴いているのが何Hzかだけを出す。
   *
   * 画面の設計上の要点は「セッションの99%は待っている時間である」こと。
   * 発振の表示は数秒しか出ないので、**待っている画面こそがこの道具の画面**になる。
   * だから待っている間も 100ms ごとにバーが動き、道具が生きていることが見える。
   *
   * 状態は2つしか無い（聞いている / 発振中）。設計当初あった「注意」（突出はあるが
   * 持続していない）は作らなかった——咳・拍手・椅子の音で光り、周波数も出さないので
   * 行動に変換できない。待っている数分間に何度も光れば、画面を見るのをやめる。
   */
  import { onDestroy } from 'svelte';
  import type { Lang } from '../../shell/i18n.ts';
  import { DEFAULT_STALL_MS, MonitorSession } from '../../lib/audio/session.svelte.ts';
  import { T } from './i18n.ts';
  import { formatFrequency, ratio } from '../../lib/format.ts';
  import { formatOctaveBand } from '../../lib/dsp/octave.ts';
  import {
    BANDS_HZ, BAR_FULL_DB, HowlingDetector, PROMINENCE_DB,
    type HowlingEvent, type HowlingState,
  } from './detector.ts';

  let { lang }: { lang: Lang } = $props();
  const t = $derived(T[lang]);

  const EMPTY: HowlingState = {
    ringing: false, freqHz: null, bandHz: null, ringingSeconds: 0,
    bandProminenceDb: BANDS_HZ.map(() => 0), events: [], clipping: false, frames: 0,
  };

  let readout = $state<HowlingState>(EMPTY);
  /**
   * 中断する直前に捕まえていた周波数。
   *
   * 「止めたら何も残さない」のは**利用者が止めたとき**の話である。画面が消えて
   * 勝手に止まったときまで消すと、この道具を開いた理由そのものが消える。
   * ただし経過秒は捨てる——止まってから何分経ったか分からないのに「12秒前」と
   * 出すのが、この道具で最も避けたい誤読だから。
   */
  let frozenEvents = $state<HowlingEvent[]>([]);
  let detector: HowlingDetector | null = null;

  const session = new MonitorSession({
    // FFTのホップ長はサンプルレート依存なので、レートが確定してからでないと作れない
    onStart: ({ sampleRate }) => {
      detector = new HowlingDetector(sampleRate);
      frozenEvents = [];
    },
    onChunk: (chunk) => {
      if (detector?.push(chunk)) readout = detector.state;
    },
    onStop: (reason) => {
      // 鳴っている最中に画面が消えることがある。finish() で確定させないと、
      // **中断の瞬間に鳴っていた1件だけが落ちる**——記録を残す動機がまさに
      // それなので、一番肝心なものを捨てることになる
      frozenEvents = reason === 'user' ? [] : (detector?.finish().events ?? []);
      detector = null;
      readout = EMPTY;
    },
    // 「何も鳴っていない」と「何も測っていない」が同じ見た目になるのを防ぐ。
    // 画面が消えて AudioContext が止まったことに気づけないと、この道具は
    // 黙って嘘をつく
    stallMs: DEFAULT_STALL_MS,
    // 数分待つつもりの計測を端末のオートロックが殺すのを防ぐだけ。
    // 取れなくても失敗にしない
    wakeLock: true,
  });

  const state = $derived(session.state);

  const errorMsg = $derived(
    session.errorKind === 'mic-denied' ? t.errorMicDenied :
    session.errorKind === 'failed'     ? t.errorFailed(session.errorDetail) :
    ''
  );

  const start = (): void => { void session.start(); };
  const stop  = (): void => session.stop();

  onDestroy(() => session.dispose());

  const bandLabel = (hz: number): string => `${formatOctaveBand(hz)}${t.bandSuffix}`;

  /** 経過秒。1秒未満は「たった今」にする——0秒前は読んで意味が無い */
  const agoLabel = (sec: number): string => (sec < 1 ? t.agoJustNow : t.ago(sec));
</script>

{#if state === 'stalled'}
  <div class="narrow-wrap">
    <div class="panel" role="alert">
      <p class="panel-label stalled-label">{t.stalledTitle}</p>
      <p class="note">{t.stalledBody}</p>

      {#if frozenEvents.length > 0}
        <p class="section-label left">{t.frozenLabel}</p>
        <ul class="events">
          {#each frozenEvents as e (e.freqHz)}
            <li>
              <span class="ev-band">{bandLabel(e.bandHz)}</span>
              <span class="ev-freq">{formatFrequency(e.freqHz)}</span>
              <span class="ev-detail">{t.eventDetail(e.count, e.totalSeconds)}</span>
            </li>
          {/each}
        </ul>
        <p class="hint left">{t.frozenNote}</p>
      {/if}

      <button class="btn-primary" onclick={start}>{t.resumeBtn}</button>
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
    <div class="panel readout" class:alert={readout.ringing}>
      <p class="panel-label">{t.monitoring}</p>

      {#if readout.ringing && readout.bandHz !== null && readout.freqHz !== null}
        <p class="status ringing">{t.ringing}</p>
        <p class="big">
          {bandLabel(readout.bandHz)}
          <span class="slash">／</span>
          <span class="freq">{formatFrequency(readout.freqHz)}</span>
        </p>
        <p class="hint">{t.ringingFor(readout.ringingSeconds)}</p>
      {:else}
        <p class="status">{t.listening}</p>
        <p class="hint">{t.listeningHint}</p>
      {/if}

      {#if readout.clipping}
        <!-- 飽和すると広帯域の歪みが周辺の中央値を持ち上げ、突出度の分母が上がる。
             つまり鳴きが大きいほど検出しにくくなる。黙る代わりに申告する -->
        <p class="warn" role="alert">{t.clipWarn}</p>
      {/if}

      <!-- レベル(RTA)ではなく突出度。素直なレベルだと最も高いバーは常に
           人の声の帯域になり、検出しているものがバーに現れない -->
      <p class="section-label">{t.barsLabel}</p>
      <div class="bars" aria-hidden="true">
        {#each BANDS_HZ as hz, i (hz)}
          <div class="bar-col" class:hot={readout.bandProminenceDb[i] >= PROMINENCE_DB}>
            <div class="bar-track">
              <div class="bar-fill" style="height: {ratio(readout.bandProminenceDb[i], BAR_FULL_DB) * 100}%"></div>
              <div class="bar-threshold" style="bottom: {(PROMINENCE_DB / BAR_FULL_DB) * 100}%"></div>
            </div>
            <span class="bar-name">{formatOctaveBand(hz)}</span>
          </div>
        {/each}
      </div>

      <p class="section-label">{t.historyLabel}</p>
      {#if readout.events.length === 0}
        <p class="hint left">{t.historyEmpty}</p>
      {:else}
        <ul class="events">
          {#each readout.events as e (e.freqHz)}
            <li>
              <span class="ev-band">{bandLabel(e.bandHz)}</span>
              <span class="ev-freq">{formatFrequency(e.freqHz)}</span>
              <span class="ev-detail">{t.eventDetail(e.count, e.totalSeconds)}</span>
              <!-- 経過秒は必ず添える。これが無いと「12秒前」と「3分前」が
                   同じ見た目になり、古い数字を現在と読み違える -->
              <span class="ev-ago">{agoLabel(e.agoSeconds)}</span>
            </li>
          {/each}
        </ul>
      {/if}

      <p class="device">{t.deviceLabel}: {session.deviceLabel || t.deviceUnknown}</p>
      <p class="passive">{t.passiveNote}</p>
    </div>

    <div class="actions">
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
  .section-label.left { margin-top: 1rem; }

  .readout { text-align: center; }
  .readout .panel-label { text-align: left; margin-bottom: 0.8rem; }
  .readout.alert { border-color: #B00020; }

  .status {
    font-size: 0.95rem;
    font-weight: 700;
    letter-spacing: 0.02em;
    color: var(--muted);
  }

  .status.ringing { color: #B00020; }

  /* 周波数が主役。会場では一目で読めることがすべて */
  .big {
    margin-top: 0.3rem;
    font-size: 2.4rem;
    font-weight: 900;
    letter-spacing: -0.03em;
    line-height: 1.1;
    font-variant-numeric: tabular-nums;
    color: var(--ink);
  }

  .slash { font-size: 1.2rem; color: var(--muted); margin: 0 0.2rem; }
  .freq  { font-size: 1.6rem; }

  .hint {
    margin-top: 0.5rem;
    font-size: 0.76rem;
    line-height: 1.6;
    color: var(--muted);
  }

  .hint.left { text-align: left; }

  .warn {
    margin-top: 0.7rem;
    padding: 0.5rem 0.6rem;
    border: 1px solid #B00020;
    border-radius: 4px;
    font-size: 0.74rem;
    line-height: 1.6;
    color: #B00020;
    text-align: left;
  }

  .section-label {
    margin-top: 1.2rem;
    font-size: 0.6rem;
    font-weight: 700;
    letter-spacing: 0.12em;
    color: var(--muted);
    text-transform: uppercase;
    text-align: left;
  }

  .bars {
    margin-top: 0.5rem;
    display: flex;
    gap: 0.35rem;
    align-items: flex-end;
  }

  .bar-col { flex: 1; }

  .bar-track {
    position: relative;
    height: 84px;
    background: #E3E5EF;
    border-radius: 2px;
    overflow: hidden;
  }

  .bar-fill {
    position: absolute;
    left: 0;
    bottom: 0;
    width: 100%;
    background: var(--accent);
    transition: height 0.06s linear;
  }

  .hot .bar-fill { background: #B00020; }

  /* 閾値の線。バーが伸びていくのが「どこに向かって」なのかが見える。
     これは測定値の提示であって「危険」という断定ではない */
  .bar-threshold {
    position: absolute;
    left: 0;
    width: 100%;
    height: 1px;
    background: var(--muted);
    opacity: 0.6;
  }

  .bar-name {
    display: block;
    margin-top: 0.25rem;
    font-size: 0.6rem;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }

  .events {
    margin-top: 0.4rem;
    list-style: none;
    text-align: left;
  }

  .events li {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    padding: 0.45rem 0;
    border-bottom: 1px solid var(--line);
    font-variant-numeric: tabular-nums;
  }

  .events li:last-child { border-bottom: none; }

  .ev-band { font-size: 0.95rem; font-weight: 800; color: var(--ink); }
  .ev-freq { font-size: 0.82rem; font-weight: 700; color: var(--body); }
  .ev-detail { font-size: 0.7rem; color: var(--muted); }
  .ev-ago { margin-left: auto; font-size: 0.7rem; color: var(--muted); }

  .device {
    margin-top: 1rem;
    font-size: 0.7rem;
    color: var(--muted);
    text-align: left;
    word-break: break-word;
  }

  .passive {
    margin-top: 0.35rem;
    font-size: 0.68rem;
    line-height: 1.5;
    color: var(--muted);
    text-align: left;
  }

  .actions { margin-top: 1.1rem; }
</style>
