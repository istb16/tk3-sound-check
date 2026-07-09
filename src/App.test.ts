import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from 'svelte';
import { page } from 'vitest/browser';
import type { AudioScores } from './lib/AudioAnalyzer.ts';

// vi.mock はホイストされるため、他のインポートより先に実行される
vi.mock('./lib/audio.ts', () => ({
  decodeFile:       vi.fn(),
  recordMicrophone: vi.fn(),
}));
vi.mock('./lib/AudioAnalyzer.ts', () => ({
  analyzeAudio: vi.fn(),
}));

import App from './App.svelte';
import { decodeFile, recordMicrophone } from './lib/audio.ts';
import { analyzeAudio } from './lib/AudioAnalyzer.ts';

// recordMicrophone は現時点のテストでは使用しないが、モック登録のためインポート
// 使用する場合は { buffer: AudioBuffer, blob: Blob } を返すようにモックすること
void recordMicrophone;

function mountApp(): void {
  const target = document.createElement('div');
  document.body.appendChild(target);
  mount(App, { target });
}

beforeEach(() => {
  document.body.innerHTML = '';
  localStorage.setItem('aqc-lang', 'ja');
  vi.clearAllMocks();
});

// ---- アイドル状態 ----
describe('App — アイドル状態', () => {
  it('タイトル「音質チェッカー」が表示される', async () => {
    mountApp();
    await expect.element(page.getByText('音質チェッカー')).toBeVisible();
  });

  it('AUDIO QUALITY のアイキャッチが表示される', async () => {
    mountApp();
    await expect.element(page.getByText('AUDIO QUALITY')).toBeVisible();
  });

  it('ドロップゾーンが表示される', async () => {
    mountApp();
    await expect.element(page.getByText('WAV / MP3 をドロップ')).toBeVisible();
  });

  it('マイク録音ボタンが表示される', async () => {
    mountApp();
    await expect.element(page.getByRole('button', { name: /マイクで録音/ })).toBeVisible();
  });

  it('ファイル入力が audio/* を受け付ける', async () => {
    mountApp();
    const input = document.getElementById('fileInput') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.accept).toContain('audio');
  });
});

// ---- エラー処理 ----
describe('App — エラー処理', () => {
  it('非音声ファイルを選択するとエラーメッセージが表示される', async () => {
    mountApp();
    const input = document.getElementById('fileInput') as HTMLInputElement;
    const file  = new File(['dummy content'], 'document.txt', { type: 'text/plain' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));

    await expect.element(page.getByText(/WAV または MP3/)).toBeVisible();
  });
});

// ---- 解析結果表示 ----
describe('App — 解析結果表示', () => {
  const mockScores: AudioScores = {
    overall: 82, volume: 25, frequency: 24, clip: 18, noise: 15, advice: ['声の明瞭度がやや低めです。マイクを口元に向け、はっきりと発声してください。'],
  };

  it('WAV ファイルを投入すると結果セクションが表示される', async () => {
    vi.mocked(decodeFile).mockResolvedValue({ sampleRate: 16000 } as unknown as AudioBuffer);
    vi.mocked(analyzeAudio).mockResolvedValue(mockScores);

    mountApp();
    const input = document.getElementById('fileInput') as HTMLInputElement;
    const file  = new File(['RIFF....'], 'sample.wav', { type: 'audio/wav' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));

    await expect.element(page.getByText('SIGNAL QUALITY')).toBeVisible({ timeout: 3000 });
    await expect.element(page.getByText('BREAKDOWN')).toBeVisible();
  });

  it('カテゴリ名（音量・周波数バランス・音割れ・ノイズ／無音）がすべて表示される', async () => {
    vi.mocked(decodeFile).mockResolvedValue({ sampleRate: 16000 } as unknown as AudioBuffer);
    vi.mocked(analyzeAudio).mockResolvedValue(mockScores);

    mountApp();
    const input = document.getElementById('fileInput') as HTMLInputElement;
    const file  = new File(['RIFF....'], 'sample.wav', { type: 'audio/wav' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));

    await expect.element(page.getByText('SIGNAL QUALITY')).toBeVisible({ timeout: 3000 });

    const list = page.getByRole('list');
    for (const label of ['音量', '周波数バランス', '音割れ', 'ノイズ・無音']) {
      await expect.element(list.getByText(label, { exact: true })).toBeVisible();
    }
  });

  it('「もう一度チェックする」ボタンでアイドル状態に戻る', async () => {
    vi.mocked(decodeFile).mockResolvedValue({ sampleRate: 16000 } as unknown as AudioBuffer);
    vi.mocked(analyzeAudio).mockResolvedValue(mockScores);

    mountApp();
    const input = document.getElementById('fileInput') as HTMLInputElement;
    const file  = new File(['RIFF....'], 'sample.wav', { type: 'audio/wav' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));

    const resetBtn = page.getByRole('button', { name: /もう一度チェックする/ });
    await expect.element(resetBtn).toBeVisible({ timeout: 3000 });
    await resetBtn.click();

    await expect.element(page.getByText('WAV / MP3 をドロップ')).toBeVisible();
  });
});
