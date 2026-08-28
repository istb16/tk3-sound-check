import { describe, expect, it } from 'vitest';
import { detectProvenance, unreliableAxes } from './provenance.ts';
import { analyzeSamples } from './AudioAnalyzer.ts';
import { addImpulses, pinkNoise, rng } from '../../test-support/signals.ts';

const SR = 32000;          // ナイキスト 16kHz
const DURATION = 2;
const LEN = SR * DURATION;

/**
 * 指定した上限周波数までの正弦波を重ね合わせた帯域制限ノイズ。
 * カットオフより上に一切エネルギーが無い理想的な崖を作れるので、
 * 帯域上限の実測値を既知の値と直接比較できる。
 */
function bandLimitedNoise(cutoffHz: number, opts: { slopeDbPerOct?: number; amp?: number } = {}): Float32Array {
  const { slopeDbPerOct = 0, amp = 0.2 } = opts;
  const data = new Float32Array(LEN);
  const step = 100;
  const comps: Array<{ f: number; a: number; phase: number }> = [];
  for (let f = step; f <= cutoffHz - step; f += step) {
    const oct = Math.log2(f / step);
    comps.push({ f, a: Math.pow(10, (slopeDbPerOct * oct) / 20), phase: (f * 7919) % (2 * Math.PI) });
  }
  for (const { f, a, phase } of comps) {
    const w = (2 * Math.PI * f) / SR;
    for (let i = 0; i < LEN; i++) data[i] += a * Math.sin(w * i + phase);
  }
  // ピークで正規化してクリッピング判定を巻き込まないようにする
  let peak = 0;
  for (let i = 0; i < LEN; i++) peak = Math.max(peak, Math.abs(data[i]));
  if (peak > 0) for (let i = 0; i < LEN; i++) data[i] = (data[i] / peak) * amp;
  return data;
}

describe('detectProvenance — 帯域上限の実測', () => {
  it('フルバンド信号はカットオフを検出せず、帯域制限とも判定しない', () => {
    const p = detectProvenance(bandLimitedNoise(SR / 2, { slopeDbPerOct: -6 }), SR);
    expect(p.bandwidthHz).toBe(SR / 2);
    expect(p.flags).not.toContain('band-limited');
  });

  it('4kHzで切られた音声は帯域上限を4kHz付近と実測し、帯域制限と判定する', () => {
    const p = detectProvenance(bandLimitedNoise(4000), SR);
    expect(p.bandwidthHz).toBeGreaterThan(3600);
    expect(p.bandwidthHz).toBeLessThan(4400);
    expect(p.flags).toContain('band-limited');
    expect(p.processed).toBe(true);
  });

  it('電話品質(3.4kHz)も検出できる', () => {
    const p = detectProvenance(bandLimitedNoise(3400), SR);
    expect(p.bandwidthHz).toBeGreaterThan(3000);
    expect(p.bandwidthHz).toBeLessThan(3800);
    expect(p.flags).toContain('band-limited');
  });

  it('12kHzカットオフは帯域上限として実測するが、音声用途では警告しない', () => {
    const p = detectProvenance(bandLimitedNoise(12000), SR);
    expect(p.bandwidthHz).toBeGreaterThan(11500);
    expect(p.bandwidthHz).toBeLessThan(12500);
    expect(p.flags).not.toContain('band-limited');
  });

  it('自然なロールオフ(-12dB/oct)を人工的なカットオフと誤検出しない', () => {
    // 高域はピークから50dB以上下がるが、崖ではないので帯域制限ではない
    const p = detectProvenance(bandLimitedNoise(SR / 2, { slopeDbPerOct: -12 }), SR);
    expect(p.bandwidthHz).toBe(SR / 2);
    expect(p.flags).not.toContain('band-limited');
  });
});

