import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, unmount } from 'svelte';
import { page } from 'vitest/browser';

// vi.mock はホイストされるため、他のインポートより先に実行される
vi.mock('../../lib/audio/capture.ts', () => ({
  startMonitor: vi.fn(),
}));

import VolumeCheck from './VolumeCheck.svelte';
import { startMonitor } from '../../lib/audio/capture.ts';
import { LEQ_WINDOW_SEC } from './level.ts';
import { sine } from '../../test-support/signals.ts';

/**
 * ボリュームチェックのUI。マイクはモックし、テスト側から任意の波形を流し込む。
 *
 * 測定そのもの（A特性・Leq・クリップ計数）は level.test.ts が見る。
 * ここで見るのは、状態遷移と、基準を取ったときに差が出ることと、
 * 画面を離れたらマイクが閉じることの3つ。
 */

const SR = 8000; // テストを速くするため低めにする。A特性は1kHzで0dBに正規化される

let app: Record<string, unknown> | null = null;
let feed: ((chunk: Float32Array) => void) | null = null;
let stopSpy = vi.fn();

function mountApp(lang: 'ja' | 'en' = 'ja'): void {
  const target = document.createElement('div');
  document.body.appendChild(target);
  app = mount(VolumeCheck, { target, props: { lang } });
}

/** startMonitor が成功し、onChunk を feed として取り出せるようにする */
function mockMonitorOk(deviceLabel = 'テスト用マイク'): void {
  vi.mocked(startMonitor).mockImplementation(async (onChunk) => {
    feed = onChunk;
    return { stop: stopSpy, sampleRate: SR, deviceLabel };
  });
}

const bigText = (): string => document.querySelector('.big')?.textContent?.trim() ?? '';

beforeEach(() => {
  document.body.innerHTML = '';
  feed = null;
  stopSpy = vi.fn();
  vi.clearAllMocks();
});

afterEach(() => {
  if (app) { unmount(app); app = null; }
  document.body.innerHTML = '';
});

describe('ボリュームチェック — 開始前', () => {
  it('何をする機能かを説明したうえで開始ボタンを出す', async () => {
    mountApp();
    await expect.element(page.getByText(/基準にする.*変化量/)).toBeVisible();
    await expect.element(page.getByRole('button', { name: '測定を開始' })).toBeVisible();
  });

  it('絶対音圧を出せないことを開始前に断る', async () => {
    mountApp();
    await expect.element(page.getByText(/音圧（dBA）は原理的に出せません/)).toBeVisible();
  });

  it('開始するまでマイクを開かない', async () => {
    mockMonitorOk();
    mountApp();
    expect(vi.mocked(startMonitor)).not.toHaveBeenCalled();
  });
});

describe('ボリュームチェック — 測定中', () => {
  it('開始すると測定中の画面になり、測っているマイク名が出る', async () => {
    mockMonitorOk('USB Audio CODEC');
    mountApp();
    await page.getByRole('button', { name: '測定を開始' }).click();

    await expect.element(page.getByText('測定中')).toBeVisible();
    await expect.element(page.getByText(/USB Audio CODEC/)).toBeVisible();
  });

  it('基準を取る前は現在のレベルを出す', async () => {
    mockMonitorOk();
    mountApp();
    await page.getByRole('button', { name: '測定を開始' }).click();

    feed!(sine(1000, 1, 0.5, SR));
    // 振幅0.5の正弦波 → 実効値 -9.03dBFS
    await expect.poll(bigText).toMatch(/-9\.0dB/);
    await expect.element(page.getByText(/「基準にする」を押すと/)).toBeVisible();
  });

  it('平均の窓が埋まるまで「基準にする」は押せない', async () => {
    // 窓が埋まる前の Leq を基準にすると、現在値だけが収束していって
    // フェーダーを触っていないのに差が出る
    mockMonitorOk();
    mountApp();
    await page.getByRole('button', { name: '測定を開始' }).click();

    const btn = page.getByRole('button', { name: '基準にする' });
    await expect.element(btn).toBeDisabled();

    feed!(sine(1000, 1, 0.5, SR));
    await expect.element(btn).toBeDisabled();
    await expect.element(page.getByText(/測定を安定させています（あと 9 秒）/)).toBeVisible();

    feed!(sine(1000, LEQ_WINDOW_SEC, 0.5, SR));
    await expect.element(btn).toBeEnabled();
    await expect.element(page.getByText('直近10秒の平均（A特性）')).toBeVisible();
  });

  it('相対値であることを測定中も断る', async () => {
    mockMonitorOk();
    mountApp();
    await page.getByRole('button', { name: '測定を開始' }).click();
    await expect.element(page.getByText(/dB\(A\) ではありません/)).toBeVisible();
  });
});

