<script lang="ts">
  import { segColor, gradeCls, SEGMENTS } from './scores.ts';
  import type { Translations } from './i18n.ts';

  interface Props {
    score: number;
    t: Translations;
  }

  let { score, t }: Props = $props();

  let displayed = $state(0);

  function easeOut(x: number): number { return 1 - Math.pow(1 - x, 3); }

  $effect(() => {
    const target = score;
    let start: number | null = null;
    let rafId: number;

    function step(ts: number): void {
      if (start === null) start = ts;
      const p = Math.min((ts - start) / 1000, 1);
      displayed = Math.round(easeOut(p) * target);
      if (p < 1) rafId = requestAnimationFrame(step);
    }

    rafId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafId);
  });

  const grade = $derived(gradeCls(score));
  const gradeLabel = $derived(t.grades[grade]);
</script>

<div class="vu-card">
  <p class="vu-eyebrow">SIGNAL QUALITY</p>
  <div class="vu-meter" aria-label={t.vuAriaLabel(score)}>
    {#each Array.from({ length: SEGMENTS }, (_, i) => i) as seg}
      {@const lit = displayed >= Math.round(((seg + 1) / SEGMENTS) * 100)}
      <div class="vu-seg" style={lit ? `background:${segColor(seg)}` : ''}></div>
    {/each}
  </div>
  <div class="vu-footer">
    <div class="vu-scale">
      <span>0</span><span>25</span><span>50</span><span>75</span><span>100</span>
    </div>
    <div class="vu-score-row">
      <span class="vu-num">{displayed}</span>
      <span class="vu-grade grade-{grade}">{gradeLabel}</span>
    </div>
  </div>
</div>

<style>
  .vu-card {
    background: #1A1C2E;
    border-radius: 6px;
    padding: 1.4rem 1.25rem 1.1rem;
  }

  .vu-eyebrow {
    font-size: 0.6rem;
    font-weight: 700;
    letter-spacing: 0.16em;
    color: #6063A0;
    margin-bottom: 1rem;
    text-transform: uppercase;
  }

  .vu-meter {
    display: flex;
    gap: 3px;
    height: 28px;
  }

  .vu-seg {
    flex: 1;
    height: 100%;
    background: #2E3050;
    border-radius: 2px;
    transition: background 0.04s linear;
  }

  .vu-footer {
    margin-top: 0.6rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .vu-scale {
    display: flex;
    justify-content: space-between;
    font-size: 0.55rem;
    color: #4A4C6E;
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.04em;
    font-weight: 600;
    padding: 0 1px;
  }

  .vu-score-row {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
  }

  .vu-num {
    font-size: 2.6rem;
    font-weight: 900;
    color: #ECEEF5;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.05em;
    line-height: 1;
  }

  .vu-grade {
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    padding: 0.2rem 0.55rem;
    border-radius: 3px;
  }

  .grade-good { background: #003D45; color: #00C4D8; }
  .grade-ok   { background: #3D2800; color: #E8A000; }
  .grade-warn { background: #2D2D00; color: #B8A000; }
  .grade-bad  { background: #3D0005; color: #FF4455; }
</style>
