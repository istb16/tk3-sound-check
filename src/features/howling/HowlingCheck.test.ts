import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, unmount } from 'svelte';
import { page } from 'vitest/browser';

// vi.mock はホイストされるため、他のインポートより先に実行される
vi.mock('../../lib/audio/capture.ts', () => ({
  startMonitor: vi.fn(),
}));

import HowlingCheck from './HowlingCheck.svelte';
import { startMonitor } from '../../lib/audio/capture.ts';
import { addTone, clipHard, pinkNoise } from '../../test-support/signals.ts';

/**
 * ハウリングチェックのUI。マイクはモックし、テスト側から任意の波形を流し込む。
 *
 * 検出そのもの（突出・持続・倍音列・履歴）は detector.test.ts が見る。
 * ここで見るのは、状態が画面に出ること、鳴き終わった周波数が残ること、
 * 測れていないときに黙らないこと、画面を離れたらマイクが閉じることの4つ。
 */

const SR = 48000;

let app: Record<string, unknown> | null = null;
let feed: ((chunk: Float32Array) => void) | null = null;
let stopSpy = vi.fn();

function mountApp(lang: 'ja' | 'en' = 'ja'): void {
  const target = document.createElement('div');
  document.body.appendChild(target);
  app = mount(HowlingCheck, { target, props: { lang } });
}

function mockMonitorOk(deviceLabel = 'テスト用マイク'): void {
  vi.mocked(startMonitor).mockImplementation(async (onChunk) => {
    feed = onChunk;
    return { stop: stopSpy, sampleRate: SR, deviceLabel };
  });
}

/** 4096サンプルずつ流す。ワークレットが実際に送ってくる形に合わせる */
function feedAll(samples: Float32Array): void {
  for (let off = 0; off < samples.length; off += 4096) {
    feed!(samples.subarray(off, Math.min(off + 4096, samples.length)));
  }
}

const noise = (sec: number, seed: number, rms = 0.03): Float32Array =>
  pinkNoise(Math.round(SR * sec), rms, seed);

const bigText = (): string => document.querySelector('.big')?.textContent?.trim() ?? '';
const statusText = (): string => document.querySelector('.status')?.textContent?.trim() ?? '';

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

describe('ハウリングチェック — 開始前', () => {
  it('何をする機能かを説明したうえで開始ボタンを出す', async () => {
    mountApp();
    await expect.element(page.getByText(/3\.2kHzか4\.5kHzかは/)).toBeVisible();
    await expect.element(page.getByRole('button', { name: '測定を開始' })).toBeVisible();
  });

  it('音を出さないことと、予兆を出さないことを開始前に断る', async () => {
    // 能動プローブをしないこと、なきかけを判定しないことは、この道具の輪郭そのもの
    mountApp();
    await expect.element(page.getByText(/このツール自身は音を出しません/)).toBeVisible();
    await expect.element(page.getByText(/鳴きかけの予兆も出しません/)).toBeVisible();
  });

  it('開始するまでマイクを開かない', async () => {
    mockMonitorOk();
    mountApp();
    expect(vi.mocked(startMonitor)).not.toHaveBeenCalled();
  });
});

describe('ハウリングチェック — 待っている間', () => {
  it('開始すると測定中の画面になり、測っているマイク名が出る', async () => {
    mockMonitorOk('USB Audio CODEC');
    mountApp();
    await page.getByRole('button', { name: '測定を開始' }).click();

    await expect.element(page.getByText('測定中')).toBeVisible();
    await expect.element(page.getByText(/USB Audio CODEC/)).toBeVisible();
  });

  it('突出したピークが無い間は「聞いています」のまま', async () => {
    mockMonitorOk();
    mountApp();
    await page.getByRole('button', { name: '測定を開始' }).click();

    feedAll(noise(1.5, 1));
    await expect.poll(statusText).toBe('聞いています');
    expect(document.body.textContent).not.toContain('発振中');
  });

  it('まだ何も捕まえていないことを明示する', async () => {
    // 空欄と「まだ出ていない」は違う。空欄は壊れているようにも見える
    mockMonitorOk();
    mountApp();
    await page.getByRole('button', { name: '測定を開始' }).click();

    feedAll(noise(1, 2));
    await expect.element(page.getByText(/まだ捕まえていません/)).toBeVisible();
  });
});

