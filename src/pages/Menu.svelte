<script lang="ts">
  import { SHELL, type Lang } from '../shell/i18n.ts';
  import { navigate } from '../shell/router.svelte.ts';
  import { FEATURES } from '../features/registry.ts';

  let { lang }: { lang: Lang } = $props();
  const s = $derived(SHELL[lang]);
</script>

<div class="narrow-wrap">
  <p class="lead">{s.menuLead}</p>
  <ul class="tiles">
    {#each FEATURES as feature (feature.id)}
      <li>
        <button class="tile" onclick={() => navigate(feature.path)}>
          <span class="tile-head">
            <span class="tile-name">{feature.text[lang].name}</span>
            {#if feature.status === 'coming-soon'}
              <span class="tile-badge">{s.comingSoonLabel}</span>
            {/if}
          </span>
          <span class="tile-summary">{feature.text[lang].summary}</span>
        </button>
      </li>
    {/each}
  </ul>
</div>

<style>
  .lead {
    font-size: 0.85rem;
    color: var(--body);
    margin-bottom: 0.9rem;
  }

  .tiles {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
  }

  .tile {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    text-align: left;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 1.1rem 1.2rem;
    cursor: pointer;
    font: inherit;
    transition: border-color 0.15s, transform 0.15s;
  }

  .tile:hover { border-color: var(--ink); }
  .tile:active { transform: translateY(1px); }
  .tile:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  .tile-head {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }

  .tile-name {
    font-size: 1rem;
    font-weight: 800;
    letter-spacing: -0.01em;
    color: var(--ink);
  }

  /* 未実装であることは、押す前に分かる必要がある */
  .tile-badge {
    font-size: 0.58rem;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: #B86000;
    background: #FFF7EC;
    border: 1px solid #E5B77C;
    border-radius: 3px;
    padding: 0.15rem 0.35rem;
    line-height: 1;
  }

  .tile-summary {
    font-size: 0.8rem;
    line-height: 1.6;
    color: var(--body);
  }
</style>
