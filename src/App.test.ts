import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, unmount } from 'svelte';
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

// 実データを通したフルフローは e2e.test.ts が担当する。
// このファイルは audio.ts / AudioAnalyzer.ts をモックし、UI の状態遷移のみを検証する。

let app: Record<string, unknown> | null = null;

function mountApp(): void {
  const target = document.createElement('div');
  document.body.appendChild(target);
  app = mount(App, { target });
}

const mockScores: AudioScores = {
  overall: 82, volume: 25, frequency: 24, clip: 18, noise: 15,
  advice: ['声の明瞭度がやや低めです。マイクを口元に向け、はっきりと発声してください。'],
};

const wavFile = (name = 'sample.wav'): File =>
  new File(['RIFF....'], name, { type: 'audio/wav' });

// 解析が成功する状態にモックを整える
function mockAnalysisSuccess(scores: AudioScores = mockScores): void {
  vi.mocked(decodeFile).mockResolvedValue({ sampleRate: 16000 } as unknown as AudioBuffer);
  vi.mocked(analyzeAudio).mockResolvedValue(scores);
}

function selectFile(file: File): void {
  const input = document.getElementById('fileInput') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function dropFile(file: File): void {
  const dropzone = document.querySelector('.dropzone') as HTMLElement;
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(file);
  dropzone.dispatchEvent(new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true }));
}

function dispatchDrag(type: 'dragover' | 'dragleave'): void {
  const dropzone = document.querySelector('.dropzone') as HTMLElement;
  dropzone.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true }));
}

// テスト側から解決タイミングを制御できる Promise
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

beforeEach(() => {
  document.body.innerHTML = '';
  localStorage.setItem('aqc-lang', 'ja');
  vi.clearAllMocks();
});

afterEach(() => {
  if (app) { unmount(app); app = null; }
  document.body.innerHTML = '';
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

  it('マイク録音ボタンに録音秒数が表示される', async () => {
    mountApp();
    await expect.element(page.getByRole('button', { name: 'マイクで録音（10秒）' })).toBeVisible();
  });

  it('ファイル入力が audio/* を受け付ける', async () => {
    mountApp();
    const input = document.getElementById('fileInput') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.accept).toContain('audio');
  });
});

// ---- ドラッグ&ドロップ ----
describe('App — ドラッグ&ドロップ', () => {
  it('dragover でドロップゾーンが強調され、dragleave で解除される', async () => {
    mountApp();
    const dropzone = document.querySelector('.dropzone') as HTMLElement;

    dispatchDrag('dragover');
    await expect.poll(() => dropzone.classList.contains('drag-over')).toBe(true);

    dispatchDrag('dragleave');
    await expect.poll(() => dropzone.classList.contains('drag-over')).toBe(false);
  });

  it('ファイルをドロップすると解析が始まり結果が表示される', async () => {
    mockAnalysisSuccess();
    mountApp();
    dropFile(wavFile());

    await expect.element(page.getByText('SIGNAL QUALITY'), { timeout: 3000 }).toBeVisible();
    expect(vi.mocked(decodeFile)).toHaveBeenCalledOnce();
  });

  it('非音声ファイルをドロップするとエラーになり解析は走らない', async () => {
    mountApp();
    dropFile(new File(['x'], 'document.txt', { type: 'text/plain' }));

    await expect.element(page.getByText(/WAV または MP3/)).toBeVisible();
    expect(vi.mocked(decodeFile)).not.toHaveBeenCalled();
  });
});

// ---- 言語切替 ----
describe('App — 言語切替', () => {
  it('EN ボタンで UI が英語表示になる', async () => {
    mountApp();
    await page.getByRole('button', { name: 'EN' }).click();

    await expect.element(page.getByText('Audio Quality Checker')).toBeVisible();
    await expect.element(page.getByText('Drop WAV / MP3')).toBeVisible();
  });

  it('選択した言語が localStorage に保存される', async () => {
    mountApp();
    await page.getByRole('button', { name: 'EN' }).click();
    await expect.poll(() => localStorage.getItem('aqc-lang')).toBe('en');

    await page.getByRole('button', { name: 'JA' }).click();
    await expect.poll(() => localStorage.getItem('aqc-lang')).toBe('ja');
  });

  it('結果表示中に言語を切り替えるとカテゴリ名も切り替わる', async () => {
    mockAnalysisSuccess();
    mountApp();
    selectFile(wavFile());
    await expect.element(page.getByText('BREAKDOWN'), { timeout: 3000 }).toBeVisible();

    const names = (): (string | null)[] =>
      [...document.querySelectorAll('.b-name')].map((el) => el.textContent);
    expect(names()).toEqual(['音量', '周波数バランス', '音割れ', 'ノイズ・無音']);

    await page.getByRole('button', { name: 'EN' }).click();
    await expect.poll(names).toEqual(['Volume', 'Frequency Balance', 'Clipping', 'Noise/Silence']);
  });

  it('エラーメッセージも言語切替に追従する', async () => {
    mountApp();
    selectFile(new File(['x'], 'document.txt', { type: 'text/plain' }));
    await expect.element(page.getByText(/WAV または MP3/)).toBeVisible();

    await page.getByRole('button', { name: 'EN' }).click();
    await expect.element(page.getByText('Please select a WAV or MP3 file.')).toBeVisible();
  });
});