describe('ハウリングチェック — 鳴いているとき', () => {
  it('バンド名と周波数の両方を出す', async () => {
    // 固定バンドのグライコしか無い現場では「4k帯」がそのまま操作になり、
    // パラメトリックEQがあるなら数値が効く
    mockMonitorOk();
    mountApp();
    await page.getByRole('button', { name: '測定を開始' }).click();

    feedAll(addTone(noise(2, 3), SR, 3200, 0.12, { startSec: 0.3 }));

    await expect.poll(statusText).toBe('発振中');
    await expect.poll(bigText).toMatch(/4k帯/);
    await expect.poll(bigText).toMatch(/3\.20 kHz/);
  });

  it('鳴き終わっても周波数が残り、いつ鳴いたかが分かる', async () => {
    // オペレーターが画面を見るのは鳴き止んだ後。そこで消えていたら、
    // 画面を開いた理由そのものが消える
    mockMonitorOk();
    mountApp();
    await page.getByRole('button', { name: '測定を開始' }).click();

    const d = pinkNoise(SR * 5, 0.03, 4);
    addTone(d, SR, 3200, 0.12, { startSec: 0.5, durationSec: 0.8 });
    feedAll(d);

    await expect.poll(statusText).toBe('聞いています');
    await expect.element(page.getByText('4k帯')).toBeVisible();
    await expect.element(page.getByText('3.20 kHz')).toBeVisible();
    await expect.poll(
      () => document.querySelector('.ev-ago')?.textContent ?? '',
    ).toMatch(/秒前/);
  });

  it('同じ周波数で繰り返し鳴いたら回数で示す', async () => {
    mockMonitorOk();
    mountApp();
    await page.getByRole('button', { name: '測定を開始' }).click();

    const d = pinkNoise(SR * 6, 0.03, 5);
    addTone(d, SR, 3200, 0.12, { startSec: 0.5, durationSec: 0.6 });
    addTone(d, SR, 3200, 0.12, { startSec: 2.0, durationSec: 0.6 });
    addTone(d, SR, 3200, 0.12, { startSec: 3.5, durationSec: 0.6 });
    feedAll(d);

    await expect.poll(
      () => document.querySelector('.ev-detail')?.textContent ?? '',
    ).toMatch(/3回/);
    expect(document.querySelectorAll('.events li').length).toBe(1);
  });
});

