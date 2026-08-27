<script lang="ts">
  import { onDestroy } from 'svelte';
  import { analyzeAudio, type AudioScores, type AdviceCode } from './AudioAnalyzer.ts';
  import { LABELS } from './scores.ts';
  import { T } from './i18n.ts';
  // 共有層。マイクの取り込みと WAV 書き出しは機能に依らない
  import { RECORDING_ABORTED, decodeFile, recordMicrophone } from '../../lib/audio/capture.ts';
  import { encodeWavFloat32, wavFileName } from '../../lib/audio/wav.ts';
  import type { Lang } from '../../shell/i18n.ts';

  import MicGuide from './MicGuide.svelte';
  import RadarChart from './RadarChart.svelte';
  import AudioInput from './AudioInput.svelte';
  import VuMeter from './VuMeter.svelte';
  import ScoreBreakdown from './ScoreBreakdown.svelte';
  import VerdictPanel from './VerdictPanel.svelte';
  import StatusPanel from './StatusPanel.svelte';
  import AudioPlayer from './AudioPlayer.svelte';

  const RECORD_DURATION = 10000;

  type AppState = 'idle' | 'recording' | 'analyzing' | 'done' | 'error';
  type ErrorKey = '' | 'invalid-file' | 'analysis-failed' | 'mic-denied' | 'recording-failed';

  // 言語はシェルが持つ。機能側は受け取って自分の辞書を引くだけにする。
  let { lang }: { lang: Lang } = $props();
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
   * 解析した音声をそのまま保存するためのURLとファイル名。
   *
   * マイク録音のときだけ用意する。ファイル入力では復号が44.1kHzに揃えられるので、
   * 保存しても元ファイルとは別物になり、保存する意味がない。
   */
  let wavUrl         = $state<string | null>(null);
  let wavName        = $state('');

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

  /**
   * 破棄済みか。解析も録音も await をまたぐので、途中でメニューへ戻られると
   * 後片付けの**後**に `createObjectURL` が走る。32bit float のWAVは10秒で
   * 約1.9MBあり、解放されないままタブが生きている限り積み上がる。
   */
  let disposed = false;
  /** 進行中の録音を打ち切るための取っ手 */
  let recordAbort: AbortController | null = null;

  async function handleFile(file: File): Promise<void> {
    if (!file.type.match(/audio/i) && !file.name.match(/\.(wav|mp3|ogg|webm|flac|aac)$/i)) {
      errorType = 'invalid-file'; errorDetail = '';
      state = 'error'; return;
    }
    state = 'analyzing'; errorType = '';
    rawCapture = true; // ファイル入力は復号のみ。取り込み経路による劣化はない
    const url = URL.createObjectURL(file);
    try {
      const result = await analyzeAudio(await decodeFile(file));
      if (disposed) { URL.revokeObjectURL(url); return; }
      scores = result;
      audioUrl = url;
      state = 'done';
    } catch (e) {
      if (disposed) { URL.revokeObjectURL(url); return; }
      URL.revokeObjectURL(url);
      errorType = 'analysis-failed';
      errorDetail = e instanceof Error ? e.message : String(e);
      state = 'error';
    }
  }

  async function startRecording(): Promise<void> {
    state = 'recording'; errorType = ''; errorDetail = ''; recordProgress = 0;
    const abort = new AbortController();
    recordAbort = abort;
    try {
      const rec = await recordMicrophone(
        RECORD_DURATION, (p) => { recordProgress = p; }, abort.signal,
      );
      if (disposed) return;
      const { buffer, blob } = rec;
      rawCapture = rec.rawCapture;
      state = 'analyzing';
      const result = await analyzeAudio(buffer);
      // 解析の間に離脱されていたら、ここから先のURLは誰も解放できない
      if (disposed) return;
      scores = result;
      audioUrl = URL.createObjectURL(blob);
      // 解析したのは buffer の中身そのもの。再生用の blob（コーデック経由）ではなく
      // こちらを保存する。
      wavUrl = URL.createObjectURL(encodeWavFloat32(buffer.getChannelData(0), buffer.sampleRate));
      wavName = wavFileName(new Date());
      state = 'done';
    } catch (e) {
      // 自分で打ち切ったものをエラーとして見せない
      if (disposed || (e instanceof Error && e.name === RECORDING_ABORTED)) return;
      errorType = e instanceof Error && e.name === 'NotAllowedError' ? 'mic-denied' : 'recording-failed';
      errorDetail = e instanceof Error ? e.message : String(e);
      state = 'error';
    } finally {
      if (recordAbort === abort) recordAbort = null;
    }
  }

  // アドバイスはコードで返ってくる。文面は言語ごとに i18n から引く。
  function renderAdvice(tip: { code: AdviceCode; value?: number }): string {
    const render = t.adviceTexts[tip.code];
    return typeof render === 'function' ? render(tip.value ?? 0) : render;
  }

  function reset(): void {
    if (audioUrl) { URL.revokeObjectURL(audioUrl); audioUrl = null; }
    if (wavUrl) { URL.revokeObjectURL(wavUrl); wavUrl = null; wavName = ''; }
    state = 'idle'; scores = null; errorType = ''; errorDetail = ''; recordProgress = 0;
    rawCapture = true;
  }

  /**
   * 結果を表示したままメニューへ戻られると、reset() を通らずに破棄される。
   * 保存用のWAVは32bit floatなので10秒でも約1.9MB あり、放置すると
   * タブが生きている限り積み上がる。
   */
  onDestroy(() => {
    disposed = true;
    // 録音中に離脱されたら即座にマイクを閉じる。10秒待つ間、録音インジケータが
    // 点いたままになるのは事故
    recordAbort?.abort();
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    if (wavUrl)   URL.revokeObjectURL(wavUrl);
  });
