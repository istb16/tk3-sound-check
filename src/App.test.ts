import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, unmount } from 'svelte';
import { page } from 'vitest/browser';

// vi.mock はホイストされるため、他のインポートより先に実行される
vi.mock('./lib/audio/capture.ts', () => ({
  RECORDING_ABORTED: 'RecordingAborted',
  decodeFile:       vi.fn(),
  recordMicrophone: vi.fn(),
  startMonitor:     vi.fn(),
}));
vi.mock('./features/quality/AudioAnalyzer.ts', () => ({
  analyzeAudio: vi.fn(),
}));

import App from './App.svelte';
import { router, normalizePath } from './shell/router.svelte.ts';
import { FEATURES } from './features/registry.ts';
import { decodeFile, startMonitor } from './lib/audio/capture.ts';
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
  it('看板が見出しとして出る', async () => {
    mountApp();
    await expect.element(page.getByRole('heading', { name: 'SOUND CHECK' })).toBeVisible();
  });

  it('看板は言語を切り替えても変わらない', async () => {
    // 翻訳しなくて済む名前だから看板にしている。切り替えるたびに
    // 表札が変わるのでは看板にならない
    mountApp();
    await page.getByRole('button', { name: 'EN' }).click();
    await expect.element(page.getByRole('heading', { name: 'SOUND CHECK' })).toBeVisible();
  });

  it('何のサイトかを一行で言う', async () => {
    // 名前と3つのボタンしか無い画面は、説明を省いたのではなく
    // 書き忘れたように見える
    mountApp();
    await expect.element(page.getByText(/耳では分からないことを、その場で数値にする/)).toBeVisible();
  });

  it('3つの機能がすべてタイルとして並ぶ', async () => {
    mountApp();
    const names = (): (string | null)[] =>
      [...document.querySelectorAll('.tile-name')].map((el) => el.textContent);
    await expect.poll(names).toEqual(['音質チェック', 'ボリュームチェック', 'ハウリングチェック']);
  });

  it('知らないパスはメニューに落とす', async () => {
    router.path = '/nope';
    mountApp();
    await expect.element(page.getByRole('heading', { name: 'SOUND CHECK' })).toBeVisible();
  });

  it('タイルは本物のリンク（新しいタブで開ける・URLをコピーできる）', async () => {
    mountApp();
    const hrefs = (): (string | null)[] =>
      [...document.querySelectorAll('a.tile')].map((el) => el.getAttribute('href'));
    await expect.poll(hrefs).toEqual(FEATURES.map((f) => f.path));
  });

  it('タイルごとに違うアイコンと色が付く', async () => {
    // 3枚が同じ形・同じ色だと、毎回「読んで」選ばされる。
    // 開く人は3つとも知っているので、要るのは説明ではなく見分け
    mountApp();
    const tiles = (): HTMLElement[] => [...document.querySelectorAll('a.tile')] as HTMLElement[];
    await expect.poll(() => tiles().length).toBe(FEATURES.length);

    const accents = tiles().map((t) => t.style.getPropertyValue('--tile-accent').trim());
    expect(accents).toEqual(FEATURES.map((f) => f.accent));
    expect(new Set(accents).size, '色が重複している').toBe(FEATURES.length);

    // アイコンは機能ごとに別物であること（同じSVGが3枚並んでいない）
    const shapes = tiles().map((t) => t.querySelector('.chip svg')?.innerHTML ?? '');
    expect(shapes.every((sh) => sh.length > 0)).toBe(true);
    expect(new Set(shapes).size, 'アイコンが重複している').toBe(FEATURES.length);
  });

  describe('機能色の条件', () => {
    /** 警告の赤。音割れ・発振中・マイク拒否・計測停止がすべてこの色 */
    const ALERT_RED = '#B00020';

    const channels = (hex: string): number[] =>
      [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);

    const luminance = (hex: string): number => {
      const [r, g, b] = channels(hex).map((c) =>
        c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4),
      );
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };

    const contrast = (a: string, b: string): number => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };

    const hue = (hex: string): number => {
      const [r, g, b] = channels(hex);
      const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
      if (d === 0) return 0;
      const h = max === r ? 60 * (((g - b) / d) % 6)
              : max === g ? 60 * ((b - r) / d + 2)
              :             60 * ((r - g) / d + 4);
      return (h + 360) % 360;
    };

    const hueGap = (a: string, b: string): number => {
      const diff = Math.abs(hue(a) - hue(b));
      return Math.min(diff, 360 - diff);
    };

    it('警告の赤と色相が十分に離れている', () => {
      // 機能色に赤系を混ぜると、赤が「何かがおかしい」を指す力を失う
      for (const f of FEATURES) {
        expect(hueGap(f.accent, ALERT_RED), `${f.id} ${f.accent}`).toBeGreaterThan(35);
      }
    });

    it('白地の上で文字として読める（戻るボタンの文字色になる）', () => {
      for (const f of FEATURES) {
        expect(contrast(f.accent, '#FFFFFF'), `${f.id} ${f.accent}`)
          .toBeGreaterThanOrEqual(4.5);
      }
    });

    it('互いに見分けられる色相差がある', () => {
      // 3枚を読まずに撃ち分けるための色なので、似ていては意味が無い
      for (let i = 0; i < FEATURES.length; i++) {
        for (let j = i + 1; j < FEATURES.length; j++) {
          expect(
            hueGap(FEATURES[i].accent, FEATURES[j].accent),
            `${FEATURES[i].id} と ${FEATURES[j].id}`,
          ).toBeGreaterThan(25);
        }
      }
    });
  });
});

