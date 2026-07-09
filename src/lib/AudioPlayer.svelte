<script lang="ts">
  let { src }: { src: string } = $props();

  let audioEl: HTMLAudioElement | null = $state(null);
  let paused      = $state(true);
  let currentTime = $state(0);
  let duration    = $state(0);

  function toggle() {
    if (!audioEl) return;
    if (paused) audioEl.play();
    else audioEl.pause();
  }

  function seek(e: Event) {
    if (!audioEl) return;
    audioEl.currentTime = Number((e.target as HTMLInputElement).value);
  }

  function fmt(sec: number): string {
    if (!isFinite(sec) || sec < 0) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }
</script>

<div class="panel player-panel">
  <p class="panel-label">SOURCE AUDIO</p>
  <audio
    bind:this={audioEl}
    {src}
    onplay={() => (paused = false)}
    onpause={() => (paused = true)}
    onended={() => { paused = true; if (audioEl) audioEl.currentTime = 0; }}
    ontimeupdate={() => { if (audioEl) currentTime = audioEl.currentTime; }}
    onloadedmetadata={() => { if (audioEl) duration = audioEl.duration; }}
  ></audio>
  <div class="controls">
    <button class="play-btn" onclick={toggle} aria-label={paused ? 'Play' : 'Pause'}>
      {#if paused}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M8 5v14l11-7z"/>
        </svg>
      {:else}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M6 19h4V5H6zm8-14v14h4V5z"/>
        </svg>
      {/if}
    </button>
    <div class="progress-wrap">
      <input
        type="range"
        class="seek"
        min="0"
        max={duration || 0}
        step="0.01"
        value={currentTime}
        oninput={seek}
        aria-label="Seek"
      />
      <div class="times">
        <span>{fmt(currentTime)}</span>
        <span>{fmt(duration)}</span>
      </div>
    </div>
  </div>
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
    margin-bottom: 0.85rem;
    text-transform: uppercase;
  }

  .controls {
    display: flex;
    align-items: center;
    gap: 0.85rem;
  }

  .play-btn {
    width: 2.25rem;
    height: 2.25rem;
    border-radius: 50%;
    background: #1A1C2E;
    color: #ECEEF5;
    border: none;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: background 0.15s;
  }

  .play-btn:hover { background: #006E80; }
  .play-btn:focus-visible { outline: 2px solid #006E80; outline-offset: 2px; }

  .progress-wrap {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    min-width: 0;
  }

  .seek {
    width: 100%;
    height: 4px;
    cursor: pointer;
    accent-color: #006E80;
  }

  .times {
    display: flex;
    justify-content: space-between;
    font-size: 0.65rem;
    color: #8A8CA8;
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.02em;
  }
</style>