// ---- 録音フロー ----
describe('App — 録音フロー', () => {
  it('録音中は REC 表示と経過秒数の進捗が出る', async () => {
    const rec = deferred<{ buffer: AudioBuffer; blob: Blob }>();
    vi.mocked(recordMicrophone).mockImplementation((_ms, onTick) => {
      onTick?.(0.5);
      return rec.promise;
    });
    mountApp();
    await page.getByRole('button', { name: /マイクで録音/ }).click();

    await expect.element(page.getByText('REC')).toBeVisible();
    await expect.element(page.getByText('/ 10 sec')).toBeVisible();
    await expect.poll(() => (document.querySelector('.progress-fill') as HTMLElement | null)?.style.width)
      .toBe('50%');
  });

  it('録音完了後に解析へ進み結果が表示される', async () => {
    const rec = deferred<{ buffer: AudioBuffer; blob: Blob }>();
    vi.mocked(recordMicrophone).mockReturnValue(rec.promise);
    vi.mocked(analyzeAudio).mockResolvedValue(mockScores);

    mountApp();
    await page.getByRole('button', { name: /マイクで録音/ }).click();
    await expect.element(page.getByText('REC')).toBeVisible();

    rec.resolve({
      buffer: { sampleRate: 48000 } as unknown as AudioBuffer,
      blob:   new Blob(['audio'], { type: 'audio/webm' }),
    });

    await expect.element(page.getByText('SIGNAL QUALITY'), { timeout: 3000 }).toBeVisible();
    await expect.element(page.getByText('SOURCE AUDIO')).toBeVisible();
  });

  it('マイクが拒否されると許可を促すエラーが表示される', async () => {
    const denied = new Error('Permission denied');
    denied.name = 'NotAllowedError';
    vi.mocked(recordMicrophone).mockRejectedValue(denied);

    mountApp();
    await page.getByRole('button', { name: /マイクで録音/ }).click();

    await expect.element(page.getByText(/マイクへのアクセスが拒否されました/)).toBeVisible();
  });

  it('録音自体が失敗すると理由付きのエラーが表示される', async () => {
    vi.mocked(recordMicrophone).mockRejectedValue(new Error('device busy'));

    mountApp();
    await page.getByRole('button', { name: /マイクで録音/ }).click();

    await expect.element(page.getByText('録音に失敗しました: device busy')).toBeVisible();
  });

  it('録音エラーのあとにファイル投入で復帰できる', async () => {
    vi.mocked(recordMicrophone).mockRejectedValue(new Error('device busy'));
    mountApp();
    await page.getByRole('button', { name: /マイクで録音/ }).click();
    await expect.element(page.getByText(/録音に失敗しました/)).toBeVisible();

    mockAnalysisSuccess();
    selectFile(wavFile());
    await expect.element(page.getByText('SIGNAL QUALITY'), { timeout: 3000 }).toBeVisible();
  });
});

// ---- 解析中 / 解析失敗 ----
describe('App — 解析中と解析失敗', () => {
  it('解析中は ANALYZING が表示される', async () => {
    const pending = deferred<AudioScores>();
    vi.mocked(decodeFile).mockResolvedValue({ sampleRate: 16000 } as unknown as AudioBuffer);
    vi.mocked(analyzeAudio).mockReturnValue(pending.promise);

    mountApp();
    selectFile(wavFile());
    await expect.element(page.getByText(/ANALYZING/)).toBeVisible();

    pending.resolve(mockScores);
    await expect.element(page.getByText('SIGNAL QUALITY'), { timeout: 3000 }).toBeVisible();
  });

  it('解析が失敗すると理由付きのエラーが表示される', async () => {
    vi.mocked(decodeFile).mockResolvedValue({ sampleRate: 16000 } as unknown as AudioBuffer);
    vi.mocked(analyzeAudio).mockRejectedValue(new Error('unsupported codec'));

    mountApp();
    selectFile(wavFile());

    await expect.element(page.getByText('解析に失敗しました: unsupported codec')).toBeVisible();
  });

  it('デコードが失敗した場合もエラーが表示される', async () => {
    vi.mocked(decodeFile).mockRejectedValue(new Error('EncodingError'));

    mountApp();
    selectFile(wavFile());

    await expect.element(page.getByText(/解析に失敗しました: EncodingError/)).toBeVisible();
    expect(vi.mocked(analyzeAudio)).not.toHaveBeenCalled();
  });
});

