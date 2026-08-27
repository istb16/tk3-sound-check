<script lang="ts">
  /**
   * シェル。ルーティングと、機能に依らない外枠（看板・言語切替・レイアウト）だけを持つ。
   *
   * 機能そのものの状態機械はここに置かない。音質チェックはバッチ（録って解析して採点）、
   * ハウリングとボリュームは受動リアルタイム（終わりが無く点数も無い）で、
   * 共通の状態機械に乗せると両方が歪むため。
   *
   * header の主役はページによって入れ替わる。**トップでは看板、機能ページでは機能名。**
   * 「大きいロゴは押せない」が web の常識なので、看板を目立たせるほど
   * 「押せば戻れる」は伝わらなくなる。1つの要素に2役を負わせるのをやめ、
   * 機能ページでは看板を下ろして `← メニュー` を置いている。
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
        <LangToggle bind:lang />
      </div>
      <h1 class="page-title">{feature.text[lang].name}</h1>
    </header>

    {@const Feature = feature.component}
    <Feature {lang} />
  {:else}
    <header class="hero">
      <div class="head-row head-row-end">
        <LangToggle bind:lang />
      </div>
      <!-- 看板は英字固定。JA/EN を切り替えるサイトでは、
           翻訳しなくて済む名前のほうが看板に向く -->
      <h1 class="wordmark">{WORDMARK}</h1>
      <p class="tagline">{s.tagline}</p>
    </header>

    <Menu {lang} />
  {/if}
</main>

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

  /* 戻る／言語切替の行。タイトルとは行を分ける——幅320pxでは
     戻る・タイトル・言語切替の3つは1行に収まらない */
  .head-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    margin-block-end: 0.7rem;
  }

  .head-row-end { justify-content: flex-end; }

  /* ---- トップページ ---- */

  .hero { text-align: center; }

  .wordmark {
    font-size: clamp(1.9rem, 9vw, 2.7rem);
    font-weight: 900;
    letter-spacing: 0.1em;
    /* 字間を空けたぶん、中央からずれて見えるのを戻す */
    text-indent: 0.1em;
    line-height: 1;
    color: var(--ink);
  }

  .tagline {
    margin-block-start: 0.7rem;
    font-size: 0.84rem;
    line-height: 1.7;
    color: var(--body);
    white-space: pre-line;
  }

  /* ---- 機能ページ ---- */

  .feature-head { text-align: center; }

  .back {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    /* 指の的として 44px を割らない */
    min-block-size: 40px;
    padding: 0.4rem 0.8rem 0.4rem 0.55rem;
    border: 1px solid var(--feature-accent);
    border-radius: 999px;
    background: var(--surface);
    color: var(--feature-accent);
    font-size: 0.78rem;
    font-weight: 700;
    letter-spacing: 0.02em;
    text-decoration: none;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }

  .back svg { inline-size: 15px; block-size: 15px; }

  .back:hover { background: var(--feature-accent); color: #FFFFFF; }
  .back:focus-visible { outline: 2px solid var(--feature-accent); outline-offset: 2px; }

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
    background: var(--feature-accent);
  }
</style>
