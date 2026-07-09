<script lang="ts">
  import type { Lang } from './i18n.ts';

  let { lang = $bindable<Lang>() }: { lang: Lang } = $props();
</script>

<div class="lang-toggle" role="group" aria-label="Language">
  <button class:active={lang === 'ja'} onclick={() => (lang = 'ja')} aria-pressed={lang === 'ja'}>JA</button>
  <button class:active={lang === 'en'} onclick={() => (lang = 'en')} aria-pressed={lang === 'en'}>EN</button>
</div>

<style>
  .lang-toggle {
    display: flex;
    border: 1px solid #CDD0E0;
    border-radius: 4px;
    overflow: hidden;
  }

  .lang-toggle button {
    padding: 0.28rem 0.55rem;
    font-size: 0.62rem;
    font-weight: 700;
    letter-spacing: 0.1em;
    border: none;
    background: transparent;
    color: #8A8CA8;
    cursor: pointer;
    transition: background 0.12s, color 0.12s;
    line-height: 1;
  }

  .lang-toggle button:first-child {
    border-right: 1px solid #CDD0E0;
  }

  .lang-toggle button.active {
    background: #1A1C2E;
    color: #ECEEF5;
  }

  .lang-toggle button:focus-visible {
    outline: 2px solid #006E80;
    outline-offset: -2px;
  }
</style>
