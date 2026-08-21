import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mount, unmount } from 'svelte';
import { page } from 'vitest/browser';
import App from './App.svelte';

/**
 * 実データ E2E — モックを一切使わないフルフロー。
 *
 * WAVバイナリ生成 → ファイル投入 → decodeFile(Web Audio の decodeAudioData)
 * → analyzeAudio(実FFT) → 結果画面の描画 → 再生プレーヤー、までを
 * 実ブラウザ（Chromium）上でそのまま通す。
 * 単体テストが見逃す「実装同士のつなぎ目」の破綻をここで検出する。
 */

const SAMPLE_RATE  = 16000;
const DURATION_SEC = 2;

// ---- WAV エンコーダ（16bit PCM モノラル）----
function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer   = new ArrayBuffer(44 + dataSize);
  const view     = new DataView(buffer);

  const ascii = (offset: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);                              // fmt チャンクサイズ
  view.setUint16(20, 1, true);                               // フォーマット = PCM
  view.setUint16(22, 1, true);                               // チャンネル数
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);     // バイトレート
  view.setUint16(32, bytesPerSample, true);                  // ブロックアライン
  view.setUint16(34, 8 * bytesPerSample, true);              // ビット深度
  ascii(36, 'data');
  view.setUint32(40, dataSize, true);

  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * bytesPerSample, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

function makeWavFile(
  name: string,
  fill: (data: Float32Array, sampleRate: number) => void,
  durationSec = DURATION_SEC,
  sampleRate  = SAMPLE_RATE,
): File {
  const samples = new Float32Array(Math.floor(durationSec * sampleRate));
  fill(samples, sampleRate);
  return new File([encodeWav(samples, sampleRate)], name, { type: 'audio/wav' });
}

// 無音区間 + サイン波（AudioAnalyzer.test.ts のクリーン音声と同じ形）
function cleanToneWav(name = 'clean.wav', freq = 1000, amp = 0.15): File {
  return makeWavFile(name, (data, sr) => {
    const silence = Math.floor(sr * 0.3);
    for (let i = 0; i < data.length; i++) {
      data[i] = i < silence
        ? 0.003 * (Math.random() * 2 - 1)
        : amp * Math.sin((2 * Math.PI * freq * i) / sr);
    }
  });
}

// 振り切ったスクエア波（完全クリッピング）
function clippedWav(name = 'clipped.wav'): File {
  return makeWavFile(name, (data) => {
    for (let i = 0; i < data.length; i++) data[i] = i % 80 < 40 ? 1.0 : -1.0;
  });
}

// ---- マウント / 操作ヘルパー ----
let app: Record<string, unknown> | null = null;

function mountApp(): void {
  const target = document.createElement('div');
  document.body.appendChild(target);
  app = mount(App, { target });
}