describe('ボリュームチェック — 基準との差', () => {
  it('基準を取った直後の差はゼロ', async () => {
    mockMonitorOk();
    mountApp();
    await page.getByRole('button', { name: '測定を開始' }).click();

    feed!(sine(1000, LEQ_WINDOW_SEC, 0.25, SR));
    await expect.poll(bigText).toMatch(/-15\.1dB/);

    await page.getByRole('button', { name: '基準にする' }).click();
    await expect.poll(bigText).toMatch(/±0\.0dB/);
  });

  it('音量が倍（+6dB）になると差が +6.0 と出る', async () => {
    mockMonitorOk();
    mountApp();
    await page.getByRole('button', { name: '測定を開始' }).click();

    // 窓を埋めてから基準を取る
    feed!(sine(1000, LEQ_WINDOW_SEC, 0.25, SR));
    await expect.poll(bigText).toMatch(/-15\.1dB/);
    await page.getByRole('button', { name: '基準にする' }).click();

    // 窓をすべて置き換える長さを流す
    feed!(sine(1000, LEQ_WINDOW_SEC, 0.5, SR));
    await expect.poll(bigText).toMatch(/\+6\.0dB/);
  });

  it('基準と現在の実測値を並べて出す', async () => {
    mockMonitorOk();
    mountApp();
    await page.getByRole('button', { name: '測定を開始' }).click();
    feed!(sine(1000, LEQ_WINDOW_SEC, 0.25, SR));
    await expect.poll(bigText).toMatch(/-15\.1dB/);
    await page.getByRole('button', { name: '基準にする' }).click();

    const values = (): string[] =>
      [...document.querySelectorAll('.values dd')].map((el) => el.textContent?.trim() ?? '');
    await expect.poll(values).toEqual(['-15.1 dB', '-15.1 dB']);
  });

  it('基準を消すと現在のレベル表示に戻る', async () => {
    mockMonitorOk();
    mountApp();
    await page.getByRole('button', { name: '測定を開始' }).click();
    feed!(sine(1000, LEQ_WINDOW_SEC, 0.25, SR));
    await page.getByRole('button', { name: '基準にする' }).click();
    await expect.poll(bigText).toMatch(/±0\.0dB/);

    await page.getByRole('button', { name: '基準を消す' }).click();
    await expect.element(page.getByText(/「基準にする」を押すと/)).toBeVisible();
  });
});

describe('ボリュームチェック — 音割れ', () => {
  it('割れていた時間を出し、窓を過ぎると自分で消える', async () => {
    mockMonitorOk();
    mountApp();
    await page.getByRole('button', { name: '測定を開始' }).click();

    const clipped = new Float32Array(SR);
    for (let i = 100; i < 200; i++) clipped[i] = 0.99;
    feed!(clipped);
    await expect.element(page.getByText('直近10秒のうち 0.1 秒')).toBeVisible();

    feed!(new Float32Array(SR * 11));
    await expect.element(page.getByText('なし')).toBeVisible();
  });

  it('割れっぱなしでも桁が壊れない', async () => {
    // 「回数」で数えていたころは、クリップした波形が半周期ごとに閾値を割るため
    // 1kHz を3dB突っ込んだだけで「10秒で20000回」と表示されていた
    mockMonitorOk();
    mountApp();
    await page.getByRole('button', { name: '測定を開始' }).click();

    const n = SR * 10;
    const overdriven = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      overdriven[i] = Math.max(-1, Math.min(1, 1.41 * Math.sin((2 * Math.PI * 1000 * i) / SR)));
    }
    feed!(overdriven);
    await expect.element(page.getByText('直近10秒のうち 10.0 秒')).toBeVisible();
  });
});

