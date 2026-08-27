<script lang="ts">
  /**
   * トップページ。**ランチャー**である。
   *
   * 開くのは3つとも知っているが月に数回しか使わない人なので、最適化するのは
   * 「説明」ではなく「読まずに撃ち分けられること」。3枚が同じ形・同じ色だと
   * 毎回**読んで**選ばされるので、アイコンの形と色を最大限に散らしてある。
   *
   * 375×667（iPhone SE）で3枚とも一画面に収まることが制約である。
   * スクロールしないと選べないランチャーは、いまより遅い。
   * この制約は App.test.ts が機械的に守っている。
   */
  import { SHELL, type Lang } from '../shell/i18n.ts';
  import { navigate } from '../shell/router.svelte.ts';
  import { FEATURES } from '../features/registry.ts';

  let { lang }: { lang: Lang } = $props();
  const s = $derived(SHELL[lang]);

  /**
   * 本物のリンクとして置きつつ、クリックはルーターで処理する。
   *
   * `<button>` ではなく `<a href>` にしているのは公開サイトだからである——
   * これだけで「長押しでリンクをコピー」「新しいタブで開く」が効くようになる。
   * 修飾キー付きのクリックはブラウザに渡す（新しいタブで開けなくなるため）。
   */
  function go(e: MouseEvent, path: string): void {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    navigate(path);
  }
</script>

<p class="lead">{s.menuLead}</p>

<ul class="tiles">
  {#each FEATURES as feature (feature.id)}
    {@const Icon = feature.icon}
    <li>
      <a
        class="tile"
        href={feature.path}
        style="--tile-accent: {feature.accent}"
        onclick={(e) => go(e, feature.path)}
      >
        <span class="chip"><Icon /></span>
        <span class="tile-body">
          <span class="tile-name">{feature.text[lang].name}</span>
          <span class="tile-summary">{feature.text[lang].summary}</span>
        </span>
        <span class="chevron" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none">
            <path d="M9 5l7 7-7 7" stroke="currentColor" stroke-width="2"
                  stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </span>
      </a>
    </li>
  {/each}
</ul>

<style>
  .lead {
    font-size: 0.82rem;
    color: var(--muted);
    text-align: center;
  }

  .tiles {
    list-style: none;
    display: grid;
    /* 3つは2列に収まらない（必ず歯抜けになる）。幅で決めれば、
       スマホは1列、PCは3列に自然に落ちる */
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 0.7rem;
  }

  .tile {
    display: flex;
    align-items: center;
    gap: 0.9rem;
    block-size: 100%;
    padding: 1rem;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 10px;
    text-decoration: none;
    cursor: pointer;
    transition: border-color 0.15s, box-shadow 0.15s, transform 0.1s;
  }

  .tile:hover {
    border-color: var(--tile-accent);
    box-shadow: 0 2px 10px rgb(26 28 46 / 0.09);
  }

  /* 押した手応え。タップできることが指で分かる */
  .tile:active { transform: translateY(1px); box-shadow: none; }
  .tile:focus-visible { outline: 2px solid var(--tile-accent); outline-offset: 2px; }

  /* 色が乗るのはここだけ。文字は白地の上に残すのでコントラストが落ちない
     ——この道具は照明の暗い会場や逆光の窓際で開かれる */
  .chip {
    flex: 0 0 auto;
    inline-size: 56px;
    block-size: 56px;
    padding: 12px;
    border-radius: 14px;
    background: var(--tile-accent);
    color: #FFFFFF;
    display: flex;
  }

  .tile-body {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    /* 長い名前で chip を押し潰さない */
    min-inline-size: 0;
  }

  .tile-name {
    font-size: 1rem;
    font-weight: 800;
    letter-spacing: -0.01em;
    color: var(--ink);
    line-height: 1.3;
  }

  .tile-summary {
    font-size: 0.76rem;
    line-height: 1.5;
    color: var(--body);
  }

  .chevron {
    flex: 0 0 auto;
    margin-inline-start: auto;
    inline-size: 18px;
    block-size: 18px;
    color: var(--line);
    transition: color 0.15s;
  }

  .chevron svg { inline-size: 100%; block-size: 100%; display: block; }
  .tile:hover .chevron { color: var(--tile-accent); }
</style>
