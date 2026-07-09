<script lang="ts">
  interface Props {
    type: 'recording' | 'analyzing';
    progress?: number;
    durationSec?: number;
  }

  let { type, progress = 0, durationSec = 15 }: Props = $props();
</script>

<section class="status-section">
  {#if type === 'recording'}
    <div class="rec-indicator">
      <span class="rec-dot"></span>
      <span class="rec-label">REC</span>
    </div>
    <p class="status-text">
      <span class="status-num">{Math.round(progress * durationSec)}</span>
      <span class="status-denom">/ {durationSec} sec</span>
    </p>
    <div class="progress-track">
      <div class="progress-fill" style="width:{progress * 100}%"></div>
    </div>
  {:else}
    <div class="analyze-ring"></div>
    <p class="status-text">ANALYZING&thinsp;…</p>
  {/if}
</section>

<style>
  .status-section {
    background: #FFFFFF;
    border: 1px solid #CDD0E0;
    border-radius: 6px;
    padding: 3rem 1.5rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1.25rem;
  }

  .rec-indicator {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  @keyframes rec-blink { 0%,100% { opacity: 1; } 50% { opacity: 0; } }

  .rec-dot {
    width: 10px;
    height: 10px;
    background: #BF0009;
    border-radius: 50%;
    animation: rec-blink 1s ease-in-out infinite;
  }

  .rec-label {
    font-size: 0.65rem;
    font-weight: 700;
    letter-spacing: 0.14em;
    color: #BF0009;
  }

  .status-text {
    font-size: 0.85rem;
    color: #474964;
    letter-spacing: 0.05em;
    font-weight: 600;
  }

  .status-num {
    font-size: 1.4rem;
    font-weight: 900;
    color: #1A1C2E;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.03em;
  }

  .status-denom {
    font-size: 0.8rem;
    color: #8A8CA8;
    margin-left: 0.15rem;
  }

  .progress-track {
    width: 100%;
    height: 3px;
    background: #DDE0EE;
    border-radius: 9999px;
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    background: #006E80;
    border-radius: 9999px;
    transition: width 0.1s linear;
  }

  @keyframes ring-spin { to { transform: rotate(360deg); } }

  .analyze-ring {
    width: 32px;
    height: 32px;
    border: 2.5px solid #DDE0EE;
    border-top-color: #006E80;
    border-radius: 50%;
    animation: ring-spin 0.8s linear infinite;
  }

  @media (prefers-reduced-motion: reduce) {
    .analyze-ring, .rec-dot { animation: none; }
    .progress-fill { transition: none; }
  }
</style>
