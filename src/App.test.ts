import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, unmount } from 'svelte';
import { page } from 'vitest/browser';

// vi.mock はホイストされるため、他のインポートより先に実行される
vi.mock('./lib/audio.ts', () => ({
  decodeFile:       vi.fn(),
  recordMicrophone: vi.fn(),
  startMonitor:     vi.fn(),
}));
vi.mock('./features/quality/AudioAnalyzer.ts', () => ({
  analyzeAudio: vi.fn(),
}));

import App from './App.svelte';
import { router, normalizePath } from './shell/router.svelte.ts';
import { decodeFile, startMonitor } from './lib/audio.ts';
import { analyzeAudio, type AudioScores } from './features/quality/AudioAnalyzer.ts';

/**
 * シェルのテスト。ルーティング・ヘッダー・言語切替を見る。
 *
 * 個々の機能の中身は各機能のテストが見る（音質チェックなら
 * features/quality/QualityCheck.test.ts）。ここで機能の内部に踏み込むのは、
 * 言語がシェルから機能へ伝わることを確かめる箇所だけ。
 */

let app: Record<string, unknown> | null = null;
const originalUrl = location.pathname + location.search;

function mountApp(): void {
  const target = document.createElement('div');
  document.body.appendChild(target);
  app = mount(App, { target });
}

const mockScores: AudioScores = {
  overall: 82, noise: 22, reverb: 17, frequency: 21, volume: 13, clip: 9,
  advice: [],
  provenance: {
    bandwidthHz: 8000, cutoffDropDb: 4, silenceFloorDb: -52,
    maxZeroRunMs: 0, processed: false, flags: [],
  },
  rt60Sec: 0.45,
  unreliable: [],
  verdict: { level: 'usable', limitingAxis: 'clip', unconfirmed: false },
  measured: { snrDb: 28.4, rt60Sec: 0.45, bandwidthHz: 8000, activeSpeechDbfs: -17.2, clipRate: 0 },
};