function selectFile(file: File): void {
  const input = document.getElementById('fileInput') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

// 結果画面の BREAKDOWN に描画された点数（LABELS 順: volume/frequency/clip/noise）
function breakdownValues(): number[] {
  return [...document.querySelectorAll('.b-val')].map((el) => Number(el.textContent));
}

// VU メーターの aria-label に載る総合スコア
function overallScore(): number {
  const label = document.querySelector('.vu-meter')?.getAttribute('aria-label') ?? '';
  return Number(label.match(/\d+/)?.[0]);
}

function adviceTexts(): string[] {
  return [...document.querySelectorAll('.advice-list li')].map((el) => el.textContent ?? '');
}

// ファイルを投入し、結果画面が出るまで待つ
async function analyzeViaUi(file: File): Promise<void> {
  selectFile(file);
  await expect.element(page.getByText('BREAKDOWN'), { timeout: 15000 }).toBeVisible();
}

beforeEach(() => {
  document.body.innerHTML = '';
  localStorage.setItem('aqc-lang', 'ja');
});

afterEach(() => {
  if (app) { unmount(app); app = null; }
  document.body.innerHTML = '';
});

// ---- 正常系フルフロー ----
describe('E2E — 実WAVの解析フロー', () => {
  it('クリーンなトーンを投入すると結果画面の全パネルが描画される', async () => {
    mountApp();
    await analyzeViaUi(cleanToneWav());

    for (const panel of ['SOURCE AUDIO', 'SIGNAL QUALITY', 'SPECTRUM', 'BREAKDOWN']) {
      await expect.element(page.getByText(panel)).toBeVisible();
    }
  });

  it('BREAKDOWN の4項目の合計が総合スコアと一致する', async () => {
    mountApp();
    await analyzeViaUi(cleanToneWav());

    const values = breakdownValues();
    expect(values).toHaveLength(4);
    expect(values.reduce((a, b) => a + b, 0)).toBe(overallScore());
  });

  it('各項目のスコアが満点(30/30/20/20)の範囲に収まる', async () => {
    mountApp();
    await analyzeViaUi(cleanToneWav());

    const [volume, frequency, clip, noise] = breakdownValues();
    for (const v of [volume, frequency, clip, noise]) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
    expect(volume).toBeLessThanOrEqual(30);
    expect(frequency).toBeLessThanOrEqual(30);
    expect(clip).toBeLessThanOrEqual(20);
    expect(noise).toBeLessThanOrEqual(20);
  });

  it('レーダーチャートが4軸のラベルを描画する', async () => {
    mountApp();
    await analyzeViaUi(cleanToneWav());

    const svgLabels = [...document.querySelectorAll('.chart-panel svg text')].map((el) => el.textContent);
    expect(svgLabels).toEqual(['音量', '周波数バランス', '音割れ', 'ノイズ・無音']);
  });

  it('クリーンなトーンは音割れが検出されず、クリッピング項目が満点に近い', async () => {
    mountApp();
    await analyzeViaUi(cleanToneWav());

    expect(breakdownValues()[2]).toBeGreaterThan(18);
    expect(adviceTexts().some((a) => a.includes('音割れ'))).toBe(false);
  });
});

// ---- 音質の違いが画面に反映されるか ----
describe('E2E — 音質の差が結果に反映される', () => {
  it('クリッピング音声は音割れ項目が0点近くになり、アドバイスが表示される', async () => {
    mountApp();
    await analyzeViaUi(clippedWav());

    expect(breakdownValues()[2]).toBeLessThan(5);
    await expect.element(page.getByText('アドバイス')).toBeVisible();
    expect(adviceTexts().some((a) => a.includes('音割れ'))).toBe(true);
  });

  it('クリーンなトーンはクリッピング音声より総合スコアが高い', async () => {
    mountApp();
    await analyzeViaUi(cleanToneWav());
    const cleanOverall = overallScore();

    await page.getByRole('button', { name: 'もう一度チェックする' }).click();
    await expect.element(page.getByText('WAV / MP3 をドロップ')).toBeVisible();

    await analyzeViaUi(clippedWav());
    expect(cleanOverall).toBeGreaterThan(overallScore());
  });
});

// ---- 再生プレーヤー ----
describe('E2E — 再生プレーヤー', () => {
  it('投入した音声が blob URL として読み込まれ、長さを取得できる', async () => {
    mountApp();
    await analyzeViaUi(cleanToneWav());

    const audio = document.querySelector('audio') as HTMLAudioElement;
    expect(audio.src.startsWith('blob:')).toBe(true);
    await expect.poll(() => audio.duration, { timeout: 5000 }).toBeGreaterThan(1.5);
  });

  it('再生ボタンで実際に再生が始まり、もう一度押すと停止する', async () => {
    mountApp();
    await analyzeViaUi(cleanToneWav());

    const audio = document.querySelector('audio') as HTMLAudioElement;
    await page.getByRole('button', { name: 'Play' }).click();
    await expect.poll(() => audio.paused, { timeout: 5000 }).toBe(false);

    await page.getByRole('button', { name: 'Pause' }).click();
    await expect.poll(() => audio.paused, { timeout: 5000 }).toBe(true);
  });
});

// ---- 異常系 / 復帰 ----
describe('E2E — 異常系と復帰', () => {
  it('デコードできないWAVは解析失敗エラーを表示する', async () => {
    mountApp();
    selectFile(new File(['これはWAVではありません'], 'broken.wav', { type: 'audio/wav' }));

    await expect.element(page.getByText(/解析に失敗しました/), { timeout: 15000 }).toBeVisible();
  });

  it('解析失敗のあとに正しいWAVを入れ直すと結果画面へ進める', async () => {
    mountApp();
    selectFile(new File(['これはWAVではありません'], 'broken.wav', { type: 'audio/wav' }));
    await expect.element(page.getByText(/解析に失敗しました/), { timeout: 15000 }).toBeVisible();

    await analyzeViaUi(cleanToneWav('retry.wav'));
    expect(document.body.textContent).not.toContain('解析に失敗しました');
  });

  it('リセット後に別のWAVを投入して再解析できる', async () => {
    mountApp();
    await analyzeViaUi(cleanToneWav('first.wav', 1000));

    await page.getByRole('button', { name: 'もう一度チェックする' }).click();
    await expect.element(page.getByText('WAV / MP3 をドロップ')).toBeVisible();

    await analyzeViaUi(cleanToneWav('second.wav', 440));
    expect(breakdownValues()).toHaveLength(4);
  });
});

// ---- 多言語 ----
describe('E2E — 言語切替と実解析の組み合わせ', () => {
  it('EN に切り替えたまま解析すると英語のカテゴリ名で結果が出る', async () => {
    mountApp();
    await page.getByRole('button', { name: 'EN' }).click();
    await expect.element(page.getByText('Drop WAV / MP3')).toBeVisible();

    selectFile(cleanToneWav());
    await expect.element(page.getByText('BREAKDOWN'), { timeout: 15000 }).toBeVisible();

    const names = [...document.querySelectorAll('.b-name')].map((el) => el.textContent);
    expect(names).toEqual(['Volume', 'Frequency Balance', 'Clipping', 'Noise/Silence']);
  });
});