// ---- エラー処理 ----
describe('App — エラー処理', () => {
  it('非音声ファイルを選択するとエラーメッセージが表示される', async () => {
    mountApp();
    selectFile(new File(['dummy content'], 'document.txt', { type: 'text/plain' }));

    await expect.element(page.getByText(/WAV または MP3/)).toBeVisible();
  });

  it('拡張子が音声なら MIME が空でも受け付ける', async () => {
    mockAnalysisSuccess();
    mountApp();
    selectFile(new File(['RIFF....'], 'recording.ogg', { type: '' }));

    await expect.element(page.getByText('SIGNAL QUALITY'), { timeout: 3000 }).toBeVisible();
  });
});

// ---- 解析結果表示 ----
describe('App — 解析結果表示', () => {
  it('WAV ファイルを投入すると結果セクションが表示される', async () => {
    mockAnalysisSuccess();
    mountApp();
    selectFile(wavFile());

    await expect.element(page.getByText('SIGNAL QUALITY'), { timeout: 3000 }).toBeVisible();
    await expect.element(page.getByText('BREAKDOWN')).toBeVisible();
  });

  it('カテゴリ名（音量・周波数バランス・音割れ・ノイズ／無音）がすべて表示される', async () => {
    mockAnalysisSuccess();
    mountApp();
    selectFile(wavFile());

    await expect.element(page.getByText('SIGNAL QUALITY'), { timeout: 3000 }).toBeVisible();

    const list = page.getByRole('list');
    for (const label of ['音量', '周波数バランス', '音割れ', 'ノイズ・無音']) {
      await expect.element(list.getByText(label, { exact: true })).toBeVisible();
    }
  });

  it('各カテゴリの点数と総合スコアが解析結果どおりに描画される', async () => {
    mockAnalysisSuccess();
    mountApp();
    selectFile(wavFile());
    await expect.element(page.getByText('BREAKDOWN'), { timeout: 3000 }).toBeVisible();

    const values = [...document.querySelectorAll('.b-val')].map((el) => Number(el.textContent));
    expect(values).toEqual([25, 24, 18, 15]);
    expect(document.querySelector('.vu-meter')?.getAttribute('aria-label')).toBe('総合スコア 82点');
  });

  it('アドバイスがある場合はアドバイスパネルが表示される', async () => {
    mockAnalysisSuccess();
    mountApp();
    selectFile(wavFile());
    await expect.element(page.getByText('BREAKDOWN'), { timeout: 3000 }).toBeVisible();

    await expect.element(page.getByText('アドバイス')).toBeVisible();
    expect(document.querySelectorAll('.advice-list li')).toHaveLength(1);
  });

  it('アドバイスが空の場合はアドバイスパネルが表示されない', async () => {
    mockAnalysisSuccess({ ...mockScores, advice: [] });
    mountApp();
    selectFile(wavFile());
    await expect.element(page.getByText('BREAKDOWN'), { timeout: 3000 }).toBeVisible();

    expect(document.querySelector('.advice-list')).toBeNull();
  });

  it('「もう一度チェックする」ボタンでアイドル状態に戻る', async () => {
    mockAnalysisSuccess();
    mountApp();
    selectFile(wavFile());

    const resetBtn = page.getByRole('button', { name: /もう一度チェックする/ });
    await expect.element(resetBtn, { timeout: 3000 }).toBeVisible();
    await resetBtn.click();

    await expect.element(page.getByText('WAV / MP3 をドロップ')).toBeVisible();
  });

  it('リセット後に別のファイルを投入すると再解析される', async () => {
    mockAnalysisSuccess();
    mountApp();
    selectFile(wavFile('first.wav'));

    const resetBtn = page.getByRole('button', { name: /もう一度チェックする/ });
    await expect.element(resetBtn, { timeout: 3000 }).toBeVisible();
    await resetBtn.click();
    await expect.element(page.getByText('WAV / MP3 をドロップ')).toBeVisible();

    mockAnalysisSuccess({ ...mockScores, overall: 40, volume: 10, frequency: 10, clip: 10, noise: 10 });
    selectFile(wavFile('second.wav'));

    await expect.element(page.getByText('BREAKDOWN'), { timeout: 3000 }).toBeVisible();
    await expect.poll(() => document.querySelector('.vu-meter')?.getAttribute('aria-label'))
      .toBe('総合スコア 40点');
    expect(vi.mocked(analyzeAudio)).toHaveBeenCalledTimes(2);
  });
});