describe('ボリュームチェック — 停止と後片付け', () => {
  it('停止するとマイクを閉じて開始前に戻る', async () => {
    mockMonitorOk();
    mountApp();
    await page.getByRole('button', { name: '測定を開始' }).click();
    await expect.element(page.getByText('測定中')).toBeVisible();

    await page.getByRole('button', { name: '停止' }).click();
    expect(stopSpy).toHaveBeenCalled();
    await expect.element(page.getByRole('button', { name: '測定を開始' })).toBeVisible();
  });

  it('画面を離れたらマイクを閉じる', async () => {
    mockMonitorOk();
    mountApp();
    await page.getByRole('button', { name: '測定を開始' }).click();
    await expect.element(page.getByText('測定中')).toBeVisible();

    unmount(app!);
    app = null;
    expect(stopSpy).toHaveBeenCalled();
  });

  it('停止すると基準も測定値も残さない', async () => {
    mockMonitorOk();
    mountApp();
    await page.getByRole('button', { name: '測定を開始' }).click();
    feed!(sine(1000, LEQ_WINDOW_SEC, 0.25, SR));
    await page.getByRole('button', { name: '基準にする' }).click();
    await expect.poll(bigText).toMatch(/±0\.0dB/);

    await page.getByRole('button', { name: '停止' }).click();
    await page.getByRole('button', { name: '測定を開始' }).click();

    await expect.element(page.getByText(/「基準にする」を押すと/)).toBeVisible();
    expect(bigText()).toMatch(/--/);
  });
});

describe('ボリュームチェック — 起動中の割り込み', () => {
  /** 解決をテスト側から制御できる startMonitor */
  function deferredMonitor(): { resolve: () => void } {
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    vi.mocked(startMonitor).mockImplementation(async (onChunk) => {
      feed = onChunk;
      await gate;
      return { stop: stopSpy, sampleRate: SR, deviceLabel: 'テスト用マイク' };
    });
    return { resolve: release };
  }

  it('許可待ちの間に画面を離れたらマイクを閉じる', async () => {
    const gate = deferredMonitor();
    mountApp();
    await page.getByRole('button', { name: '測定を開始' }).click();

    // 許可ダイアログが出たまま戻るボタンを押した状態
    unmount(app!);
    app = null;

    gate.resolve();
    await vi.waitFor(() => expect(stopSpy).toHaveBeenCalled());
  });

  it('開始ボタンの二度押しでマイクが2本開かない', async () => {
    const gate = deferredMonitor();
    mountApp();
    const btn = page.getByRole('button', { name: '測定を開始' });

    await btn.click();
    await expect.element(btn).toBeDisabled();
    gate.resolve();

    await expect.element(page.getByText('測定中', { exact: true })).toBeVisible();
    expect(vi.mocked(startMonitor)).toHaveBeenCalledTimes(1);
  });
});

describe('ボリュームチェック — エラー', () => {
  it('マイクを拒否されると許可を促す', async () => {
    const denied = new Error('denied');
    denied.name = 'NotAllowedError';
    vi.mocked(startMonitor).mockRejectedValue(denied);

    mountApp();
    await page.getByRole('button', { name: '測定を開始' }).click();
    await expect.element(page.getByText(/マイクへのアクセスが拒否されました/)).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'もう一度試す' })).toBeVisible();
  });

  it('その他の失敗は理由付きで出す', async () => {
    vi.mocked(startMonitor).mockRejectedValue(new Error('AudioWorklet is not available'));

    mountApp();
    await page.getByRole('button', { name: '測定を開始' }).click();
    await expect.element(page.getByText(/AudioWorklet is not available/)).toBeVisible();
  });

  it('エラーのあとに再試行できる', async () => {
    vi.mocked(startMonitor).mockRejectedValueOnce(new Error('busy'));
    mountApp();
    await page.getByRole('button', { name: '測定を開始' }).click();
    await expect.element(page.getByRole('button', { name: 'もう一度試す' })).toBeVisible();

    mockMonitorOk();
    await page.getByRole('button', { name: 'もう一度試す' }).click();
    await expect.element(page.getByText('測定中')).toBeVisible();
  });
});