describe('detectProvenance — ノイズ抑制の痕跡', () => {
  it('自然なノイズフロアを持つ録音は加工済みと判定しない', () => {
    const data = bandLimitedNoise(SR / 2, { slopeDbPerOct: -6 });
    // 前半0.5秒を「無音区間」にする（-52dBFS 相当の実在するノイズフロア）
    for (let i = 0; i < SR * 0.5; i++) data[i] = 0.0025 * (Math.random() * 2 - 1);
    const p = detectProvenance(data, SR);
    expect(p.silenceFloorDb).toBeGreaterThan(-75);
    expect(p.flags).toEqual([]);
    expect(p.processed).toBe(false);
  });

  it('無音区間が不自然に静かならノイズ抑制の痕跡と判定する', () => {
    const data = bandLimitedNoise(SR / 2, { slopeDbPerOct: -6 });
    for (let i = 0; i < SR * 0.5; i++) data[i] = 1e-6 * (Math.random() * 2 - 1);
    const p = detectProvenance(data, SR);
    expect(p.silenceFloorDb).toBeLessThan(-75);
    expect(p.flags).toContain('digital-silence');
  });

  it('完全な無音が連続していればゲートの痕跡と判定する', () => {
    const data = bandLimitedNoise(SR / 2, { slopeDbPerOct: -6 });
    const zeroFrom = Math.floor(SR * 0.5);
    const zeroTo   = Math.floor(SR * 0.8); // 300ms の完全無音
    for (let i = zeroFrom; i < zeroTo; i++) data[i] = 0;
    const p = detectProvenance(data, SR);
    expect(p.maxZeroRunMs).toBeGreaterThan(250);
    expect(p.flags).toContain('zero-run');
  });
});

describe('unreliableAxes', () => {
  // この道具が答えるのは「できあがった音声が会議の録音として使えるか」であって
  // 「部屋の音響がよいか」ではない。ノイズ抑制が入っていて結果の音声に問題が
  // なければ音質はよい。加工そのものを欠点として扱わないので、痕跡があっても
  // 軸を参考値に落とさない。
  //
  // 以前は帯域制限で周波数軸とノイズ軸、ノイズ抑制でノイズ軸と残響軸を落として
  // いた。帯域が削られたぶんは周波数軸の帯域幅の内訳が直接減点するので、
  // 参考値扱いは二重の扱いでもあった。
  it('痕跡があっても軸を参考値に落とさない', () => {
    for (const cutoff of [3400, 4000, 8000]) {
      const p = detectProvenance(bandLimitedNoise(cutoff), SR);
      expect(p.flags, `cutoff=${cutoff}`).toContain('band-limited');
      expect(unreliableAxes(p), `cutoff=${cutoff}`).toEqual([]);
    }
  });

  it('痕跡がなければ当然何も落とさない', () => {
    const data = bandLimitedNoise(SR / 2, { slopeDbPerOct: -6 });
    for (let i = 0; i < SR * 0.5; i++) data[i] = 0.0025 * (Math.random() * 2 - 1);
    expect(unreliableAxes(detectProvenance(data, SR))).toEqual([]);
  });
});