function selectFile(file: File): void {
  const input = document.getElementById('fileInput') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

beforeEach(() => {
  document.body.innerHTML = '';
  localStorage.setItem('aqc-lang', 'ja');
  vi.clearAllMocks();
  // ルーターはモジュール状態なのでテスト間で持ち越される
  router.path = '/';
});

afterEach(() => {
  if (app) { unmount(app); app = null; }
  document.body.innerHTML = '';
  history.replaceState({}, '', originalUrl);
});

describe('normalizePath', () => {
  it('末尾スラッシュを落とす', () => {
    expect(normalizePath('/quality/')).toBe('/quality');
  });

  it('空とルートは / になる', () => {
    expect(normalizePath('/')).toBe('/');
    expect(normalizePath('')).toBe('/');
  });
});

describe('シェル — メニュー', () => {
  it('製品名が見出しに出る', async () => {
    mountApp();
    await expect.element(page.getByRole('heading', { name: 'サウンドチェック' })).toBeVisible();
  });

  it('3つの機能がすべてタイルとして並ぶ', async () => {
    mountApp();
    const names = (): (string | null)[] =>
      [...document.querySelectorAll('.tile-name')].map((el) => el.textContent);
    await expect.poll(names).toEqual(['音質チェック', 'ボリュームチェック', 'ハウリングチェック']);
  });

  it('未実装の機能だけに準備中バッジが付く', async () => {
    mountApp();
    const badged = [...document.querySelectorAll('.tile')]
      .filter((tile) => tile.querySelector('.tile-badge'))
      .map((tile) => tile.querySelector('.tile-name')?.textContent);
    expect(badged).toEqual(['ハウリングチェック']);
  });

  it('知らないパスはメニューに落とす', async () => {
    router.path = '/nope';
    mountApp();
    await expect.element(page.getByRole('heading', { name: 'サウンドチェック' })).toBeVisible();
  });
});

describe('シェル — ルーティング', () => {
  it('タイルを押すと機能画面へ移り、URL も変わる', async () => {
    mountApp();
    await page.getByRole('button', { name: /音質チェック/ }).click();

    await expect.element(page.getByText('WAV / MP3 をドロップ')).toBeVisible();
    expect(location.pathname).toBe('/quality');
  });

  it('機能画面のヘッダーからメニューへ戻れる', async () => {
    router.path = '/quality';
    mountApp();
    await expect.element(page.getByText('WAV / MP3 をドロップ')).toBeVisible();

    await page.getByRole('button', { name: /SOUND CHECK/ }).click();
    await expect.element(page.getByRole('heading', { name: 'サウンドチェック' })).toBeVisible();
  });

  it('見出しは機能名になり、製品名は戻るリンクとして残る', async () => {
    router.path = '/quality';
    mountApp();
    await expect.element(page.getByRole('heading', { name: '音質チェック' })).toBeVisible();
    await expect.element(page.getByRole('button', { name: /SOUND CHECK/ })).toBeVisible();
  });

  it('document.title がルートごとに変わる', async () => {
    mountApp();
    await expect.poll(() => document.title).toBe('サウンドチェック');

    await page.getByRole('button', { name: /音質チェック/ }).click();
    await expect.poll(() => document.title).toBe('音質チェック | サウンドチェック');
  });
});

describe('シェル — 準備中の機能', () => {
  it('何を測る機能なのかを説明したうえで準備中と伝える', async () => {
    router.path = '/howling';
    mountApp();

    await expect.element(page.getByText('準備中')).toBeVisible();
    await expect.element(page.getByText(/鳴っているハウリングの周波数/)).toBeVisible();
    await expect.element(page.getByText(/この機能はまだ作っていません/)).toBeVisible();
  });

  it('準備中の画面からメニューへ戻れる', async () => {
    router.path = '/howling';
    mountApp();
    await page.getByRole('button', { name: 'メニューに戻る' }).click();
    await expect.element(page.getByRole('heading', { name: 'サウンドチェック' })).toBeVisible();
  });
});

describe('シェル — 実装済みの機能', () => {
  it('/volume は準備中ではなくボリュームチェック本体を出す', async () => {
    router.path = '/volume';
    mountApp();

    await expect.element(page.getByRole('button', { name: '測定を開始' })).toBeVisible();
    expect(document.body.textContent).not.toContain('準備中');
  });
});

describe('シェル — 言語切替', () => {
  it('EN でメニューが英語になる', async () => {
    mountApp();
    await page.getByRole('button', { name: 'EN' }).click();

    await expect.element(page.getByRole('heading', { name: 'Sound Check' })).toBeVisible();
    await expect.element(page.getByText('Audio Quality Check')).toBeVisible();
  });

  it('選択した言語が localStorage に保存される', async () => {
    mountApp();
    await page.getByRole('button', { name: 'EN' }).click();
    await expect.poll(() => localStorage.getItem('aqc-lang')).toBe('en');

    await page.getByRole('button', { name: 'JA' }).click();
    await expect.poll(() => localStorage.getItem('aqc-lang')).toBe('ja');
  });

  it('言語は機能の中身にも伝わる（結果のカテゴリ名）', async () => {
    vi.mocked(decodeFile).mockResolvedValue({ sampleRate: 16000 } as unknown as AudioBuffer);
    vi.mocked(analyzeAudio).mockResolvedValue(mockScores);
    router.path = '/quality';
    mountApp();

    selectFile(new File(['RIFF....'], 'sample.wav', { type: 'audio/wav' }));
    await expect.element(page.getByText('BREAKDOWN'), { timeout: 3000 }).toBeVisible();

    const names = (): (string | null)[] =>
      [...document.querySelectorAll('.b-name')].map((el) => el.textContent);
    expect(names()).toEqual(['ノイズ', '残響', '周波数バランス', '音量', '音割れ']);

    await page.getByRole('button', { name: 'EN' }).click();
    await expect.poll(names).toEqual(['Noise', 'Reverberation', 'Frequency Balance', 'Volume', 'Clipping']);
  });

  it('言語は機能の中身にも伝わる（ボリュームチェックのエラー）', async () => {
    // 文面を確定させて持つと、言語を切り替えたときにエラー行だけ元の言語で残る
    const denied = new Error('denied');
    denied.name = 'NotAllowedError';
    vi.mocked(startMonitor).mockRejectedValue(denied);

    router.path = '/volume';
    mountApp();
    await page.getByRole('button', { name: '測定を開始' }).click();
    await expect.element(page.getByText(/マイクへのアクセスが拒否されました/)).toBeVisible();

    await page.getByRole('button', { name: 'EN' }).click();
    await expect.element(page.getByText(/Microphone access denied/)).toBeVisible();
  });

  it('言語は機能の中身にも伝わる（エラーメッセージ）', async () => {
    router.path = '/quality';
    mountApp();

    selectFile(new File(['x'], 'document.txt', { type: 'text/plain' }));
    await expect.element(page.getByText(/WAV または MP3/)).toBeVisible();

    await page.getByRole('button', { name: 'EN' }).click();
    await expect.element(page.getByText('Please select a WAV or MP3 file.')).toBeVisible();
  });
});
