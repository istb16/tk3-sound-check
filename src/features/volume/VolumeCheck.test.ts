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

/**
 * startMonitor が成功し、onChunk を feed として取り出せるようにする。
 * `autoGainControl` は「端末側のAGCを切れなかった」端末を作るためのもの。
 */
function mockMonitorOk(deviceLabel = 'テスト用マイク', autoGainControl = false): void {
  vi.mocked(startMonitor).mockImplementation(async (onChunk) => {
    feed = onChunk;
    return { stop: stopSpy, sampleRate: SR, deviceLabel, autoGainControl };
  });
}

const bigText = (): string => document.querySelector('.big')?.textContent?.trim() ?? '';
const peakText = (): string =>
  document.querySelector('.peak-row .mono')?.textContent?.trim() ?? '';

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

  it('基準を取るまで dB を出さない', async () => {
    // 校正されていない絶対dBFSは単独では何も指していない。意味を持つのは差だけで、
    // 主役を隠しておいて脇にピークだけ残すと、それが「いまのレベル」として読まれる
    mockMonitorOk();
    mountApp();
    await page.getByRole('button', { name: '測定を開始' }).click();

    // 振幅0.5の正弦波 → 実効値 -9.03dBFS。窓は埋まるが、基準がまだ無い
    feed!(sine(1000, LEQ_WINDOW_SEC, 0.5, SR));
    await expect.element(page.getByText('基準を取ってください')).toBeVisible();
    await expect.element(page.getByText(/「基準にする」を押すと/)).toBeVisible();
    expect(document.body.textContent).not.toContain('-9.0');
    expect(peakText()).toBe('--');
  });

  it('基準は窓が埋まるのを待たずに押せる（遡らないので待つ理由が無い）', async () => {
    mockMonitorOk();
    mountApp();
    await page.getByRole('button', { name: '測定を開始' }).click();

    await expect.element(page.getByRole('button', { name: '基準にする' })).toBeEnabled();
    await expect.element(page.getByText('基準を取ってください')).toBeVisible();
  });

  it('基準を測っている間は残り秒数を主役の位置に出し、押し直しは塞ぐ', async () => {
    // 基準は押した時点から先の10秒で測る。遡って測ると、押す前に起きた
    // レベル変化（客席へ歩く、演目が変わる）が基準に焼き付く
    mockMonitorOk();
    mountApp();
    await page.getByRole('button', { name: '測定を開始' }).click();
    await page.getByRole('button', { name: '基準にする' }).click();

    await expect.element(page.getByText('基準を測っています')).toBeVisible();
    await expect.poll(bigText).toBe('あと 10 秒');
    await expect.element(page.getByRole('button', { name: '基準にする' })).toBeDisabled();

    feed!(sine(1000, 1, 0.5, SR));
    await expect.poll(bigText).toBe('あと 9 秒');

    feed!(sine(1000, LEQ_WINDOW_SEC, 0.5, SR));
    await expect.poll(bigText).toMatch(/±0\.0dB/);
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

    await expect.element(page.getByText('基準を取ってください')).toBeVisible();

    await page.getByRole('button', { name: '基準にする' }).click();
    feed!(sine(1000, LEQ_WINDOW_SEC, 0.25, SR));
    await expect.poll(bigText).toMatch(/±0\.0dB/);
  });

  it('音量が倍（+6dB）になると差が +6.0 と出る', async () => {
    mockMonitorOk();
    mountApp();
    await page.getByRole('button', { name: '測定を開始' }).click();

    // 押してからの10秒が基準になる
    await expect.element(page.getByText('基準を取ってください')).toBeVisible();
    await page.getByRole('button', { name: '基準にする' }).click();
    feed!(sine(1000, LEQ_WINDOW_SEC, 0.25, SR));

    // 窓をすべて置き換える長さを流す
    feed!(sine(1000, LEQ_WINDOW_SEC, 0.5, SR));
    await expect.poll(bigText).toMatch(/\+6\.0dB/);
  });

  it('基準を取っても絶対値は出さない。出すのは差とピークだけ', async () => {
    // 基準前に絶対値を隠すのに基準後は出す、では理屈が通らない。
    // -15.1 は差を作るための中間結果であって、読んで何かを決める数字ではない
    mockMonitorOk();
    mountApp();
    await page.getByRole('button', { name: '測定を開始' }).click();
    await page.getByRole('button', { name: '基準にする' }).click();
    feed!(sine(1000, LEQ_WINDOW_SEC, 0.25, SR));

    await expect.poll(bigText).toMatch(/±0\.0dB/);
    // 「基準 -15.1 / 現在 -15.1」の並びは消した
    expect(document.querySelector('.values')).toBeNull();
    // ピークは差を出している間だけ見せる（入力段が0に当たるかは別の話だが、
    // 主役を隠している画面に dB を1つだけ残さない）
    await expect.poll(peakText).toMatch(/^-\d+\.\d dB$/);
  });

  it('基準を消すと dB も消える', async () => {
    mockMonitorOk();
    mountApp();
    await page.getByRole('button', { name: '測定を開始' }).click();
    await page.getByRole('button', { name: '基準にする' }).click();
    feed!(sine(1000, LEQ_WINDOW_SEC, 0.25, SR));
    await expect.poll(bigText).toMatch(/±0\.0dB/);

    await page.getByRole('button', { name: '基準を消す' }).click();
    await expect.element(page.getByText('基準を取ってください')).toBeVisible();
    expect(peakText()).toBe('--');
  });
});

