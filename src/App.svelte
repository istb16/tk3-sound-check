<script lang="ts">
  import { analyzeAudio, type AudioScores, type AdviceCode } from './lib/AudioAnalyzer.ts';
  import { decodeFile, recordMicrophone } from './lib/audio.ts';

  import { T, initLang, type Lang } from './lib/i18n.ts';
  import { LABELS } from './lib/scores.ts';
  import RadarChart from './lib/RadarChart.svelte';
  import LangToggle from './lib/LangToggle.svelte';
  import AudioInput from './lib/AudioInput.svelte';
  import VuMeter from './lib/VuMeter.svelte';
  import ScoreBreakdown from './lib/ScoreBreakdown.svelte';
  import VerdictPanel from './lib/VerdictPanel.svelte';
  import StatusPanel from './lib/StatusPanel.svelte';
  import AudioPlayer from './lib/AudioPlayer.svelte';

  const RECORD_DURATION = 10000;

  type AppState = 'idle' | 'recording' | 'analyzing' | 'done' | 'error';
  type ErrorKey = '' | 'invalid-file' | 'analysis-failed' | 'mic-denied' | 'recording-failed';

  let lang = $state<Lang>(initLang());
  $effect(() => { try { localStorage.setItem('aqc-lang', lang); } catch {} });
  const t = $derived(T[lang]);

  let state          = $state<AppState>('idle');
  let scores         = $state<AudioScores | null>(null);
  let errorType      = $state<ErrorKey>('');
  let errorDetail    = $state('');
  let recordProgress = $state(0);
  let audioUrl       = $state<string | null>(null);
  /** 生PCMで録れたか。false なら圧縮経由なのでノイズ系のスコアは参考値 */
  let rawCapture     = $state(true);
  /**
   * 分析したものの入手経路。加工痕跡が出たときの案内を分けるために持つ。
   *
   * ファイルなら「このツールのマイク録音を使って」で解決するが、マイク録音でも
   * 痕跡が出る場合は OS やドライバの処理なので、同じ案内では手詰まりになる。
   * 実録音（Windows標準のサウンドレコーダー）でゲート痕跡を確認して気づいた。
   */
  let source         = $state<'mic' | 'file'>('file');

  // 加工の痕跡に関する警告。スコアは変えず、総合点より前に提示する。
  const provWarnings = $derived.by(() => {
    if (!scores) return [];
    const p = scores.provenance;
    const msgs: string[] = [];
    if (p.flags.includes('band-limited'))    msgs.push(t.provenanceBandLimited(p.bandwidthHz));
    if (p.flags.includes('digital-silence')) msgs.push(t.provenanceDigitalSilence);
    if (p.flags.includes('zero-run'))        msgs.push(t.provenanceZeroRun);
    if (!rawCapture)                         msgs.push(t.provenanceRawFallback);
    return msgs;
  });

  // 加工痕跡が出たときの導入文。経路によって案内する先が違う。
  const provIntro = $derived(source === 'mic' ? t.provenanceIntroMic : t.provenanceIntro);

  // 信用できない軸は分析側が判定する。取り込み経路の劣化だけはUI側の情報なので足す。
  const unreliable = $derived.by(() => {
    if (!scores) return [];
    const axes = new Set(scores.unreliable);
    if (!rawCapture) { axes.add('noise'); axes.add('reverb'); }
    return [...axes];
  });

  const errorMsg = $derived(
    errorType === 'invalid-file'     ? t.errorInvalidFile :
    errorType === 'analysis-failed'  ? t.errorAnalysis(errorDetail) :
    errorType === 'mic-denied'       ? t.errorMicDenied :
    errorType === 'recording-failed' ? t.errorRecording(errorDetail) :
    ''
  );

  async function handleFile(file: File): Promise<void> {
    if (!file.type.match(/audio/i) && !file.name.match(/\.(wav|mp3|ogg|webm|flac|aac)$/i)) {
      errorType = 'invalid-file'; errorDetail = '';
      state = 'error'; return;
    }
    state = 'analyzing'; errorType = '';
    rawCapture = true; // ファイル入力は復号のみ。取り込み経路による劣化はない
    source = 'file';
    const url = URL.createObjectURL(file);
    try {
      scores = await analyzeAudio(await decodeFile(file));
      audioUrl = url;
      state = 'done';
    } catch (e) {
      URL.revokeObjectURL(url);
      errorType = 'analysis-failed';
      errorDetail = e instanceof Error ? e.message : String(e);
      state = 'error';
    }
  }

  async function startRecording(): Promise<void> {
    state = 'recording'; errorType = ''; errorDetail = ''; recordProgress = 0;
    try {
      const rec = await recordMicrophone(RECORD_DURATION, (p) => { recordProgress = p; });
      const { buffer, blob } = rec;
      rawCapture = rec.rawCapture;
      source = 'mic';
      state = 'analyzing';
      scores = await analyzeAudio(buffer);
      audioUrl = URL.createObjectURL(blob);
      state = 'done';
    } catch (e) {
      errorType = e instanceof Error && e.name === 'NotAllowedError' ? 'mic-denied' : 'recording-failed';
      errorDetail = e instanceof Error ? e.message : String(e);
      state = 'error';
    }
  }

  // アドバイスはコードで返ってくる。文面は言語ごとに i18n から引く。
  function renderAdvice(tip: { code: AdviceCode; value?: number }): string {
    const render = t.adviceTexts[tip.code];
    return typeof render === 'function' ? render(tip.value ?? 0) : render;
  }

  function reset(): void {
    if (audioUrl) { URL.revokeObjectURL(audioUrl); audioUrl = null; }
    state = 'idle'; scores = null; errorType = ''; errorDetail = ''; recordProgress = 0;
    rawCapture = true;
  }