describe('シェル — スマホで3枚とも一画面に収まる', () => {
  /** iPhone SE。いま実用される中で最も背の低い部類 */
  const W = 375, H = 667;

  afterEach(async () => { await page.viewport(1280, 800); });

  it('3枚目のタイルの下端が画面内にある', async () => {
    // スクロールしないと選べないランチャーは、いまより遅い。
    // 「気をつける」で運用すると、次に余白を触った瞬間に黙って壊れる
    await page.viewport(W, H);
    mountApp();

    const tiles = (): HTMLElement[] => [...document.querySelectorAll('a.tile')] as HTMLElement[];
    await expect.poll(() => tiles().length).toBe(FEATURES.length);

    const last = tiles()[tiles().length - 1].getBoundingClientRect();
    expect(
      last.bottom,
      `3枚目の下端が ${last.bottom.toFixed(0)}px（画面は ${H}px）。看板か余白が大きすぎる`,
    ).toBeLessThanOrEqual(H);
  });

  it('横スクロールが出ない', async () => {
    await page.viewport(W, H);
    mountApp();
    await expect.poll(() => document.querySelectorAll('a.tile').length).toBe(FEATURES.length);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(W);
  });

  it('タイルは指の的として十分な高さがある', async () => {
    await page.viewport(W, H);
    mountApp();
    const tiles = (): HTMLElement[] => [...document.querySelectorAll('a.tile')] as HTMLElement[];
    await expect.poll(() => tiles().length).toBe(FEATURES.length);
    for (const t of tiles()) {
      expect(t.getBoundingClientRect().height).toBeGreaterThanOrEqual(64);
    }
  });

  it('PCでは3枚が1行に並ぶ（2列＋歯抜けにしない）', async () => {
    // 3つは2列に収まらず、必ず1枚余る。幅が親に潰されていると2列になるので、
    // ここが崩れたら main の幅が壊れている
    await page.viewport(1280, 800);
    mountApp();
    const tiles = (): HTMLElement[] => [...document.querySelectorAll('a.tile')] as HTMLElement[];
    await expect.poll(() => tiles().length).toBe(FEATURES.length);
    const tops = tiles().map((t) => Math.round(t.getBoundingClientRect().top));
    expect(new Set(tops).size, '3枚が同じ行に並んでいない').toBe(1);
  });

  it('スマホでは1列に並ぶ（横に潰れない）', async () => {
    await page.viewport(W, H);
    mountApp();
    const tiles = (): HTMLElement[] => [...document.querySelectorAll('a.tile')] as HTMLElement[];
    await expect.poll(() => tiles().length).toBe(FEATURES.length);
    const tops = tiles().map((t) => Math.round(t.getBoundingClientRect().top));
    expect(new Set(tops).size, '同じ行に並んでいるタイルがある').toBe(FEATURES.length);
  });
});

