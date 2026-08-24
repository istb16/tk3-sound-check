import { describe, expect, it } from 'vitest';
import { estimateLevel, estimateReverb, estimateSnr } from './estimators.ts';
import { analyzeSamples } from './AudioAnalyzer.ts';

const SR = 16000;
/** 製品のマイク録音のサンプルレート。コーパスの16kHzとは分解能が3倍違う */
const MIC_SR = 48000;

/** 決定的な擬似乱数 (mulberry32)。テストを再現可能にする */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

/**
 * 発話バーストと、既知の減衰率を持つ残響尾を並べた信号。
 *
 * 実際のインパルス応答の畳み込みはブラウザテストには重すぎるので、
 * 減衰エンベロープを直接合成して推定器の中核（減衰率の直線近似）を検証する。
 * 振幅は rt60Sec 秒で -60dB に達する。
 */
function decayingBursts(
  rt60Sec: number,
  opts: {
    bursts?: number; burstSec?: number; pauseSec?: number;
    amp?: number; floorDb?: number; sampleRate?: number;
  } = {},
): Float32Array {
  const {
    bursts = 6, burstSec = 0.4, pauseSec = 0.7, amp = 0.1, floorDb = -60, sampleRate = SR,
  } = opts;
  const total = Math.floor((burstSec + pauseSec) * bursts * sampleRate);
  const data = new Float32Array(total);
  const rnd = rng(12345);
  const decay = Math.log(1000) / rt60Sec; // 振幅が rt60 秒で 1/1000

  let pos = 0;
  for (let b = 0; b < bursts; b++) {
    const burstLen = Math.floor(burstSec * sampleRate);
    for (let i = 0; i < burstLen && pos < total; i++, pos++) data[pos] = amp * rnd();

    const tailLen = Math.floor(pauseSec * sampleRate);
    for (let i = 0; i < tailLen && pos < total; i++, pos++) {
      data[pos] = amp * Math.exp(-decay * (i / sampleRate)) * rnd();
    }
  }

  // 現実的なノイズフロア（デジタル無音と誤検出されない程度）
  const floor = Math.pow(10, floorDb / 20);
  const rnd2 = rng(999);
  for (let i = 0; i < total; i++) data[i] += floor * rnd2();
  return data;
}

/** 発話バースト＋無音。ノイズを足さない素の状態 */
function burstsWithSilence(amp = 0.1, bursts = 6): Float32Array {
  const total = Math.floor(1.1 * bursts * SR);
  const data = new Float32Array(total);
  const rnd = rng(777);
  let pos = 0;
  for (let b = 0; b < bursts; b++) {
    for (let i = 0; i < Math.floor(0.5 * SR) && pos < total; i++, pos++) data[pos] = amp * rnd();
    pos += Math.floor(0.6 * SR); // 無音
  }
  return data;
}

/** 有音区間RMS ÷ ノイズRMS が targetSnrDb になるようノイズを足す */
function withNoise(clean: Float32Array, targetSnrDb: number): { out: Float32Array; trueSnrDb: number } {
  // 有音区間のRMS（振幅が立っているサンプルのみ）
  let sum = 0, n = 0;
  for (let i = 0; i < clean.length; i++) {
    if (Math.abs(clean[i]) > 1e-4) { sum += clean[i] * clean[i]; n++; }
  }
  const speechRms = Math.sqrt(sum / Math.max(n, 1));
  const noiseRms = speechRms / Math.pow(10, targetSnrDb / 20);

  const rnd = rng(4242);
  // ホワイトノイズ(一様分布)のRMSは 1/sqrt(3)
  const scale = noiseRms * Math.sqrt(3);
  const out = new Float32Array(clean.length);
  for (let i = 0; i < clean.length; i++) out[i] = clean[i] + rnd() * scale;
  return { out, trueSnrDb: targetSnrDb };
}