</script>

<main>
  <header>
    <p class="eyebrow">AUDIO QUALITY ANALYZER</p>
    <div class="title-row">
      <div class="title-filler"></div>
      <h1>{t.title}</h1>
      <div class="title-end">
        <LangToggle bind:lang />
      </div>
    </div>
  </header>

  {#if state === 'idle' || state === 'error'}
    <div class="narrow-wrap">
      <AudioInput
        {t}
        recordDuration={RECORD_DURATION}
        errorMsg={state === 'error' ? errorMsg : ''}
        onFile={handleFile}
        onRecord={startRecording}
      />
    </div>
  {:else if state === 'recording'}
    <div class="narrow-wrap">
      <StatusPanel type="recording" progress={recordProgress} durationSec={RECORD_DURATION / 1000} />
    </div>
  {:else if state === 'analyzing'}
    <div class="narrow-wrap">
      <StatusPanel type="analyzing" />
    </div>
  {:else if state === 'done' && scores}
    <section class="result-section">
      {#if audioUrl}
        <div class="result-full">
          <AudioPlayer src={audioUrl} />
        </div>
      {/if}
      {#if provWarnings.length > 0}
        <div class="panel prov-panel result-full">
          <p class="panel-label prov-label">{t.provenanceLabel}</p>
          <p class="prov-intro">{provIntro}</p>
          <ul class="prov-list">
            {#each provWarnings as msg}
              <li>{msg}</li>
            {/each}
          </ul>
        </div>
      {/if}
      <VuMeter score={scores.overall} {t} />
      <div class="result-full">
        <VerdictPanel {scores} {t} />
      </div>
      <div class="panel chart-panel">
        <p class="panel-label">SPECTRUM</p>
        <RadarChart scores={scores} labels={LABELS} displayLabels={t.radarLabels} size={255} />
      </div>
      <div class="result-full">
        <ScoreBreakdown {scores} {t} {unreliable} />
      </div>
      {#if scores.advice.length > 0}
        <div class="panel result-full">
          <p class="panel-label">{t.adviceLabel}</p>
          <ul class="advice-list">
            {#each scores.advice as tip}
              <li>{renderAdvice(tip)}</li>
            {/each}
          </ul>
        </div>
      {/if}
      <button class="btn-reset result-full" onclick={reset}>{t.resetBtn}</button>
    </section>
  {/if}
</main>

<style>
  :global(*, *::before, *::after) { box-sizing: border-box; margin: 0; padding: 0; }

  :global(body) {
    background: #ECEEF5;
    color: #1A1C2E;
    font-family: 'Hiragino Sans', 'Yu Gothic UI', system-ui, sans-serif;
    min-height: 100vh;
    display: flex;
    justify-content: center;
    padding: 2.5rem 1.5rem 5rem;
  }

  main {
    width: 100%;
    max-width: 1100px;
    min-width: max(55vw, 300px);
    display: flex;
    flex-direction: column;
    gap: 1.1rem;
  }

  /* ---- 加工済み音声の警告 ---- */
  .prov-panel {
    background: #FFF7EC;
    border-color: #E5B77C;
  }

  .prov-label { color: #B86000; }

  .prov-intro {
    font-size: 0.82rem;
    line-height: 1.65;
    color: #5C4420;
    font-weight: 700;
  }

  .prov-list {
    list-style: none;
    margin-top: 0.7rem;
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
  }

  .prov-list li {
    position: relative;
    padding-left: 0.9rem;
    font-size: 0.78rem;
    line-height: 1.6;
    color: #6B5230;
  }

  .prov-list li::before {
    content: '';
    position: absolute;
    left: 0;
    top: 0.55em;
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: #B86000;
  }

  /* ---- Header ---- */
  header {
    text-align: center;
    padding-bottom: 0.25rem;
  }

  .eyebrow {
    font-size: 0.62rem;
    font-weight: 700;
    letter-spacing: 0.16em;
    color: #006E80;
    margin-bottom: 0.5rem;
  }

  /* 3カラムflex: [スペーサー] [h1中央] [トグル右寄せ] */
  .title-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .title-filler,
  .title-end {
    flex: 1;
    display: flex;
  }

  .title-end {
    justify-content: flex-end;
  }

  h1 {
    font-size: 2.1rem;
    font-weight: 900;
    letter-spacing: -0.05em;
    color: #1A1C2E;
    line-height: 1;
    white-space: nowrap;
    flex-shrink: 0;
  }

  /* ---- 入力・ステータス画面は中央に固定幅 ---- */
  .narrow-wrap {
    width: 100%;
    max-width: max(55vw, 480px);
    margin: 0 auto;
  }

  /* ---- 結果画面: モバイルは縦積み、デスクトップは2カラムグリッド ---- */
  .result-section {
    display: flex;
    flex-direction: column;
    gap: 1.1rem;
  }

  .result-full { width: 100%; }

  @media (min-width: 768px) {
    .result-section {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1.25rem;
      align-items: start;
    }

    .result-full,
    .btn-reset {
      grid-column: 1 / -1;
    }
  }

  /* ---- チャートパネル ---- */
  .panel {
    background: #FFFFFF;
    border: 1px solid #CDD0E0;
    border-radius: 6px;
    padding: 1.2rem;
  }

  .panel-label {
    font-size: 0.6rem;
    font-weight: 700;
    letter-spacing: 0.16em;
    color: #8A8CA8;
    margin-bottom: 1rem;
    text-transform: uppercase;
  }

  .chart-panel {
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  .chart-panel .panel-label { align-self: flex-start; }

  /* ---- アドバイスパネル ---- */
  .advice-list {
    list-style: disc;
    padding-left: 1.2rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    font-size: 0.82rem;
    line-height: 1.5;
    color: #474964;
  }

  /* ---- リセットボタン ---- */
  .btn-reset {
    width: 100%;
    padding: 0.8rem;
    background: transparent;
    color: #474964;
    border: 1px solid #CDD0E0;
    border-radius: 6px;
    font-size: 0.88rem;
    font-weight: 600;
    letter-spacing: 0.01em;
    cursor: pointer;
    transition: border-color 0.15s, color 0.15s;
  }

  .btn-reset:hover { border-color: #1A1C2E; color: #1A1C2E; }
  .btn-reset:focus-visible { outline: 2px solid #006E80; outline-offset: 2px; }
</style>