describe('analyzeSamples', () => {
  it('provenance を含めて返す（スコアには影響しない）', () => {
    const clean = bandLimitedNoise(SR / 2, { slopeDbPerOct: -6 });
    const res = analyzeSamples(clean, SR);
    expect(res.provenance).toBeDefined();
    expect(res.provenance.bandwidthHz).toBe(SR / 2);
    // 同じサンプルなら帯域制限版でもスコア計算自体は独立に動く
    const limited = analyzeSamples(bandLimitedNoise(4000), SR);
    expect(limited.provenance.flags).toContain('band-limited');
    expect(limited.overall).toBeGreaterThanOrEqual(0);
    expect(limited.overall).toBeLessThanOrEqual(100);
  });

  it('帯域を削ると周波数バランスのスコアが下がる', () => {
    // 旧実装では比率の分母が0〜ナイキストだったため、削られた帯域が分母から
    // 消えて「削るほど高得点」になっていた。分母を有効帯域内に限定し、
    // 帯域幅を独立した内訳に加えて修正済み。
    // 音声のスペクトル傾斜(-12dB/oct)を与えて評価する。フラットノイズでは
    // 全帯域版が高域のキンキン判定で減点されるため、帯域幅の効果が埋もれる。
    const opts = { slopeDbPerOct: -12 };
    const full    = analyzeSamples(bandLimitedNoise(SR / 2, opts), SR);
    const limited = analyzeSamples(bandLimitedNoise(4000, opts), SR);
    expect(full.frequency).toBeGreaterThan(limited.frequency);
  });

  it('帯域上限が広がるほど周波数バランスのスコアが単調に上がる', () => {
    const opts = { slopeDbPerOct: -12 };
    const scores = [3400, 4000, 5500, 7000].map(
      (hz) => analyzeSamples(bandLimitedNoise(hz, opts), SR).frequency,
    );
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeGreaterThan(scores[i - 1]);
    }
  });

  it('16kHzまでは帯域が広いほど加点する', () => {
    // 以前は7kHz以上を同点にしていた（明瞭度上それで足りるため）。品質の尺度としては
    // 上が詰まっており、8.1kHzの実録音と24kHzの実録音が同じ満点になっていた。
    // 満点を16kHz（ITU-Tの超広帯域が14kHz、フルバンドが20kHz）に置き直した。
    // 「明瞭度上7kHzで足りる」ことは判定の閾値の側で表現する。
    const opts = { slopeDbPerOct: -12 };
    const at5k  = analyzeSamples(bandLimitedNoise(5000, opts), SR).frequency;
    const at7k  = analyzeSamples(bandLimitedNoise(7000, opts), SR).frequency;
    const at12k = analyzeSamples(bandLimitedNoise(12000, opts), SR).frequency;
    expect(at7k).toBeGreaterThan(at5k);
    expect(at12k).toBeGreaterThan(at7k);
  });
});

/**
 * 製品のマイク録音は48kHzで入る。コーパスの検証は16kHz中心なので、
 * 分解能が3倍粗い側（48kHz: 23.4Hz/bin）でも崖を見つけられることを別に固定する。
 *
 * これは机上の条件ではなく主要な実使用パターンそのもの。Zoom/Teams の音を
 * スピーカー経由やループバックで48kHzで録れば、中身は8kHz以下しか無い。
 */
describe('detectProvenance — 48kHz録音', () => {
  const MIC_SR = 48000;
  const MIC_LEN = MIC_SR * 2;

  /** 指定レートで、cutoffHz までの正弦波を重ねた帯域制限ノイズ */
  function noiseAt(sampleRate: number, len: number, cutoffHz: number, slopeDbPerOct = -6): Float32Array {
    const data = new Float32Array(len);
    const step = 100;
    for (let f = step; f <= cutoffHz - step; f += step) {
      const a = Math.pow(10, (slopeDbPerOct * Math.log2(f / step)) / 20);
      const w = (2 * Math.PI * f) / sampleRate;
      const phase = (f * 7919) % (2 * Math.PI);
      for (let i = 0; i < len; i++) data[i] += a * Math.sin(w * i + phase);
    }
    let peak = 0;
    for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(data[i]));
    if (peak > 0) for (let i = 0; i < len; i++) data[i] = (data[i] / peak) * 0.2;
    return data;
  }

  it('48kHz録音でも8kHzの帯域制限を見つける', () => {
    const p = detectProvenance(noiseAt(MIC_SR, MIC_LEN, 8000), MIC_SR);
    expect(Math.abs(p.bandwidthHz - 8000)).toBeLessThanOrEqual(200);
    expect(p.flags).toContain('band-limited');
  });

  it('48kHz録音の電話品質(3.4kHz)も同じ精度で見つける', () => {
    const p = detectProvenance(noiseAt(MIC_SR, MIC_LEN, 3400), MIC_SR);
    expect(Math.abs(p.bandwidthHz - 3400)).toBeLessThanOrEqual(200);
    expect(p.flags).toContain('band-limited');
  });

  it('48kHzのフルバンド信号は帯域制限と誤判定しない', () => {
    const p = detectProvenance(noiseAt(MIC_SR, MIC_LEN, MIC_SR / 2), MIC_SR);
    expect(p.flags).not.toContain('band-limited');
  });
});

