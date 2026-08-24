<script lang="ts">
  /**
   * シェル。ルーティングと、機能に依らない外枠（製品名・言語切替・レイアウト）だけを持つ。
   *
   * 機能そのものの状態機械はここに置かない。音質チェックはバッチ（録って解析して採点）、
   * ハウリングとボリュームは受動リアルタイム（終わりが無く点数も無い）で、
   * 共通の状態機械に乗せると両方が歪むため。
   */
  import { onMount } from 'svelte';
  import { SHELL, initLang, saveLang, type Lang } from './shell/i18n.ts';
  import { router, navigate, startRouter } from './shell/router.svelte.ts';
  import { findFeature } from './features/registry.ts';
  import LangToggle from './shell/LangToggle.svelte';
  import Menu from './pages/Menu.svelte';

  let lang = $state<Lang>(initLang());
  $effect(() => { saveLang(lang); });

  const s = $derived(SHELL[lang]);
  // 未知のパスはメニューに落とす。個人用の道具に404画面は要らない
  const feature = $derived(findFeature(router.path));
  const pageTitle = $derived(feature ? feature.text[lang].name : s.productName);

  onMount(startRouter);

  // ブックマークとタブに出るので、ルートごとに切り替える
  $effect(() => {
    document.title = feature ? `${pageTitle} | ${s.productName}` : s.productName;
  });
</script>

<main>
  <header>
    {#if feature}
      <!-- 製品名がそのまま戻る手段。専用の戻るボタンは置かない
           （押せる場所が2つあると、どちらを押すか迷う） -->
      <button class="eyebrow eyebrow-link" onclick={() => navigate('/')}>
        &larr; SOUND CHECK
      </button>
    {:else}
      <p class="eyebrow">SOUND CHECK</p>
    {/if}
    <div class="title-row">
      <div class="title-filler"></div>
      <h1>{pageTitle}</h1>
      <div class="title-end">
        <LangToggle bind:lang />
      </div>
    </div>
  </header>

  {#if feature}
    {@const Feature = feature.component}
    <Feature {lang} />
  {:else}
    <Menu {lang} />
  {/if}
</main>

<style>
  main {
    width: 100%;
    max-width: 1100px;
    min-width: max(55vw, 300px);
    display: flex;
    flex-direction: column;
    gap: 1.1rem;
  }

  header {
    text-align: center;
    padding-bottom: 0.25rem;
  }

  .eyebrow {
    display: block;
    margin: 0 auto 0.5rem;
    font-size: 0.62rem;
    font-weight: 700;
    letter-spacing: 0.16em;
    color: var(--accent);
    font-family: inherit;
  }

  .eyebrow-link {
    background: transparent;
    border: none;
    cursor: pointer;
    padding: 0.15rem 0.3rem;
    border-radius: 3px;
  }

  .eyebrow-link:hover { text-decoration: underline; }
  .eyebrow-link:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

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
    color: var(--ink);
    line-height: 1;
    white-space: nowrap;
    flex-shrink: 0;
  }
</style>
