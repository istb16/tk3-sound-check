<script lang="ts">
  import type { Translations } from './i18n.ts';

  interface Props {
    t: Translations;
    recordDuration: number;
    errorMsg?: string;
    onFile: (file: File) => void;
    onRecord: () => void;
  }

  let { t, recordDuration, errorMsg = '', onFile, onRecord }: Props = $props();
  let dragOver = $state(false);

  function handleDrop(e: DragEvent): void {
    dragOver = false;
    const file = e.dataTransfer?.files?.[0];
    if (file) onFile(file);
  }

  function handleInput(e: Event): void {
    const input = e.target as HTMLInputElement;
    if (input.files?.[0]) onFile(input.files[0]);
    input.value = '';
  }

  function handleDropzoneKey(e: KeyboardEvent): void {
    if (e.key === 'Enter' || e.key === ' ') {
      (document.getElementById('fileInput') as HTMLInputElement).click();
    }
  }
</script>

<section class="input-section">
  <div
    class="dropzone"
    class:drag-over={dragOver}
    role="button"
    tabindex="0"
    aria-label={t.dropAriaLabel}
    ondragover={(e) => { e.preventDefault(); dragOver = true; }}
    ondragleave={() => (dragOver = false)}
    ondrop={(e) => { e.preventDefault(); handleDrop(e); }}
    onclick={() => (document.getElementById('fileInput') as HTMLInputElement).click()}
    onkeydown={handleDropzoneKey}
  >
    <svg class="bg-wave" viewBox="0 0 400 60" preserveAspectRatio="none" aria-hidden="true">
      <path
        d="M0,30 C8,10 17,10 25,30 C33,50 42,50 50,30 C58,10 67,10 75,30 C83,50 92,50 100,30 C108,10 117,10 125,30 C133,50 142,50 150,30 C158,10 167,10 175,30 C183,50 192,50 200,30 C208,10 217,10 225,30 C233,50 242,50 250,30 C258,10 267,10 275,30 C283,50 292,50 300,30 C308,10 317,10 325,30 C333,50 342,50 350,30 C358,10 367,10 375,30 C383,50 392,50 400,30"
        fill="none" stroke="#006E80" stroke-width="1.5"
      />
    </svg>
    <div class="drop-content">
      <p class="drop-main">{t.dropMain}</p>
      <p class="drop-sub">{t.dropSub}</p>
    </div>
  </div>

  <input id="fileInput" type="file" accept=".wav,.mp3,.ogg,.webm,audio/*" style="display:none" onchange={handleInput} />

  <div class="or-divider"><span>{t.or}</span></div>

  <button class="btn-mic" onclick={onRecord}>
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="17" height="17" aria-hidden="true">
      <rect x="7" y="2" width="6" height="10" rx="3"/>
      <path d="M4 10a6 6 0 0 0 12 0"/>
      <line x1="10" y1="16" x2="10" y2="19"/>
      <line x1="7" y1="19" x2="13" y2="19"/>
    </svg>
    {t.micBtn(recordDuration / 1000)}
  </button>

  {#if errorMsg}
    <div class="error-box" role="alert">
      <svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14" aria-hidden="true">
        <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 3.5a.75.75 0 0 1 .75.75v3a.75.75 0 0 1-1.5 0v-3A.75.75 0 0 1 8 4.5zm0 6.5a.875.875 0 1 1 0-1.75A.875.875 0 0 1 8 11z"/>
      </svg>
      {errorMsg}
    </div>
  {/if}
</section>

<style>
  .input-section {
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
  }

  .dropzone {
    position: relative;
    background: #FFFFFF;
    border: 1.5px solid #CDD0E0;
    border-radius: 6px;
    padding: 2.75rem 1.5rem;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    outline: none;
    overflow: hidden;
    transition: border-color 0.15s;
  }

  .dropzone:hover, .dropzone:focus-visible, .dropzone.drag-over {
    border-color: #006E80;
  }

  .bg-wave {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    opacity: 0.1;
    transition: opacity 0.25s;
    pointer-events: none;
  }

  .dropzone:hover .bg-wave,
  .dropzone:focus-visible .bg-wave,
  .dropzone.drag-over .bg-wave {
    opacity: 0.28;
  }

  .drop-content {
    position: relative;
    text-align: center;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .drop-main {
    font-size: 0.92rem;
    font-weight: 700;
    color: #1A1C2E;
    letter-spacing: -0.01em;
  }

  .drop-sub {
    font-size: 0.75rem;
    color: #8A8CA8;
    letter-spacing: 0.02em;
  }

  .or-divider {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    font-size: 0.65rem;
    font-weight: 700;
    letter-spacing: 0.1em;
    color: #AEB1CB;
  }

  .or-divider::before, .or-divider::after {
    content: '';
    flex: 1;
    height: 1px;
    background: #CDD0E0;
  }

  .btn-mic {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.85rem;
    background: #1A1C2E;
    color: #ECEEF5;
    border: none;
    border-radius: 6px;
    font-size: 0.92rem;
    font-weight: 700;
    letter-spacing: -0.01em;
    cursor: pointer;
    transition: background 0.15s;
  }

  .btn-mic:hover { background: #2E3050; }
  .btn-mic:focus-visible { outline: 2px solid #006E80; outline-offset: 2px; }

  .error-box {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    background: #FFF2F2;
    border: 1px solid #F0C0C0;
    border-radius: 5px;
    padding: 0.7rem 0.9rem;
    font-size: 0.8rem;
    color: #BF0009;
    font-weight: 500;
  }
</style>
