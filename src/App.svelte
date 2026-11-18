<script lang="ts">
  /**
   * シェル。ルーティングと、機能に依らない外枠（看板・言語切替・レイアウト）だけを持つ。
   *
   * 機能そのものの状態機械はここに置かない。音質チェックはバッチ（録って解析して採点）、
   * ハウリングとボリュームは受動リアルタイム（終わりが無く点数も無い）で、
   * 共通の状態機械に乗せると両方が歪むため。
   *
   * 画面の上には tk3 apps 共通の `.tk-header`（アイコン＋「SOUND CHECK」、右に言語切替）を
   * どのページにも置く。看板はこの小さな帯に収め、大きな看板は掲げない。
   *
   * 主役の見出しはページによって入れ替わる。**トップでは看板（帯の中の h1）、
   * 機能ページでは機能名。** 帯の看板も押せばメニューへ戻るが、それだけでは
   * 「押せば戻れる」は伝わりにくいので、機能ページには行き先を書いた
   * `← メニュー` を別に置いている。
   */
  import { onMount } from 'svelte';
  import { SHELL, WORDMARK, initLang, saveLang, type Lang } from './shell/i18n.ts';
  import { router, navigate, startRouter } from './shell/router.svelte.ts';
  import { findFeature } from './features/registry.ts';
  import LangToggle from './shell/LangToggle.svelte';
  import Menu from './pages/Menu.svelte';

  let lang = $state<Lang>(initLang());
  $effect(() => { saveLang(lang); });

  const s = $derived(SHELL[lang]);
  // 未知のパスはメニューに落とす。個人用の道具に404画面は要らない
  const feature = $derived(findFeature(router.path));

  onMount(startRouter);

  // ブックマークとタブに出るので、ルートごとに切り替える。
  // 機能ページから看板を下ろしたぶん、ブランドはここが受け持つ
  $effect(() => {
    document.title = feature
      ? `${feature.text[lang].name} | ${s.productName}`
      : s.productName;
  });

  function toMenu(e: MouseEvent): void {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    navigate('/');
  }
</script>

<header class="tk-header">
  <a class="tk-header__home" href="/" onclick={toMenu}>
    <img class="tk-header__icon" src="/icon.svg" alt="" width="32" height="32" />
    <!-- 看板は英字固定。JA/EN を切り替えるサイトでは、
         翻訳しなくて済む名前のほうが看板に向く。
         トップではこれがページの見出し、機能ページでは機能名に見出しを譲る -->
    {#if feature}
      <span class="tk-header__name">{WORDMARK}</span>
    {:else}
      <h1 class="tk-header__name wordmark">{WORDMARK}</h1>
    {/if}
  </a>
  <div class="tk-header__end">
    <LangToggle bind:lang />
  </div>
</header>

<div class="page">
  <main class:full={!feature}>
    {#if feature}
      <header class="feature-head" style="--feature-accent: {feature.accent}">
        <div class="head-row">
          <!-- 行き先の名前を書く。「SOUND CHECK」は行き先が何なのか言っていないが
               「メニュー」は言っている。スマホの左上は最も届きにくい場所なので、
               文字数も短いほうがよい -->
          <a class="back" href="/" onclick={toMenu}>
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M15 5l-7 7 7 7" stroke="currentColor" stroke-width="2.2"
                    stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            {s.backToMenu}
          </a>
        </div>
        <h1 class="page-title">{feature.text[lang].name}</h1>
      </header>

      {@const Feature = feature.component}
      <Feature {lang} />
    {:else}
      <header class="hero">
        <p class="tagline">{s.tagline}</p>
      </header>

      <Menu {lang} />
    {/if}
  </main>
</div>

<footer class="tk-footer">
  <a href="https://tk3.biz/">tk3.biz</a>
</footer>

<style>
  /*
   * 幅はページの種類で変える。
   *
   * 機能ページは**読む幅**（本文と1つのパネルが並ぶ幅）。広げると音質チェックの
   * 結果が2列に切り替わるが、あの並びは「半分幅の次が必ず全幅」なので
   * 対になる相手がおらず、右カラムが空になる。
   *
   * メニューだけは全幅を使う。3枚のタイルを1行に並べるため——2列だと
   * 必ず1枚余って歯抜けになる。
   */
  /* 画面の端との余白。ヘッダーとフッターは端から端まで敷くので、body ではなくここに置く */
  .page { padding: 1.75rem 1.5rem 3rem; }

  main {
    inline-size: min(100%, max(55vw, 300px));
    max-inline-size: 1100px;
    /* 親を flex にして中央寄せすると、間の #app が縮んで幅が壊れる */
    margin-inline: auto;
    display: flex;
    flex-direction: column;
    gap: 1.1rem;
  }

  main.full { inline-size: min(100%, 1100px); }

  /* 帯の中の看板。見出しの既定の大きさ・余白を消し、帯の文字の形に合わせる */
  .wordmark { font-size: 1.125rem; font-weight: 600; margin: 0; }

  /* 戻るの行。タイトルとは行を分ける——幅320pxでは
     戻るとタイトルは1行に収まらない */
  .head-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-block-end: 0.7rem;
  }

  /* ---- トップページ ---- */

  .hero { text-align: center; }

  .tagline {
    font-size: 0.84rem;
    line-height: 1.7;
    color: var(--body);
    white-space: pre-line;
  }

  /* ---- 機能ページ ---- */

  .feature-head {
    text-align: center;
    /* 機能の色を字や線に使うときの色。暗い配色では地が暗いので明るく寄せる */
    --feature-ink: var(--feature-accent);
  }

  @media (prefers-color-scheme: dark) {
    .feature-head { --feature-ink: color-mix(in oklch, var(--feature-accent) 55%, white); }
  }

  .back {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    /* 指の的として 44px を割らない */
    min-block-size: 40px;
    padding: 0.4rem 0.8rem 0.4rem 0.55rem;
    border: 1px solid var(--feature-ink);
    border-radius: 999px;
    background: var(--surface);
    color: var(--feature-ink);
    font-size: 0.78rem;
    font-weight: 700;
    letter-spacing: 0.02em;
    text-decoration: none;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }

  .back svg { inline-size: 15px; block-size: 15px; }

  .back:hover { background: var(--feature-accent); color: var(--on-feature); }
  .back:focus-visible { outline: 2px solid var(--feature-ink); outline-offset: 2px; }

  .page-title {
    font-size: clamp(1.8rem, 8vw, 2.4rem);
    font-weight: 900;
    letter-spacing: -0.05em;
    color: var(--ink);
    line-height: 1.1;
  }

  /* 機能の色はここまで。バーやボタンには持ち込まない
     ——赤への変化が「異常」を示す唯一の手段なので、基調色を赤に近づけない */
  .page-title::after {
    content: '';
    display: block;
    inline-size: 44px;
    block-size: 3px;
    margin: 0.5rem auto 0;
    border-radius: 2px;
    background: var(--feature-ink);
  }
</style>
