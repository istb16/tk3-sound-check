<script lang="ts">
  /**
   * ボリュームチェック。会場のPA音を拾って、ミキサーで動かした量を数値で見る。
   *
   * 音質チェックとは形が違う。終わりが無く、点数も無く、停止しても何も残らない。
   * だから AppState（idle/recording/analyzing/done）は共有しない。
   */
  import { onDestroy, onMount } from 'svelte';
  import type { Lang } from '../../shell/i18n.ts';
  import { DEFAULT_STALL_MS, MonitorSession } from '../../lib/audio/session.svelte.ts';
  import { T } from './i18n.ts';
  import { monitorErrorMsg } from '../common-text.ts';
  import { formatSigned } from '../../lib/format.ts';
  import {
    VolumeMeter, barRatio, FLOOR_DB, LEQ_WINDOW_SEC,
    BAND_MISMATCH_DB, NEAR_CLIP_WARN_SEC,
    type MeterState,
  } from './level.ts';

  let { lang }: { lang: Lang } = $props();
  const t = $derived(T[lang]);

  let instantDb   = $state(FLOOR_DB);
  let leqDb       = $state(FLOOR_DB);
  let leqZDb      = $state(FLOOR_DB);
  let peakHoldDb  = $state(FLOOR_DB);
  let clipSeconds = $state(0);
  let nearClipSeconds = $state(0);
  let leqReady    = $state(false);
  let warmupSec   = $state(LEQ_WINDOW_SEC);
  /** 段差の前のフレームが窓から出るまでの残り秒数。0 でなければ数値はまだ動く */
  let settlingSec = $state(0);

  /** 基準にした時点の Leq。null なら未設定 */
  let reference = $state<number | null>(null);
  /**
   * 同じ瞬間の重み付け無し(Z特性) Leq。**基準と対で持つ。**
   * 帯域別の操作で主役の数字が実際の変化を小さく見せていないかを確かめるためだけに使う。
   */
  let referenceZ = $state<number | null>(null);
  /** 基準を測っている最中か。押した時点から先の10秒を平均する */
  let capturingRef = $state(false);
  let refRemainingSec = $state(LEQ_WINDOW_SEC);
  /**
   * 基準を測っている間にレベルが変わったか。**基準を取り直すまで消えない。**
   * 窓が入れ替われば収束中の断りは消えるので、これを持たないと
   * 混合した基準からの差が確定した数値の顔で出続ける。
   */
  let referenceUnsettled = $state(false);
  /**
   * 再開時に基準を捨てた理由。空文字なら捨てていない。
   *
   * 「別のマイクだった」と「同じマイクか確かめられなかった」を分けるのは、
   * 後者で前者の文面を出すと**確かめていないことを断定する**ことになるからである。
   */
  let referenceDropped = $state<'' | 'device-changed' | 'device-unknown'>('');

  let meter: VolumeMeter | null = null;

  // マイクの開閉と失敗の分類は共有の状態機械に任せる。ここが持つのは測定だけ
  const session = new MonitorSession({
    // A特性の係数はサンプルレート依存なので、レートが確定してからでないと作れない
    onStart: ({ sampleRate, deviceLabel, previousDeviceLabel, resumed }) => {
      meter = new VolumeMeter(sampleRate);
      // 中断からの再開で別のマイクが開いていたら、中断前の基準はもう比較に使えない。
      // 感度が違う機材の値を引き算しても意味の無い数字が出るだけである。
      //
      // **同じ機材だと確かめられないときも破棄する。** マイク名が取れない環境では
      // 両方とも空文字になり、機材が変わっても食い違いを検出できない。そこで基準を
      // 持ち越すと、この道具がいちばん避けたい「意味のある形をした嘘」を出す側に
      // 倒れる。取り直しは10秒で済むが、別の機材との差は取り返せない
      if (resumed && reference !== null) {
        if (!deviceLabel || !previousDeviceLabel) {
          reference = referenceZ = null;
          referenceUnsettled = false;
          referenceDropped = 'device-unknown';
        } else if (deviceLabel !== previousDeviceLabel) {
          reference = referenceZ = null;
          referenceUnsettled = false;
          referenceDropped = 'device-changed';
        }
      }
    },
    onChunk: (chunk) => {
      if (meter?.push(chunk)) applyState(meter.state);
    },
    onStop: (reason) => {
      meter = null;
      instantDb   = leqDb = leqZDb = peakHoldDb = FLOOR_DB;
      clipSeconds = nearClipSeconds = 0;
      leqReady    = false;
      warmupSec   = LEQ_WINDOW_SEC;
      settlingSec = 0;
      // 測定中だった基準は解析器ごと消える。取り直してもらうしかない——
      // 中断をまたいだフレームを混ぜた平均は、10秒の基準ではない
      capturingRef    = false;
      refRemainingSec = LEQ_WINDOW_SEC;
      // 中断（stalled）でも起動失敗（failed）でも基準を捨てない。同じ端末・
      // 同じ場所なら、再開しても基準はそのまま比較に使える——そして中断中に
      // 会場の状態は変わっているので、捨てると「さっきと比べてどうか」を
      // 取り戻す手立てが無くなる。**「基準は保持しています」と出した直後に
      // 再開が失敗して黙って捨てる**のが、いちばん質の悪い裏切り方になる
      if (reason === 'user') {
        reference = referenceZ = null;
        referenceUnsettled = false;
        referenceDropped = '';
      }
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
   * 端末側のAGCを切れなかった。制約を出しただけで通ったことにはしない——
   * Android にはプラットフォーム層のAGCを無効化できない機種があり、
   * **AGCがONならこの機能そのものが成立しない**。
   */
  const agcStuck = $derived(session.autoGainControl);

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

  /**
   * 表示がまだ2つのレベルの混合であること。
   *
   * 移動窓の必然であって不具合ではないが、**収束済みの +4.0dB と混合中の
   * +4.0dB は見分けがつかない**。足りないと読まれてもう一段動かされるのが
   * この道具のいちばん重い誤読なので、動いている間はそう書く。
   * 数字自体は消さない——話し声のように素材が揺れる会場では収束中がほぼ
   * 常時真になり、消す設計だと数値が出っぱなしで見えなくなる。
   */
  const settling = $derived(diffDb !== null && settlingSec > 0);

  /**
   * 数値を確定した顔で出してよくない状態。収束中か、基準が混合しているとき。
   * どちらも「読んだ値を信じてフェーダーを動かす」のが危ない点で同じである。
   */
  const tentative = $derived(settling || referenceUnsettled);

  /** 同じ瞬間の重み付け無しの差。主役とは別物なので、食い違うときだけ出す */
  const diffZDb = $derived(showDb && referenceZ !== null ? leqZDb - referenceZ : null);
  const bandMismatch = $derived(
    diffDb !== null && diffZDb !== null && Math.abs(diffZDb - diffDb) >= BAND_MISMATCH_DB,
  );

  /** 割れてはいないが入力段が限界に張り付いている。差が縮んでいる可能性がある */
  const nearClipping = $derived(
    nearClipSeconds >= NEAR_CLIP_WARN_SEC && clipSeconds === 0,
  );

  const errorMsg = $derived(monitorErrorMsg(session.errorKind, session.errorDetail, t));

  function applyState(s: MeterState): void {
    instantDb   = s.instantDb;
    leqDb       = s.leqDb;
    leqZDb      = s.leqZDb;
    peakHoldDb  = s.peakHoldDb;
    clipSeconds = s.clipSeconds;
    nearClipSeconds = s.nearClipSeconds;
    leqReady    = s.leqReady;
    warmupSec   = s.warmupRemainingSec;
    settlingSec = s.settlingRemainingSec;

    capturingRef    = s.referenceCapturing;
    refRemainingSec = s.referenceRemainingSec;
    // 測り終えた基準は自分の側へ写す。**解析器ではなくここが持つ**——中断すると
    // 解析器は作り直されるが、基準は持ち越すのが約束である
    if (s.referenceDb !== null && reference === null) {
      reference  = s.referenceDb;
      referenceZ = s.referenceZDb;
      // 測っている10秒の中でレベルが変わっていたら、この基準は混合である
      referenceUnsettled = s.referenceStepDb !== 0;
    }
  }

  const start = (): void => { referenceDropped = ''; void session.start(); };

  /**
   * 画面を開いたらそのまま測り始める。**「測定を開始」の画面は挟まない。**
   *
   * この機能はマイクを開かないと何一つ表示できない——開始前の画面には
   * 押すべきボタンが1つしか無く、読んで決めることも無い。会場でフェーダーの
   * 前に立っている人に、意味のある選択肢の無い画面を1枚踏ませる理由が無い。
   *
   * 失敗したときの画面（説明＋もう一度試す）は残す。自動起動は利用者の操作を
   * 経ていないので、自動再生ポリシーで AudioContext を起こせない開き方
   * （リンクを直接踏んだ直後など）があり、そのときは押してもらう必要がある。
   */
  onMount(start);

  /**
   * 基準の測定を始める。**押した時点の Leq を写すのではない。**
   *
   * 遡る10秒を基準にすると、押す前に起きたレベル変化が焼き付く——開始してから
   * 客席へ歩き、着席直後に押すと、窓の半分は歩行中の音である。以後フェーダーに
   * 触れていないのに差が出続け、しかも窓が入れ替わったあとは収束中の断りも
   * 消えるので、確定した数値の顔で出る。押してからの10秒で測ればこれは起きない。
   */
  function setReference(): void {
    reference = referenceZ = null;
    referenceUnsettled = false;
    meter?.beginReference();
    capturingRef = true;
    refRemainingSec = LEQ_WINDOW_SEC;
    referenceDropped = '';
  }

  function clearReference(): void {
    reference = referenceZ = null;
    referenceUnsettled = false;
    meter?.clearReference();
    capturingRef = false;
  }
  /**
   * 中断からの再開。基準は持ち越す（別のマイクなら onStart が捨てる）。
   *
   * **前回の破棄理由はここで消す。** onStart のガードは基準が無いときに代入ごと
   * 飛ばすので、消さないと「別のマイクが開いたため破棄しました」が、破棄も機材の
   * 変更も起きていない次の再開にそのまま残って再度読み上げられる。
   */
  const resume = (): void => { referenceDropped = ''; void session.start(); };
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

      <!-- AGCがONならこの機能そのものが成立しない。どの数字より先に断る -->
      {#if agcStuck}
        <p class="error" role="alert">{t.agcWarning}</p>
      {/if}

      {#if referenceUnsettled}
        <p class="error" role="status">{t.referenceUnsettled}</p>
      {/if}

      {#if referenceDropped}
        <p class="error" role="alert">
          {referenceDropped === 'device-changed' ? t.referenceDropped : t.referenceUnverified}
        </p>
      {/if}

      <!-- 主役の位置は常に埋める。①待ち→②基準待ち→③差 と移るとき、途中で
           空くと「終わってしまった」と読まれる -->
      {#if capturingRef}
        <!-- 押した時点から先の10秒を測っている。ここは待ってもらうしかない -->
        <p class="state-title">{t.capturingReferenceTitle}</p>
        <p class="big big-count">{t.warmingUpRemaining(Math.ceil(refRemainingSec))}</p>
      {:else if reference === null}
        <!-- 基準は遡らないので、窓が埋まるのを待たずに押せる -->
        <p class="state-title">{t.setReferenceTitle}</p>
        <p class="hint">{t.noReference}</p>
      {:else if !leqReady}
        <p class="state-title">{t.warmingUpTitle}</p>
        <p class="big big-count">{t.warmingUpRemaining(Math.ceil(warmupSec))}</p>
        <!-- 中断からの再開。差は出せないが、基準が生きていることは伝える -->
        <p class="hint">{t.stalledKeepsReference}</p>
      {:else if diffDb === null}
        <p class="state-title">{t.setReferenceTitle}</p>
        <p class="hint">{t.noReference}</p>
      {:else}
        <!-- 収束中は上下の色を付けない。動いている途中の値を「上がった」と
             断言する見た目にすると、注意書きより先に色のほうが読まれる -->
        <p
          class="big"
          class:settling={tentative}
          class:up={!tentative && diffDb > 0.05}
          class:down={!tentative && diffDb < -0.05}
        >
          {formatSigned(diffDb)}<span class="unit">dB</span>
        </p>
        {#if settling}
          <p class="settling-note" role="status">{t.settlingNote(Math.ceil(settlingSec))}</p>
        {:else}
          <p class="leq-note">{t.leqNote}</p>
        {/if}
        <!-- 帯域ごとに変化量が違うときだけ、重み付け無しの差を並べる。
             一致しているときに2つ目の数字を出すと、どちらを読むのかが問題になる -->
        {#if bandMismatch && diffZDb !== null}
          <p class="band-note">{t.bandMismatch(formatSigned(diffZDb))}</p>
        {/if}
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

      <!-- 割れる手前で差が縮む領域。clipSeconds は 0 のままなので、
           これを出さないと警告が何も無いまま数値だけ小さくなる -->
      {#if nearClipping}
        <p class="warn-note" role="status">{t.nearClipWarning(nearClipSeconds)}</p>
      {/if}

      <p class="device">
        {t.deviceLabel}: {deviceLabel || t.deviceUnknown}
      </p>
      <p class="relative-note">{t.relativeNote}</p>
    </div>

    <div class="actions">
      {#if reference === null}
        <!-- 基準は押した時点から先の10秒で測るので、窓が埋まるのを待つ必要が無い。
             測っている最中の押し直しだけ塞ぐ（残り秒数が巻き戻るだけになる） -->
        <button class="btn-primary" onclick={setReference} disabled={capturingRef}>
          {t.setReferenceBtn}
        </button>
      {:else}
        <button class="btn-quiet" onclick={clearReference}>{t.clearReferenceBtn}</button>
      {/if}
      <button class="btn-quiet" onclick={stop}>{t.stopBtn}</button>
    </div>
  </div>
{/if}

<style>
  .kept {
    margin-top: 0.7rem;
    font-size: 0.78rem;
    color: var(--body);
  }

  /* 変化量が主役。会場では一目で読めることがすべて */
  .big {
    font-size: 3.2rem;
    font-weight: 900;
    letter-spacing: -0.04em;
    line-height: 1;
    font-variant-numeric: tabular-nums;
    color: var(--ink);
  }

  .big.up   { color: var(--danger); }
  .big.down { color: #006E80; }
  /* 収束中。数字は残すが、確定した値と同じ顔はさせない */
  .big.settling { color: var(--muted); }

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

  .leq-note {
    margin-top: 0.7rem;
    font-size: 0.68rem;
    color: var(--muted);
  }

  /* 収束中の断り。leq-note と同じ位置に出るが、読み飛ばされては困る */
  .settling-note {
    margin-top: 0.7rem;
    font-size: 0.72rem;
    font-weight: 700;
    color: var(--ink);
  }

  .band-note,
  .warn-note {
    margin-top: 0.5rem;
    font-size: 0.68rem;
    line-height: 1.5;
    color: var(--danger);
    text-align: left;
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

  .clip-row.clipping { color: var(--danger); font-weight: 700; }

  .mono { font-variant-numeric: tabular-nums; }

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