</script>

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
    <!-- 録音中も読み上げ文を出す。消えると話す内容を思い出しながら喋ることになり、
         間の取り方が不自然になる。無音区間が無いとSNRも残響も測れない。 -->
    <MicGuide {t} />
  </div>
{:else if state === 'analyzing'}
  <div class="narrow-wrap">
    <StatusPanel type="analyzing" />
  </div>
{:else if state === 'done' && scores}
  <!-- 2列に切り替える判断は、ビューポートではなく**この領域の幅**で行う。
       画面が広くても main の幅は 55vw なので、ビューポートで判断すると
       1列ぶんの幅しか無いのに2列に割ってしまう -->
  <div class="result-wrap">
  <section class="result-section">
    {#if audioUrl}
      <div class="result-full">
        <AudioPlayer src={audioUrl} />
      </div>
    {/if}
    {#if wavUrl}
      <p class="save-wav result-full">
        <a href={wavUrl} download={wavName}>{t.saveWav}</a>
        <span class="save-wav-hint">{t.saveWavHint}</span>
      </p>
    {/if}
    {#if provWarnings.length > 0}
      <div class="panel prov-panel result-full">
        <p class="panel-label prov-label">{t.provenanceLabel}</p>
        <p class="prov-intro">{t.provenanceIntro}</p>
        <ul class="prov-list">
          {#each provWarnings as msg}
            <li>{msg}</li>
          {/each}
        </ul>
      </div>
    {/if}
    <!-- 2列のときに対になる相手を持たせる。総合点の隣が判定、レーダーの隣が内訳。
         以前は半分幅の項目の次が必ず全幅の項目だったので、**右カラムが常に空**で
         2列にする意味が無かった。DOMの順は変えていない——1列のときの読む順
         （総合点 → 判定 → レーダー → 内訳）は、判定が答えなので動かせない -->
    <VuMeter score={scores.overall} {t} />
    <div><VerdictPanel {scores} {t} /></div>
    <div class="panel chart-panel">
      <p class="panel-label">SPECTRUM</p>
      <RadarChart scores={scores} labels={LABELS} displayLabels={t.radarLabels} size={255} />
    </div>
    <div><ScoreBreakdown {scores} {t} {unreliable} /></div>
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
    <button class="btn-quiet result-full" onclick={reset}>{t.resetBtn}</button>
  </section>
  </div>
{/if}

<style>
  /* ---- 加工済み音声の警告 ---- */
  .prov-panel {
    background: #FFF7EC;
    border-color: #E5B77C;
  }

  .prov-label { color: #B86000; }

  .save-wav {
    margin: 0.5rem 0 0;
    font-size: 0.85rem;
    display: flex;
    gap: 0.6rem;
    align-items: baseline;
    flex-wrap: wrap;
  }
  .save-wav-hint {
    opacity: 0.7;
  }

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

  /* ---- 結果画面: モバイルは縦積み、デスクトップは2カラムグリッド ---- */
  .result-section {
    display: flex;
    flex-direction: column;
    gap: 1.1rem;
  }

  .result-full { inline-size: 100%; }

  /* この領域の幅で判断する。ビューポートで判断すると、main が 55vw のせいで
     1列ぶんの幅しか無いのに2列に割れてしまう */
  .result-wrap { container-type: inline-size; }

  @container (min-width: 640px) {
    .result-section {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1.25rem;
      align-items: start;
    }

    .result-full {
      grid-column: 1 / -1;
    }
  }

  /* ---- チャートパネル ---- */
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
</style>