describe('ボリュームチェック — 収束中（フェーダーを動かした直後）', () => {
  /** 基準を取ったところまで進める */
  async function withReference(): Promise<void> {
    mockMonitorOk();
    mountApp();
    await page.getByRole('button', { name: '測定を開始' }).click();
    await page.getByRole('button', { name: '基準にする' }).click();
    feed!(sine(1000, LEQ_WINDOW_SEC, 0.25, SR));
    await expect.poll(bigText).toMatch(/±0\.0dB/);
  }

  it('窓が置き換わるまでは、数値がまだ動くことと残り秒数を出す', async () => {
    // +6dB 動かした5秒後の表示は移動窓の必然で +4.0dB になる。ここで
    // 「あと2dB足りない」と読まれてもう一段動かされるのがいちばん重い誤読なので、
    // 収束済みの +4.0dB と見分けがつく形にする
    await withReference();

    feed!(sine(1000, 5, 0.5, SR));
    await expect.poll(bigText).toMatch(/\+4\.0dB/);
    await expect.element(page.getByText(/確定まであと 5 秒/)).toBeVisible();
    expect(document.querySelector('.big.settling')).not.toBeNull();
  });

  it('窓が置き換わりきると断りが消え、真の変化量になる', async () => {
    await withReference();

    feed!(sine(1000, LEQ_WINDOW_SEC, 0.5, SR));
    await expect.poll(bigText).toMatch(/\+6\.0dB/);
    expect(document.body.textContent).not.toContain('確定まであと');
    expect(document.querySelector('.big.settling')).toBeNull();
  });

  it('レベルが変わっていなければ断りを出さない', async () => {
    await withReference();

    feed!(sine(1000, LEQ_WINDOW_SEC, 0.25, SR));
    await expect.poll(bigText).toMatch(/±0\.0dB/);
    expect(document.body.textContent).not.toContain('確定まであと');
  });
});

