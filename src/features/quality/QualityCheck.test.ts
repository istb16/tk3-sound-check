import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, unmount } from 'svelte';
import { page } from 'vitest/browser';
import type { AudioScores } from './AudioAnalyzer.ts';

// vi.mock はホイストされるため、他のインポートより先に実行される
vi.mock('../../lib/audio/capture.ts', () => ({
  RECORDING_ABORTED: 'RecordingAborted',
  decodeFile:       vi.fn(),
  recordMicrophone: vi.fn(),
}));
vi.mock('./AudioAnalyzer.ts', () => ({
  analyzeAudio: vi.fn(),
}));

import QualityCheck from './QualityCheck.svelte';
import { decodeFile, recordMicrophone, type Recording } from '../../lib/audio/capture.ts';
import { analyzeAudio } from './AudioAnalyzer.ts';

// 実データを通したフルフローは e2e.test.ts が担当する。
// このファイルは audio.ts / AudioAnalyzer.ts をモックし、UI の状態遷移のみを検証する。
//
// シェル（ヘッダー・言語トグル・ルーティング）は App.test.ts が見る。ここでは
// 機能コンポーネントを直接 mount するので、メニューを経由しない。

let app: Record<string, unknown> | null = null;

function mountApp(): void {
  const target = document.createElement('div');
  document.body.appendChild(target);
  app = mount(QualityCheck, { target, props: { lang: 'ja' } });
}

// 加工の痕跡なし（フルバンド・自然なノイズフロア）の provenance
const cleanProvenance = {
  bandwidthHz: 8000,
  cutoffDropDb: 4,
  silenceFloorDb: -52,
  maxZeroRunMs: 0,
  impulsePeaksPerSec: 0,
  processed: false,
  flags: [],
} satisfies AudioScores['provenance'];