describe('衝撃性ノイズの検出', () => {
  const SPEECH_SR = 16000;
  const SPEECH_LEN = SPEECH_SR * 10;

  /**
   * 発話らしい信号。有音区間と無音区間を交互に持つ。
   * 衝撃音の検出は「前後より突出した短い立ち上がり」を数えるので、
   * 発話の立ち上がり・立ち下がりで誤検出しないことをここで確かめる。
   */
  function speechLike(): Float32Array {
    const data = new Float32Array(SPEECH_LEN);
    const rand = rng(4242);
    // 0.6秒発話 / 0.4秒無音を繰り返す
    for (let t = 0; t < SPEECH_LEN; t++) {
      const phase = (t / SPEECH_SR) % 1;
      const voiced = phase < 0.6;
      const env = voiced ? 0.2 * (0.6 + 0.4 * Math.sin((phase / 0.6) * Math.PI)) : 0.0004;
      // 200Hz の基音に3つのフォルマントを重ねた粗い模擬
      const s = Math.sin((2 * Math.PI * 200 * t) / SPEECH_SR)
        + 0.5 * Math.sin((2 * Math.PI * 700 * t) / SPEECH_SR)
        + 0.3 * Math.sin((2 * Math.PI * 1800 * t) / SPEECH_SR);
      data[t] = env * (s / 1.8) + 0.0003 * (rand() * 2 - 1);
    }
    return data;
  }

  it('打鍵音を入れると申告する', () => {
    // 毎秒2回。検出の閾値(0.5回/秒)より十分多い
    const times: number[] = [];
    for (let t = 0.15; t < 9.5; t += 0.5) times.push(t);
    const data = addImpulses(speechLike(), SPEECH_SR, times, 0.35, 7);

    const p = detectProvenance(data, SPEECH_SR);
    expect(p.impulsePeaksPerSec).toBeGreaterThanOrEqual(0.5);
    expect(p.flags).toContain('impulsive-noise');
  });

  it('発話だけなら申告しない', () => {
    // 空振りは見落としより重い。発話の立ち上がりを衝撃音と数えてはいけない
    const p = detectProvenance(speechLike(), SPEECH_SR);
    expect(p.impulsePeaksPerSec).toBeLessThan(0.5);
    expect(p.flags).not.toContain('impulsive-noise');
  });

  it('定常ノイズを足しても申告しない', () => {
    const data = speechLike();
    const noise = pinkNoise(data.length, 0.01, 99);
    for (let i = 0; i < data.length; i++) data[i] += noise[i];

    const p = detectProvenance(data, SPEECH_SR);
    expect(p.flags).not.toContain('impulsive-noise');
  });

  it('申告してもスコアと判定は動かさない', () => {
    // 加工痕跡と同じ扱い。参考値に落とすと、空振りしたときに
    // 正常な録音のノイズ軸が消えることになる
    const times: number[] = [];
    for (let t = 0.15; t < 9.5; t += 0.5) times.push(t);
    const clean = speechLike();
    const clicky = addImpulses(speechLike(), SPEECH_SR, times, 0.35, 7);

    const a = analyzeSamples(clean, SPEECH_SR);
    const b = analyzeSamples(clicky, SPEECH_SR);
    expect(b.provenance.flags).toContain('impulsive-noise');
    expect(b.unreliable).toEqual(a.unreliable);
  });
});