describe('ボリュームチェック — 言語', () => {
  it('EN では英語で表示される', async () => {
    mockMonitorOk();
    mountApp('en');
    await expect.element(page.getByRole('button', { name: 'Start measuring' })).toBeVisible();

    await page.getByRole('button', { name: 'Start measuring' }).click();
    await expect.element(page.getByText('Measuring')).toBeVisible();
    await expect.element(page.getByText(/not calibrated/)).toBeVisible();
  });
});
describe('ボリュームチェック — 計測が止まったとき', () => {
  /** 基準を取れる状態まで進める */
  async function measureAndSetReference(): Promise<void> {
    await page.getByRole('button', { name: '測定を開始' }).click();
    feed!(sine(1000, LEQ_WINDOW_SEC, 0.5, SR));
    await page.getByRole('button', { name: '基準にする' }).click();
  }

  it('チャンクが途切れたら計測を止め、マイクも閉じてそう伝える', async () => {
    // 固まった「+3.5dB」は正しい測定値と見分けがつかない。そのまま
    // フェーダーを動かされるのが最悪の結末なので、黙って固まらない
    mockMonitorOk();
    mountApp();
    await page.getByRole('button', { name: '測定を開始' }).click();
    feed!(sine(1000, 1, 0.5, SR));

    await expect.element(page.getByText('計測が止まりました')).toBeVisible();
    await expect.element(page.getByRole('button', { name: '測定を再開' })).toBeVisible();
    expect(stopSpy).toHaveBeenCalled();
  });

  it('中断しても基準は捨てない', async () => {
    // 中断中に会場の状態は変わっている。基準を捨てると
    // 「さっきと比べてどうか」を取り戻す手立てが無くなる
    mockMonitorOk();
    mountApp();
    await measureAndSetReference();

    await expect.element(page.getByText('計測が止まりました')).toBeVisible();
    await expect.element(page.getByText('基準は保持しています。')).toBeVisible();

    await page.getByRole('button', { name: '測定を再開' }).click();
    feed!(sine(1000, LEQ_WINDOW_SEC, 0.5, SR));
    // 基準が残っているので、再開後も差の表示に戻る
    await expect.element(page.getByText('基準')).toBeVisible();
    expect(document.body.textContent).not.toContain('「基準にする」を押すと');
  });

  it('再開したときに別のマイクが開いていたら基準を捨てて理由を出す', async () => {
    // 感度の違う機材の値を引き算しても、意味の無い数字が出るだけである
    mockMonitorOk('内蔵マイク');
    mountApp();
    await measureAndSetReference();
    await expect.element(page.getByText('計測が止まりました')).toBeVisible();

    mockMonitorOk('USB Audio CODEC');
    await page.getByRole('button', { name: '測定を再開' }).click();

    await expect.element(page.getByText(/基準を破棄しました/)).toBeVisible();
    await expect.element(page.getByText(/「基準にする」を押すと/)).toBeVisible();
  });

  it('再開に失敗しても基準は捨てない', async () => {
    // 「基準は保持しています」と出した直後に、黙って捨てるのが最も質の悪い裏切り
    mockMonitorOk();
    mountApp();
    await measureAndSetReference();
    await expect.element(page.getByText('計測が止まりました')).toBeVisible();

    vi.mocked(startMonitor).mockRejectedValueOnce(new Error('device busy'));
    await page.getByRole('button', { name: '測定を再開' }).click();
    await expect.element(page.getByText(/測定を開始できませんでした/)).toBeVisible();

    mockMonitorOk();
    await page.getByRole('button', { name: 'もう一度試す' }).click();
    feed!(sine(1000, LEQ_WINDOW_SEC, 0.5, SR));
    await expect.element(page.getByText('基準')).toBeVisible();
    expect(document.body.textContent).not.toContain('「基準にする」を押すと');
  });

  it('基準を取り直したら「破棄しました」の断りは消える', async () => {
    // 残したままだと、すぐ下に出ている基準値と矛盾する
    mockMonitorOk('内蔵マイク');
    mountApp();
    await measureAndSetReference();
    await expect.element(page.getByText('計測が止まりました')).toBeVisible();

    mockMonitorOk('USB Audio CODEC');
    await page.getByRole('button', { name: '測定を再開' }).click();
    await expect.element(page.getByText(/基準を破棄しました/)).toBeVisible();

    feed!(sine(1000, LEQ_WINDOW_SEC, 0.5, SR));
    await page.getByRole('button', { name: '基準にする' }).click();
    await expect.element(page.getByText('基準')).toBeVisible();
    expect(document.body.textContent).not.toContain('基準を破棄しました');
  });

  it('中断からそのまま停止すると基準も消える', async () => {
    mockMonitorOk();
    mountApp();
    await measureAndSetReference();
    await expect.element(page.getByText('計測が止まりました')).toBeVisible();

    await page.getByRole('button', { name: '停止' }).click();
    await page.getByRole('button', { name: '測定を開始' }).click();
    feed!(sine(1000, 1, 0.5, SR));
    await expect.element(page.getByText(/「基準にする」を押すと/)).toBeVisible();
  });
});

