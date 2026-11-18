<script lang="ts">
  import type { AudioScores } from './AudioAnalyzer.ts';
  import type { QualityText } from './i18n.ts';

  interface Props {
    scores: AudioScores;
    t: QualityText;
  }

  let { scores, t }: Props = $props();

  const verdict = $derived(scores.verdict);
  const m = $derived(scores.measured);

  // 判定の根拠になった実測値。点数ではなく物理量を先に見せる。
  const facts = $derived.by(() => {
    const list: string[] = [];
    if (m.snrDb !== null) list.push(t.factSnr(m.snrDb));
    list.push(m.rt60Sec !== null ? t.factRt60(m.rt60Sec) : t.factRt60Unknown);
    list.push(t.factBandwidth(m.bandwidthHz));
    if (m.activeSpeechDbfs !== null) list.push(t.factLevel(m.activeSpeechDbfs));
    if (m.clipRate !== null) {
      list.push(m.clipRate === 0 ? t.factClipNone : t.factClip(m.clipRate * 100));
    }
    return list;
  });

  const limitingName = $derived(
    verdict.limitingAxis === null ? '' : t.categoryNames[verdict.limitingAxis],
  );
</script>

<div class="panel verdict-panel v-{verdict.level}">
  <p class="panel-label">{t.verdictLabel}</p>
  <p class="v-main">{t.verdicts[verdict.level]}</p>
  {#if verdict.limitingAxis !== null}
    <p class="v-limit">
      {verdict.unconfirmed === 'unmeasured'
        ? t.verdictUnconfirmed(limitingName)
        : verdict.unconfirmed === 'near-boundary'
          ? t.verdictNearBoundary(limitingName)
          : t.verdictLimitedBy(limitingName)}
    </p>
  {/if}

  <p class="v-facts-label">{t.factsLabel}</p>
  <ul class="v-facts">
    {#each facts as fact}
      <li>{fact}</li>
    {/each}
  </ul>
</div>

<style>
  /* 下地(app.css)との差分だけ持つ。左の帯で判定の色を出す */
  .panel { border-left-width: 4px; }

  .panel-label { margin-bottom: 0.7rem; }

  .v-good   { border-left-color: var(--score-good); }
  .v-usable { border-left-color: var(--score-ok); }
  .v-poor   { border-left-color: var(--score-bad); }

  .v-main {
    font-size: 1rem;
    font-weight: 700;
    line-height: 1.55;
    letter-spacing: -0.01em;
    color: var(--ink);
  }

  .v-limit {
    margin-top: 0.4rem;
    font-size: 0.82rem;
    line-height: 1.6;
    color: var(--body-soft);
  }

  .v-facts-label {
    margin-top: 1.1rem;
    font-size: 0.6rem;
    font-weight: 700;
    letter-spacing: 0.16em;
    color: var(--muted);
    text-transform: uppercase;
  }

  .v-facts {
    list-style: none;
    margin-top: 0.5rem;
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem 1.4rem;
  }

  .v-facts li {
    font-size: 0.78rem;
    line-height: 1.6;
    color: var(--body-strong);
    font-variant-numeric: tabular-nums;
  }
</style>