describe('estimateReverb', () => {
  it('注入した減衰率をそのまま復元する（補正はかけない）', () => {
    // 以前は「発話を通して観測した減衰は部屋のRT60より緩く出る」として 1.35 で
    // 割り戻していた。**その係数は非現実的に湿った素材で校正したものだった。**
    // 検証基盤のインパルス応答が直接音対残響比 -12〜-21dB（大聖堂並み）で、
    // 残響が直接音より最初から大きかったため過大評価が起きていた。
    //
    // 実際の録音の範囲（卓上マイク +10dB）で測ると逆に過小評価になり、
    // 補正をかけると悪化した（バイアス -0.001 → -0.353秒）。補正は削除し、
    // 代わりに近似の開始点を発話の立ち下がりより下（-10dB）に置いた。
    // 減衰が観測しきれるよう、無音区間は RT60 に合わせて長く取る。
    for (const rt60 of [0.3, 0.5, 0.8]) {
      const est = estimateReverb(decayingBursts(rt60, { pauseSec: rt60 * 1.6 }), SR);
      expect(est.rt60Sec, `rt60=${rt60}`).not.toBeNull();
      expect(Math.abs((est.rt60Sec as number) - rt60), `rt60=${rt60} 誤差`).toBeLessThan(0.15);
    }
  });

  it('返す値はイベントごとの推定値の中央値そのもの', () => {
    // 倍率補正を挟まないことを固定する。挟むと素材依存の係数が入り込む。
    const est = estimateReverb(decayingBursts(0.5, { pauseSec: 0.8 }), SR);
    const sorted = [...est.perEventRt60].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    expect(est.rt60Sec as number).toBeCloseTo(median, 5);
  });

  it('残響が長いほど推定値も大きくなる', () => {
    const short = estimateReverb(decayingBursts(0.3, { pauseSec: 0.6 }), SR).rt60Sec as number;
    const long  = estimateReverb(decayingBursts(0.9, { pauseSec: 1.5 }), SR).rt60Sec as number;
    expect(long).toBeGreaterThan(short);
  });

  it('複数の減衰イベントを使う（1点測定ではない）', () => {
    // 旧実装は録音全体の最大ピーク1点からの減衰しか見ておらず再現性が無かった
    const est = estimateReverb(decayingBursts(0.5), SR);
    expect(est.events).toBeGreaterThanOrEqual(3);
    expect(est.confident).toBe(true);
  });

  it('減衰イベントが少なければ値は返しても信頼できないとする', () => {
    // 実測（4話者・43条件）では、イベントが4件未満だと誤差が3.7倍になる
    // (MAE 0.053 → 0.196)。値を捨てるのではなく「参考値」として開示する。
    const est = estimateReverb(decayingBursts(0.5, { bursts: 3 }), SR);
    expect(est.rt60Sec).not.toBeNull();
    expect(est.events).toBeLessThan(4);
    expect(est.confident).toBe(false);

    const res = analyzeSamples(decayingBursts(0.5, { bursts: 3 }), SR);
    expect(res.unreliable).toContain('reverb');
    // 参考値でも満点は与えない（測れていない軸で good を出さないため）
    expect(res.verdict.level).not.toBe('good');
  });

  it('自由減衰が無い信号では測定不能として null を返す', () => {
    // 途切れないノイズ。減衰イベントが存在しない
    const rnd = rng(1);
    const data = new Float32Array(SR * 4);
    for (let i = 0; i < data.length; i++) data[i] = 0.1 * rnd();
    const est = estimateReverb(data, SR);
    expect(est.rt60Sec).toBeNull();
    expect(est.confident).toBe(false);
  });

  it('測定不能なら残響軸を参考値として扱い、満点は与えない', () => {
    const rnd = rng(2);
    const data = new Float32Array(SR * 4);
    for (let i = 0; i < data.length; i++) data[i] = 0.1 * rnd();
    const res = analyzeSamples(data, SR);
    expect(res.rt60Sec).toBeNull();
    expect(res.unreliable).toContain('reverb');
    expect(res.advice.some((a) => a.code === 'reverb-unmeasurable')).toBe(true);
  });
});

