<script lang="ts">
  /**
   * マイク録音の案内。
   *
   * 録音前と**録音中の両方**で出す。録音中に読み上げ文が消えると、話す内容を
   * 思い出しながら喋ることになり、間の取り方が不自然になる。発話区間と無音区間の
   * 両方が無いとSNRも残響も測れないので、案内が見えていること自体が測定の前提。
   */
  import type { QualityText } from './i18n.ts';

  interface Props {
    t: QualityText;
  }

  let { t }: Props = $props();
</script>

<div class="mic-guide">
  <p class="mic-hint">{t.micHint}</p>
  <p class="mic-script-label">{t.micScriptLabel}</p>
  <ul class="mic-script">
    {#each t.micScript as line}
      <li>{line}</li>
    {/each}
  </ul>
</div>

<style>
  .mic-guide {
    margin-top: 0.9rem;
    padding: 0.85rem 1rem;
    background: #F5F6FB;
    border: 1px solid #DDE0EE;
    border-radius: 6px;
  }

  .mic-hint {
    font-size: 0.78rem;
    line-height: 1.65;
    color: #3C3E58;
  }

  .mic-script-label {
    margin-top: 0.7rem;
    font-size: 0.6rem;
    font-weight: 700;
    letter-spacing: 0.14em;
    color: #8A8CA8;
    text-transform: uppercase;
  }

  .mic-script {
    list-style: none;
    margin-top: 0.35rem;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .mic-script li {
    font-size: 0.82rem;
    line-height: 1.6;
    color: #1A1C2E;
    font-weight: 700;
  }
</style>