const mockScores: AudioScores = {
  overall: 82, noise: 22, reverb: 17, frequency: 21, volume: 13, clip: 9,
  advice: [{ code: 'muffled' as const, value: -15 }],
  provenance: cleanProvenance,
  rt60Sec: 0.45,
  unreliable: [],
  verdict: { level: 'usable', limitingAxis: 'clip', unconfirmed: false },
  measured: {
    snrDb: 28.4,
    rt60Sec: 0.45,
    bandwidthHz: 8000,
    activeSpeechDbfs: -17.2,
    clipRate: 0,
  },
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
describe('音質チェック — アイドル状態', () => {
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
describe('音質チェック — ドラッグ&ドロップ', () => {
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

// ---- 録音フロー ----
describe('音質チェック — 録音フロー', () => {
  it('録音中は REC 表示と経過秒数の進捗が出る', async () => {
    const rec = deferred<Recording>();
    vi.mocked(recordMicrophone).mockImplementation((_ms, onTick) => {
      onTick?.(0.5);
      return rec.promise;
    });
    mountApp();
    await page.getByRole('button', { name: /マイクで録音/ }).click();

    await expect.element(page.getByText('REC')).toBeVisible();
    // 録音中も読み上げ文が見えていること。消えると話す内容を思い出しながら喋る
    // ことになり、間の取り方が不自然になる（無音区間が無いとSNRも残響も測れない）。
    await expect.element(page.getByText('これはマイクのテストです。')).toBeVisible();
    await expect.element(page.getByText('/ 10 sec')).toBeVisible();
    await expect.poll(() => (document.querySelector('.progress-fill') as HTMLElement | null)?.style.width)
      .toBe('50%');
  });

  it('録音完了後に解析へ進み結果が表示される', async () => {
    const rec = deferred<Recording>();
    vi.mocked(recordMicrophone).mockReturnValue(rec.promise);
    vi.mocked(analyzeAudio).mockResolvedValue(mockScores);

    mountApp();
    await page.getByRole('button', { name: /マイクで録音/ }).click();
    await expect.element(page.getByText('REC')).toBeVisible();

    rec.resolve({
      // WAV書き出しが解析対象のサンプルを読むので getChannelData も持たせる
      buffer: {
        sampleRate: 48000,
        getChannelData: () => new Float32Array(4800),
      } as unknown as AudioBuffer,
      blob:       new Blob(['audio'], { type: 'audio/webm' }),
      rawCapture: true,
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
describe('音質チェック — 解析中と解析失敗', () => {
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
describe('音質チェック — エラー処理', () => {
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
describe('音質チェック — 解析結果表示', () => {
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
    for (const label of ['ノイズ', '残響', '周波数バランス', '音量', '音割れ']) {
      await expect.element(list.getByText(label, { exact: true })).toBeVisible();
    }
  });

  it('各カテゴリの点数と総合スコアが解析結果どおりに描画される', async () => {
    mockAnalysisSuccess();
    mountApp();
    selectFile(wavFile());
    await expect.element(page.getByText('BREAKDOWN'), { timeout: 3000 }).toBeVisible();

    // 表示順は scores.ts の LABELS 順（noise, reverb, frequency, volume, clip）
    const values = [...document.querySelectorAll('.b-val')].map((el) => Number(el.textContent));
    expect(values).toEqual([22, 17, 21, 13, 9]);
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

describe('音質チェック — 結果の並び', () => {
  afterEach(async () => { await page.viewport(1280, 800); });

  /** 結果画面まで進める */
  async function showResults(): Promise<void> {
    mockAnalysisSuccess();
    mountApp();
    selectFile(wavFile());
    await expect.element(page.getByText('BREAKDOWN')).toBeVisible();
  }

  it('幅があるときは2列になり、右カラムが空にならない', async () => {
    // 以前は「半分幅の項目の次が必ず全幅の項目」で対になる相手がおらず、
    // 2列にしても右半分がずっと空だった
    await page.viewport(1440, 1200);
    await showResults();

    const section = document.querySelector('.result-section') as HTMLElement;
    const half = [...section.children].filter(
      (el) => !el.classList.contains('result-full'),
    ) as HTMLElement[];
    expect(half.length, '半分幅の項目が2の倍数でない').toBe(4);

    // 上下の段で、それぞれ2枚が同じ行に並んでいること
    const rows = new Map<number, number>();
    for (const el of half) {
      const top = Math.round(el.getBoundingClientRect().top);
      rows.set(top, (rows.get(top) ?? 0) + 1);
    }
    expect([...rows.values()], '同じ行に2枚ずつ並んでいない').toEqual([2, 2]);
  });

  it('幅が足りないときは1列に落ちる', async () => {
    // 2列に割る判断はビューポートではなくこの領域の幅で行う。
    // ビューポートで判断すると、1列ぶんの幅しか無いのに2列に割れる
    await page.viewport(560, 1400);
    await showResults();

    const section = document.querySelector('.result-section') as HTMLElement;
    const tops = [...section.children].map((el) =>
      Math.round(el.getBoundingClientRect().top),
    );
    expect(new Set(tops).size, '横に並んでいる項目がある').toBe(tops.length);
  });

  it('1列のときの読む順は 総合点 → 判定 → レーダー → 内訳', async () => {
    // 判定がこの機能の答えなので、レーダーより先に出す
    await page.viewport(560, 1400);
    await showResults();

    const order = ['SIGNAL QUALITY', '判定', 'SPECTRUM', 'BREAKDOWN'];
    const tops = order.map((label) => {
      const el = [...document.querySelectorAll('.vu-eyebrow, .panel-label')]
        .find((n) => n.textContent?.trim() === label) as HTMLElement;
      expect(el, `${label} が見つからない`).toBeTruthy();
      return el.getBoundingClientRect().top;
    });
    expect(tops).toEqual([...tops].sort((a, b) => a - b));
  });
});

describe('配信されるもの', () => {
  it('favicon が小さい（公開サイトなので全員が落とす）', async () => {
    const res = await fetch('/favicon.png');
    const size = (await res.blob()).size;
    expect(size, `favicon.png が ${(size / 1024).toFixed(0)}KB`).toBeLessThan(100 * 1024);
  });
});
