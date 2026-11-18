<script lang="ts">
  import { MediaQuery } from 'svelte/reactivity';
  import { segColor, gradeCls, SEGMENTS } from './scores.ts';
  import type { QualityText } from './i18n.ts';

  interface Props {
    score: number;
    t: QualityText;
  }

  let { score, t }: Props = $props();

  let displayed = $state(0);

  // 「視差効果を減らす」を選んでいる人には数え上げを見せず、最初から点数を出す。
  // MediaQuery は設定が途中で変わっても追従する
  const reducedMotion = new MediaQuery('(prefers-reduced-motion: reduce)');

  function easeOut(x: number): number { return 1 - Math.pow(1 - x, 3); }

  $effect(() => {
    const target = score;
    if (reducedMotion.current) {
      displayed = target;
      return;
    }
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
    background: var(--vu-board);
    border: 1px solid var(--vu-edge);
    border-radius: var(--tk-radius);

    /* 板は明暗どちらでも暗いので、目盛りは暗い板の上で読める採点色に差し替える
       （scores.ts の segColor は var(--score-…) を返す） */
    --score-good: var(--vu-good);
    --score-ok:   var(--vu-ok);
    --score-warn: var(--vu-warn);
    --score-bad:  var(--vu-bad);
    padding: 1.4rem 1.25rem 1.1rem;
  }

  .vu-eyebrow {
    font-size: 0.6rem;
    font-weight: 700;
    letter-spacing: 0.16em;
    color: var(--vu-label);
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
    background: var(--vu-seg-off);
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
    color: var(--vu-scale);
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
    color: var(--vu-num);
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

  .grade-good { background: var(--vu-good-bg); color: var(--vu-good); }
  .grade-ok   { background: var(--vu-ok-bg);   color: var(--vu-ok); }
  .grade-warn { background: var(--vu-warn-bg); color: var(--vu-warn); }
  .grade-bad  { background: var(--vu-bad-bg);  color: var(--vu-bad); }
</style>
