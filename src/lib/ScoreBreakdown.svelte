<script lang="ts">
  import { scoreColor, LABELS, type ScoreLabel } from './scores.ts';
  import type { AudioScores } from './AudioAnalyzer.ts';
  import type { Translations } from './i18n.ts';

  interface Props {
    scores: AudioScores;
    t: Translations;
    /** 加工の痕跡により信用できない軸。バッジを付けて明示する */
    unreliable?: ScoreLabel[];
  }

  let { scores, t, unreliable = [] }: Props = $props();
</script>

<div class="panel">
  <p class="panel-label">BREAKDOWN</p>
  <ul class="breakdown">
    {#each LABELS as key}
      {@const v = scores[key]}
      <li class="b-row">
        <div class="b-top">
          <span class="b-namewrap">
            <span class="b-name">{t.categoryNames[key]}</span>
            {#if unreliable.includes(key)}
              <span class="b-flag" title={t.provenanceUnreliableTitle}>{t.provenanceUnreliable}</span>
            {/if}
          </span>
          <span class="b-desc">{t.categoryDescs[key]}</span>
          <span class="b-val">{v}</span>
        </div>
        <div class="b-track">
          <div class="b-fill" style="width:{v}%; background:{scoreColor(v)}"></div>
        </div>
      </li>
    {/each}
  </ul>
</div>

<style>
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

  .breakdown {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
  }

  .b-row { display: flex; flex-direction: column; gap: 0.35rem; }

  .b-top {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: baseline;
    gap: 0.5rem;
  }

  .b-name {
    font-size: 0.85rem;
    font-weight: 700;
    color: #1A1C2E;
    letter-spacing: -0.01em;
    white-space: nowrap;
  }

  /* ラベルとバッジの器。.b-name の textContent はラベルのみに保つ */
  .b-namewrap {
    display: inline-flex;
    align-items: baseline;
    gap: 0.35rem;
    white-space: nowrap;
  }

  .b-flag {
    display: inline-block;
    padding: 0.05rem 0.35rem;
    border: 1px solid #B86000;
    border-radius: 3px;
    font-size: 0.58rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    color: #B86000;
    vertical-align: 0.08em;
    white-space: nowrap;
  }

  .b-desc {
    font-size: 0.68rem;
    color: #8A8CA8;
    letter-spacing: 0.01em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .b-val {
    font-size: 0.85rem;
    font-weight: 900;
    font-variant-numeric: tabular-nums;
    color: #1A1C2E;
    letter-spacing: -0.02em;
    white-space: nowrap;
  }

  .b-track {
    height: 5px;
    background: #DDE0EE;
    border-radius: 9999px;
    overflow: hidden;
  }

  .b-fill {
    height: 100%;
    border-radius: 9999px;
    transition: width 0.7s cubic-bezier(0.4, 0, 0.2, 1);
  }

  @media (prefers-reduced-motion: reduce) {
    .b-fill { transition: none; }
  }
</style>