describe('ハウリングチェック — 測れていないときに黙らない', () => {
  it('入力が飽和したら申告し、離すよう促す', async () => {
    // 鳴きが大きいほど検出しにくくなるのが、この道具の唯一の
    // 「静かに間違える」経路。黙る代わりに申告する
    mockMonitorOk();
    mountApp();
    await page.getByRole('button', { name: '測定を開始' }).click();

    feedAll(clipHard(addTone(noise(1.5, 6, 0.05), SR, 3200, 1.6, { startSec: 0.2 })));
    await expect.element(page.getByText(/入力が割れています/)).toBeVisible();
  });

  it('チャンクが途切れたら計測を止め、マイクも閉じてそう伝える', async () => {
    // 「何も鳴っていない」と「何も測っていない」が同じ見た目になるのが
    // この道具の最悪の壊れ方
    mockMonitorOk();
    mountApp();
    await page.getByRole('button', { name: '測定を開始' }).click();

    feedAll(noise(0.5, 7));
    await expect.element(page.getByText('計測が止まりました')).toBeVisible();
    await expect.element(page.getByRole('button', { name: '測定を再開' })).toBeVisible();
    // 開いたまま「止まっています」と出すのではなく閉じる。再開時に必ず作り直すため
    expect(stopSpy).toHaveBeenCalled();
  });

  it('止まる前に捕まえた周波数は残すが、経過時間は出さない', async () => {
    // 「止めたら何も残さない」のは利用者が止めたときの話。勝手に止まったときまで
    // 消すと、この道具を開いた理由そのものが消える。一方で「12秒前」が
    // 固まったまま残るのが最も避けたい誤読なので、経過時間だけは捨てる
    mockMonitorOk();
    mountApp();
    await page.getByRole('button', { name: '測定を開始' }).click();

    const d = pinkNoise(SR * 4, 0.03, 71);
    addTone(d, SR, 3200, 0.12, { startSec: 0.5, durationSec: 0.8 });
    feedAll(d);
    await expect.element(page.getByText('4k帯')).toBeVisible();

    await expect.element(page.getByText('止まる前に捕まえた周波数')).toBeVisible();
    await expect.element(page.getByText('3.20 kHz')).toBeVisible();
    expect(document.querySelector('.ev-ago')).toBeNull();
  });

  it('鳴っている最中に止まっても、その周波数を残す', async () => {
    // 画面が消えるのは鳴っている最中かもしれない。そこで落とすと、
    // 記録を残す動機そのものが果たされない
    mockMonitorOk();
    mountApp();
    await page.getByRole('button', { name: '測定を開始' }).click();

    // 鳴りっぱなしのまま供給を止める
    feedAll(addTone(noise(2, 74), SR, 3200, 0.12, { startSec: 0.4 }));
    await expect.poll(statusText).toBe('発振中');

    await expect.element(page.getByText('計測が止まりました')).toBeVisible();
    await expect.element(page.getByText('止まる前に捕まえた周波数')).toBeVisible();
    await expect.element(page.getByText('3.20 kHz')).toBeVisible();
  });

  it('再開するとマイクを開き直して測り直す', async () => {
    mockMonitorOk();
    mountApp();
    await page.getByRole('button', { name: '測定を開始' }).click();
    feedAll(noise(0.5, 72));
    await expect.element(page.getByText('計測が止まりました')).toBeVisible();

    await page.getByRole('button', { name: '測定を再開' }).click();
    await expect.element(page.getByText('測定中')).toBeVisible();
    expect(vi.mocked(startMonitor)).toHaveBeenCalledTimes(2);
    // 作り直した検出器で測り直す。中断をまたいだフレームを混ぜない
    await expect.element(page.getByText(/まだ捕まえていません/)).toBeVisible();
  });

  it('中断からそのまま停止できる', async () => {
    mockMonitorOk();
    mountApp();
    await page.getByRole('button', { name: '測定を開始' }).click();
    feedAll(noise(0.5, 73));
    await expect.element(page.getByText('計測が止まりました')).toBeVisible();

    await page.getByRole('button', { name: '停止' }).click();
    await expect.element(page.getByRole('button', { name: '測定を開始' })).toBeVisible();
  });
});

describe('ハウリングチェック — マイクの後始末', () => {
  it('停止するとマイクを閉じ、履歴も残さない', async () => {
    mockMonitorOk();
    mountApp();
    await page.getByRole('button', { name: '測定を開始' }).click();

    const d = pinkNoise(SR * 3, 0.03, 8);
    addTone(d, SR, 3200, 0.12, { startSec: 0.5, durationSec: 0.8 });
    feedAll(d);
    await expect.element(page.getByText('4k帯')).toBeVisible();

    await page.getByRole('button', { name: '停止' }).click();
    expect(stopSpy).toHaveBeenCalled();
    await expect.element(page.getByRole('button', { name: '測定を開始' })).toBeVisible();
    // 止めたら何も残さない（履歴もサマリも保存も作らない）
    expect(document.querySelectorAll('.events li').length).toBe(0);
    expect(document.querySelector('.ev-freq')).toBeNull();
  });

  it('画面を離れたらマイクを閉じる', async () => {
    // 録音インジケータが点いたままになるのは事故
    mockMonitorOk();
    mountApp();
    await page.getByRole('button', { name: '測定を開始' }).click();
    await expect.element(page.getByText('測定中')).toBeVisible();

    unmount(app!);
    app = null;
    expect(stopSpy).toHaveBeenCalled();
  });

  it('マイクを拒否されたら理由を出してやり直せる', async () => {
    vi.mocked(startMonitor).mockRejectedValue(
      Object.assign(new Error('denied'), { name: 'NotAllowedError' }),
    );
    mountApp();
    await page.getByRole('button', { name: '測定を開始' }).click();

    await expect.element(page.getByText(/マイクへのアクセスが拒否されました/)).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'もう一度試す' })).toBeVisible();
  });
});

describe('ハウリングチェック — 言語', () => {
  it('EN でも同じ判定が英語で出る', async () => {
    mockMonitorOk();
    mountApp('en');
    await page.getByRole('button', { name: 'Start listening' }).click();

    feedAll(addTone(noise(2, 9), SR, 3200, 0.12, { startSec: 0.3 }));
    await expect.poll(statusText).toBe('Ringing');
    await expect.poll(bigText).toMatch(/4k band/);
  });
});