describe('estimateSnr', () => {
  it('SNR 5〜30dB を 1dB 以内で復元する', () => {
    for (const snr of [5, 10, 15, 20, 30]) {
      const { out, trueSnrDb } = withNoise(burstsWithSilence(), snr);
      const est = estimateSnr(out, SR);
      expect(est.snrDb, `snr=${snr}`).not.toBeNull();
      expect(Math.abs((est.snrDb as number) - trueSnrDb), `snr=${snr} 誤差`).toBeLessThan(1);
    }
  });

  it('無音の割合が変わってもSNRの推定値は変わらない', () => {
    // 固定閾値(ピークから25dB下)だけで有音/無音を分けていた頃は、SNRが25dBを
    // 下回ると無音フレームを1つも分離できず、発話パワーを全フレーム平均で
    // 代用していた。その結果、無音の割合ぶん(実測 -3.0dB)過小評価していた。
    const dense  = withNoise(burstsWithSilence(0.1, 9), 15);
    const sparse = withNoise(burstsWithSilence(0.1, 3), 15);
    const a = estimateSnr(dense.out, SR).snrDb as number;
    const b = estimateSnr(sparse.out, SR).snrDb as number;
    expect(Math.abs(a - b)).toBeLessThan(1);
  });

  it('SNR 0dB では分離できず、フォールバックする', () => {
    // 発話とノイズのレベル差が3dBしかなく、分布が完全に重なる。
    // 二峰性が成立しないので代替手段（分布の下寄りのパーセンタイル）に落ちる。
    const { out, trueSnrDb } = withNoise(burstsWithSilence(), 0);
    const est = estimateSnr(out, SR);
    expect(est.noiseFrames, '代替手段に落ちていること').toBe(0);
    expect(Math.abs((est.snrDb as number) - trueSnrDb)).toBeLessThan(4);
  });

  it('分離できない領域では楽観側に外さない', () => {
    // ここは「一番騒がしい録音」の領域で、楽観側の誤りだけが実害を持つ
    // （騒がしい部屋を「そこまで悪くない」と言う）。以前は代替手段に第2
    // パーセンタイルを使っており、実音声4話者の実測でノイズパワーを
    // -1.52dB 過小評価し、SNRを +1.53dB 楽観的に読んでいた。
    for (const snr of [0, 2, 4]) {
      const { out, trueSnrDb } = withNoise(burstsWithSilence(), snr);
      const est = estimateSnr(out, SR);
      expect((est.snrDb as number) - trueSnrDb, `snr=${snr} 楽観側のずれ`).toBeLessThan(1);
    }
  });

  it('混合パワーの補正が効いている', () => {
    // 旧実装は有音区間の観測値を発話単体として扱っており、SNR 0dB を +3dB 以上に読んでいた
    const { out } = withNoise(burstsWithSilence(), 0);
    expect(estimateSnr(out, SR).snrDb as number).toBeLessThan(2);
  });

  it('残響の尾をノイズとして数えない', () => {
    // 残響のみ（付加ノイズ無し）。RT60を渡すと尾がノイズフロアから除外される
    const data = decayingBursts(0.8);
    const naive = estimateSnr(data, SR).snrDb as number;
    const aware = estimateSnr(data, SR, 0.8).snrDb as number;
    expect(aware).toBeGreaterThan(naive);
  });
});

describe('estimateLevel', () => {
  it('無音区間があっても有効音声レベルは発話区間のレベルを返す', () => {
    // 振幅0.1のバースト（RMS ≒ 0.0577 → 約 -24.8dBFS）が半分、残り半分は無音。
    // 全体RMSは約3dB低く出るが、有効音声レベルは発話区間の値を保つ。
    const data = burstsWithSilence(0.1);
    const { activeSpeechDbfs, overallDbfs } = estimateLevel(data, SR);
    expect(activeSpeechDbfs).not.toBeNull();
    expect(activeSpeechDbfs as number).toBeGreaterThan(overallDbfs + 1);
  });

  it('無音の割合が変わっても有効音声レベルは変わらない', () => {
    const few  = estimateLevel(burstsWithSilence(0.1, 3), SR).activeSpeechDbfs as number;
    const many = estimateLevel(burstsWithSilence(0.1, 8), SR).activeSpeechDbfs as number;
    expect(Math.abs(few - many)).toBeLessThan(1);
  });
});

/**
 * サンプルレート非依存性。
 *
 * 製品のマイク録音は48kHzだが、検証に使える公開コーパスは16kHzが主流。
 * 推定器の定数はすべて秒/Hzで書いてあるが、FFT長だけは2048固定なので
 * 周波数分解能はサンプルレートに反比例する（16kHz:7.8Hz/bin →
 * 48kHz:23.4Hz/bin）。同じ内容を違うレートで測って一致することを確かめる。
 */
describe('サンプルレートを変えても推定値が変わらない', () => {
  it('RT60は16kHzでも48kHzでも同じ値を返す', () => {
    for (const rt60 of [0.3, 0.5]) {
      const a = estimateReverb(decayingBursts(rt60), SR).rt60Sec as number;
      const b = estimateReverb(decayingBursts(rt60, { sampleRate: MIC_SR }), MIC_SR).rt60Sec as number;
      expect(a, `rt60=${rt60} 16kHz`).not.toBeNull();
      expect(b, `rt60=${rt60} 48kHz`).not.toBeNull();
      expect(Math.abs(a - b), `rt60=${rt60} レート間の差`).toBeLessThan(0.05);
    }
  });

  it('SNRは16kHzでも48kHzでも同じ値を返す', () => {
    // バースト(振幅0.1)と、-60dBFSのフロアだけの区間。SNRは構成上ほぼ一定。
    const a = estimateSnr(decayingBursts(0.3), SR).snrDb;
    const b = estimateSnr(decayingBursts(0.3, { sampleRate: MIC_SR }), MIC_SR).snrDb;
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(Math.abs((a as number) - (b as number))).toBeLessThan(1.5);
  });

  it('有効音声レベルは16kHzでも48kHzでも同じ値を返す', () => {
    const a = estimateLevel(decayingBursts(0.3), SR).activeSpeechDbfs as number;
    const b = estimateLevel(decayingBursts(0.3, { sampleRate: MIC_SR }), MIC_SR).activeSpeechDbfs as number;
    expect(Math.abs(a - b)).toBeLessThan(0.5);
  });
});