describe('ボリュームチェック — 基準を測っている間のレベル変化', () => {
  it('取り直すまで断り続け、数値を確定した顔にしない', async () => {
    // 基準を遡らせないことで押す前のレベル変化は混ざらなくなったが、
    // 測っている10秒の最中に変われば同じ混合が焼き付く。しかも窓が
    // 入れ替われば収束中の断りは消えるので、これが無いと確定した顔で出る
    mockMonitorOk();
    mountApp();
    await page.getByRole('button', { name: '測定を開始' }).click();
    await page.getByRole('button', { name: '基準にする' }).click();

    // 押した3秒後にフェーダーが +6dB 動いた形
    feed!(sine(1000, 3, 0.25, SR));
    feed!(sine(1000, LEQ_WINDOW_SEC - 3, 0.5, SR));

    await expect.element(page.getByText(/基準を測っている間にレベルが変わりました/))
      .toBeVisible();
    expect(document.querySelector('.big.settling')).not.toBeNull();

    // 窓が入れ替わると収束中は消えるが、基準の汚れは消えない
    feed!(sine(1000, LEQ_WINDOW_SEC, 0.5, SR));
    await expect.poll(() => document.body.textContent?.includes('確定まであと')).toBe(false);
    await expect.element(page.getByText(/基準を測っている間にレベルが変わりました/))
      .toBeVisible();

    // 取り直せば消える
    await page.getByRole('button', { name: '基準を消す' }).click();
    await page.getByRole('button', { name: '基準にする' }).click();
    feed!(sine(1000, LEQ_WINDOW_SEC, 0.5, SR));
    await expect.poll(bigText).toMatch(/±0\.0dB/);
    expect(document.body.textContent).not.toContain('基準を測っている間に');
  });
});

describe('ボリュームチェック — 帯域ごとに変化量が違うとき', () => {
  it('低域だけが動いたときは重み付け無しの差を並べて断る', async () => {
    // 「同じ端末・同じ場所なら差は正しい」が成り立つのは全帯域が一律に
    // 動いたときだけ。サブのフェーダーを上げると、A特性の主役はほとんど動かない
    mockMonitorOk();
    mountApp();
    await page.getByRole('button', { name: '測定を開始' }).click();

    await page.getByRole('button', { name: '基準にする' }).click();
    feed!(sine(1000, LEQ_WINDOW_SEC, 0.25, SR));
    await expect.poll(bigText).toMatch(/±0\.0dB/);

    // 60Hz を足す。A特性では約27dB落ちるので主役はほぼ動かないが、
    // 入力に入っているエネルギーは4倍になっている
    const mixed = sine(1000, LEQ_WINDOW_SEC, 0.25, SR);
    const low = sine(60, LEQ_WINDOW_SEC, 0.5, SR);
    for (let i = 0; i < mixed.length; i++) mixed[i] += low[i];
    feed!(mixed);

    await expect.element(page.getByText(/広帯域では \+7\.0 dB/)).toBeVisible();
    await expect.element(page.getByText(/帯域ごとに変化量が違う/)).toBeVisible();
  });

  it('全帯域が一律に動いたときは2つ目の数字を出さない', async () => {
    mockMonitorOk();
    mountApp();
    await page.getByRole('button', { name: '測定を開始' }).click();
    await page.getByRole('button', { name: '基準にする' }).click();
    feed!(sine(1000, LEQ_WINDOW_SEC, 0.25, SR));

    feed!(sine(1000, LEQ_WINDOW_SEC, 0.5, SR));
    await expect.poll(bigText).toMatch(/\+6\.0dB/);
    expect(document.body.textContent).not.toContain('広帯域では');
  });
});

describe('ボリュームチェック — 端末の限界', () => {
  it('割れる手前でも、限界に張り付いていれば差が縮むことを断る', async () => {
    // 0.98 に届かないので音割れは「なし」のまま。ここで何も出さないと、
    // 警告が無いまま差だけが小さくなる
    mockMonitorOk();
    mountApp();
    await page.getByRole('button', { name: '測定を開始' }).click();

    feed!(sine(1000, 3, 0.9, SR));
    await expect.element(page.getByText(/入力が限界に近い状態/)).toBeVisible();
    await expect.element(page.getByText(/変化量が実際より小さく出ます/)).toBeVisible();
  });

  it('余裕のあるレベルでは何も言わない', async () => {
    mockMonitorOk();
    mountApp();
    await page.getByRole('button', { name: '測定を開始' }).click();

    feed!(sine(1000, 3, 0.3, SR));
    await expect.element(page.getByText('測定中', { exact: true })).toBeVisible();
    expect(document.body.textContent).not.toContain('入力が限界に近い');
  });
});