describe('シェル — ルーティング', () => {
  it('タイルを押すと機能画面へ移り、URL も変わる', async () => {
    mountApp();
    await page.getByRole('link', { name: /音質チェック/ }).click();

    await expect.element(page.getByText('WAV / MP3 をドロップ')).toBeVisible();
    expect(location.pathname).toBe('/quality');
  });

  it('機能画面のヘッダーからメニューへ戻れる', async () => {
    router.path = '/quality';
    mountApp();
    await expect.element(page.getByText('WAV / MP3 をドロップ')).toBeVisible();

    await page.getByRole('link', { name: 'メニュー' }).click();
    await expect.element(page.getByRole('heading', { name: 'SOUND CHECK' })).toBeVisible();
  });

  it('機能ページでは機能名が主役で、看板は下ろす', async () => {
    // 中にいる人に重要なのは、いまどの道具を開いているか。サイトの名前ではない
    router.path = '/quality';
    mountApp();
    await expect.element(page.getByRole('heading', { name: '音質チェック' })).toBeVisible();
    expect(document.querySelector('.wordmark')).toBeNull();
  });

  it('戻るは行き先の名前を書いたボタンの形で、常に画面の先頭にある', async () => {
    // 下だけに置くとスクロールするまで出口が見えない。測定中の「停止」の
    // 隣に置くと、押し間違えて基準や捕まえた周波数を失う
    router.path = '/howling';
    mountApp();
    const back = document.querySelector('a.back') as HTMLElement;
    expect(back).not.toBeNull();
    expect(back.textContent?.trim()).toBe('メニュー');
    expect(back.getAttribute('href')).toBe('/');
    // 指の的として 40px を割らない
    expect(back.getBoundingClientRect().height).toBeGreaterThanOrEqual(40);
  });

  it('戻るボタンはその機能の色になる', async () => {
    router.path = '/howling';
    mountApp();
    const head = document.querySelector('.feature-head') as HTMLElement;
    expect(head.style.getPropertyValue('--feature-accent').trim())
      .toBe(FEATURES.find((f) => f.id === 'howling')!.accent);
  });

  it('document.title がルートごとに変わる', async () => {
    // 機能ページから看板を下ろしたぶん、ブランドはタブが受け持つ
    mountApp();
    await expect.poll(() => document.title).toBe('サウンドチェック');

    await page.getByRole('link', { name: /音質チェック/ }).click();
    await expect.poll(() => document.title).toBe('音質チェック | サウンドチェック');
  });
});

describe('シェル — 各機能への入口', () => {
  it('登録されている機能はすべて画面から辿れる', async () => {
    mountApp();
    const names = (): (string | null)[] =>
      [...document.querySelectorAll('.tile-name')].map((el) => el.textContent);
    await expect.poll(names).toEqual(FEATURES.map((f) => f.text.ja.name));
  });

  it('/volume はボリュームチェック本体を出す', async () => {
    router.path = '/volume';
    mountApp();

    await expect.element(page.getByRole('button', { name: '測定を開始' })).toBeVisible();
  });

  it('/howling はハウリングチェック本体を出す', async () => {
    router.path = '/howling';
    mountApp();

    await expect.element(page.getByRole('button', { name: '測定を開始' })).toBeVisible();
    await expect.element(page.getByText(/3.2kHzか4.5kHzかは/)).toBeVisible();
  });
});

describe('シェル — 言語切替', () => {
  it('EN でメニューが英語になる', async () => {
    mountApp();
    await page.getByRole('button', { name: 'EN' }).click();

    await expect.element(page.getByText(/Put a number on what your ears/)).toBeVisible();
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
