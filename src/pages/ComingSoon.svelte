<script lang="ts">
  import { SHELL, type Lang } from '../shell/i18n.ts';
  import { navigate } from '../shell/router.svelte.ts';

  let { lang, summary, note }: { lang: Lang; summary: string; note: string } = $props();

  const s = $derived(SHELL[lang]);
</script>

<div class="narrow-wrap">
  <div class="panel">
    <p class="panel-label soon-label">{s.comingSoonLabel}</p>
    <p class="soon-summary">{summary}</p>
    <p class="soon-note">{note}</p>
    <p class="soon-body">{s.comingSoonBody}</p>
  </div>
  <button class="btn-quiet" onclick={() => navigate('/')}>{s.backToMenu}</button>
</div>

<style>
  .soon-label { color: #B86000; }

  .soon-summary {
    font-size: 0.95rem;
    font-weight: 700;
    line-height: 1.6;
    color: #1A1C2E;
  }

  .soon-note {
    margin-top: 0.7rem;
    font-size: 0.82rem;
    line-height: 1.75;
    color: #474964;
  }

  .soon-body {
    margin-top: 1rem;
    font-size: 0.78rem;
    color: #8A8CA8;
  }

  .btn-quiet { margin-top: 1.1rem; }
</style>