describe('ボリュームチェック — 端末のAGC', () => {
  it('AGCを切れなかった端末では、どの数字より先に断る', async () => {
    // 制約に autoGainControl: false を渡しても、Android にはプラットフォーム層で
    // AGCが入る機種がある。**AGCがONならこの機能そのものが成立しない**
    mockMonitorOk('内蔵マイク', true);
    mountApp();
    await page.getByRole('button', { name: '測定を開始' }).click();

    await expect.element(page.getByText(/自動ゲイン調整を切れませんでした/)).toBeVisible();
    await expect.element(page.getByText(/変化量は信用できません/)).toBeVisible();
  });

  it('切れている端末では何も言わない', async () => {
    mockMonitorOk('内蔵マイク', false);
    mountApp();
    await page.getByRole('button', { name: '測定を開始' }).click();

    await expect.element(page.getByText('測定中', { exact: true })).toBeVisible();
    expect(document.body.textContent).not.toContain('自動ゲイン調整');
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
    await page.getByRole('button', { name: '基準にする' }).click();
    feed!(sine(1000, LEQ_WINDOW_SEC, 0.25, SR));
    await expect.poll(bigText).toMatch(/±0\.0dB/);

    await page.getByRole('button', { name: '停止' }).click();
    await page.getByRole('button', { name: '測定を開始' }).click();

    // 測り直しなので基準は戻らない。基準は遡らないので、窓の待ち時間も出ない
    await expect.element(page.getByText('基準を取ってください')).toBeVisible();
    feed!(sine(1000, LEQ_WINDOW_SEC, 0.25, SR));
    await expect.element(page.getByText('基準を取ってください')).toBeVisible();
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
      return {
        stop: stopSpy, sampleRate: SR, deviceLabel: 'テスト用マイク', autoGainControl: false,
      };
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
    await page.getByRole('button', { name: '基準にする' }).click();
    feed!(sine(1000, LEQ_WINDOW_SEC, 0.5, SR));
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
    // 基準が残っているので、窓が埋まれば差の表示に戻る
    await expect.poll(bigText).toMatch(/±0\.0dB/);
    await expect.element(page.getByRole('button', { name: '基準を消す' })).toBeVisible();
  });

  it('再開直後は窓が埋まるまで差を出さない', async () => {
    // 再開では基準を持ち越すが解析器は作り直すので、窓は空から始まる。
    // そのまま差を出すと、フェーダーを触っていないのに +7dB のような値が出て
    // 10秒かけて真値に寄っていく——基準前の絶対値より質の悪い、
    // 「意味のある形をした嘘」になる
    mockMonitorOk();
    mountApp();
    await measureAndSetReference();
    await expect.element(page.getByText('計測が止まりました')).toBeVisible();

    await page.getByRole('button', { name: '測定を再開' }).click();
    feed!(sine(1000, 1, 0.1, SR)); // 基準より14dB小さい音。差を出せば嘘が見える
    await expect.poll(bigText).toBe('あと 9 秒');
    expect(peakText()).toBe('--');
    // 基準が生きていることは伝える（消えたと誤解されると取り直されてしまう）
    await expect.element(page.getByText('基準は保持しています。')).toBeVisible();
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
    feed!(sine(1000, LEQ_WINDOW_SEC, 0.5, SR));
    await expect.element(page.getByText(/「基準にする」を押すと/)).toBeVisible();
  });

  it('再開したときに同じマイクか確かめられなければ基準を捨てる', async () => {
    // マイク名が取れない環境では、機材が変わっても名前の食い違いが出ない。
    // 確かめられないまま持ち越すと、感度の違う機材の差を平気で表示することになる。
    // 取り直しは10秒で済むが、別の機材との差は取り返せない
    mockMonitorOk('');
    mountApp();
    await measureAndSetReference();
    await expect.element(page.getByText('計測が止まりました')).toBeVisible();

    await page.getByRole('button', { name: '測定を再開' }).click();

    await expect.element(page.getByText(/同じマイクかを確認できなかったため/)).toBeVisible();
    // 「別のマイクが開いた」とは言わない。確かめていないことを断定しない
    expect(document.body.textContent).not.toContain('別のマイクが開いたため');
    feed!(sine(1000, LEQ_WINDOW_SEC, 0.5, SR));
    await expect.element(page.getByText(/「基準にする」を押すと/)).toBeVisible();
  });

  it('同じマイクが戻ってきたことを確かめられれば基準は残る', async () => {
    mockMonitorOk('USB Audio CODEC');
    mountApp();
    await measureAndSetReference();
    await expect.element(page.getByText('計測が止まりました')).toBeVisible();

    await page.getByRole('button', { name: '測定を再開' }).click();
    feed!(sine(1000, LEQ_WINDOW_SEC, 0.5, SR));

    await expect.poll(bigText).toMatch(/±0\.0dB/);
    expect(document.body.textContent).not.toContain('破棄しました');
  });

  it('基準を取る前の中断では破棄を知らせない（捨てるものが無い）', async () => {
    mockMonitorOk('');
    mountApp();
    await page.getByRole('button', { name: '測定を開始' }).click();
    feed!(sine(1000, 1, 0.5, SR));
    await expect.element(page.getByText('計測が止まりました')).toBeVisible();

    await page.getByRole('button', { name: '測定を再開' }).click();
    // 基準が無いので「基準を取ってください」に戻るだけ（窓の待ち時間は出ない）
    await expect.element(page.getByText('基準を取ってください')).toBeVisible();
    expect(document.body.textContent).not.toContain('破棄しました');
  });

  it('前回の破棄理由が次の再開に残らない', async () => {
    // onStart のガードは基準が無いときに代入ごと飛ばすので、resume() で消さないと
    // 「別のマイクが開いたため破棄しました」が、破棄も機材の変更も起きていない
    // 次の再開にそのまま残る。起きていない事象を報告する測定器になる
    mockMonitorOk('内蔵マイク');
    mountApp();
    await measureAndSetReference();
    await expect.element(page.getByText('計測が止まりました')).toBeVisible();

    mockMonitorOk('USB Audio CODEC');
    await page.getByRole('button', { name: '測定を再開' }).click();
    await expect.element(page.getByText(/別のマイクが開いたため/)).toBeVisible();

    // 基準を取り直さないまま、同じマイクでもう一度中断して再開する
    feed!(sine(1000, 1, 0.5, SR));
    await expect.element(page.getByText('計測が止まりました')).toBeVisible();
    await page.getByRole('button', { name: '測定を再開' }).click();

    await expect.element(page.getByText('基準を取ってください')).toBeVisible();
    expect(document.body.textContent).not.toContain('別のマイクが開いたため');
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
    await expect.poll(bigText).toMatch(/±0\.0dB/);
    await expect.element(page.getByRole('button', { name: '基準を消す' })).toBeVisible();
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

    await page.getByRole('button', { name: '基準にする' }).click();
    feed!(sine(1000, LEQ_WINDOW_SEC, 0.5, SR));
    await expect.poll(bigText).toMatch(/±0\.0dB/);
    expect(document.body.textContent).not.toContain('基準を破棄しました');
  });

  it('中断からそのまま停止すると基準も消える', async () => {
    mockMonitorOk();
    mountApp();
    await measureAndSetReference();
    await expect.element(page.getByText('計測が止まりました')).toBeVisible();

    await page.getByRole('button', { name: '停止' }).click();
    await page.getByRole('button', { name: '測定を開始' }).click();
    feed!(sine(1000, LEQ_WINDOW_SEC, 0.5, SR));
    await expect.element(page.getByText(/「基準にする」を押すと/)).toBeVisible();
  });
});

