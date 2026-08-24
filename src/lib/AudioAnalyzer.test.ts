import { describe, expect, it } from 'vitest';
import { analyzeAudio, AXIS_MAX } from './AudioAnalyzer.ts';

// 合成 AudioBuffer を作るヘルパー
function makeBuffer(
  fillFn: (data: Float32Array, sampleRate: number) => void,
  duration = 2,
  sampleRate = 16000,
): AudioBuffer {
  const ctx = new OfflineAudioContext(1, Math.floor(duration * sampleRate), sampleRate);
  const buf = ctx.createBuffer(1, Math.floor(duration * sampleRate), sampleRate);
  fillFn(buf.getChannelData(0), sampleRate);
  return buf;
}

// 無音区間 + サイン波：SNR推定・音量推定が機能するリアルな構造
// amp=0.15 のサイン波は RMS ≒ 0.106 (dBFS ≒ -19.5dB) で理想帯域(-20〜-14dB)に収まる
function cleanSpeechBuffer(freq = 1000, amp = 0.15, duration = 2, sr = 16000): AudioBuffer {
  return makeBuffer((data, sampleRate) => {
    const silenceSamples = Math.floor(sampleRate * 0.3);
    for (let i = 0; i < data.length; i++) {
      data[i] = i < silenceSamples
        ? 0.003 * (Math.random() * 2 - 1)  // 超低レベルの背景雑音（-50dB 相当）
        : amp * Math.sin(2 * Math.PI * freq * i / sampleRate);
    }
  }, duration, sr);
}

// 完全クリッピングのスクエア波
function clippedBuffer(duration = 2): AudioBuffer {
  return makeBuffer((data) => {
    for (let i = 0; i < data.length; i++) {
      data[i] = i % 80 < 40 ? 1.0 : -1.0;
    }
  }, duration);
}

// 音声帯域外の高周波（7.5kHz、サ行の刺さりを模した帯域）
function highFreqBuffer(duration = 2, sr = 16000): AudioBuffer {
  return makeBuffer((data, sampleRate) => {
    const silenceSamples = Math.floor(sampleRate * 0.3);
    for (let i = 0; i < data.length; i++) {
      data[i] = i < silenceSamples
        ? 0.003 * (Math.random() * 2 - 1)
        : 0.15 * Math.sin(2 * Math.PI * 7500 * i / sampleRate);
    }
  }, duration, sr);
}

// 高レベルノイズ（信号なし）
function pureNoiseBuffer(noiseAmp = 0.7, duration = 2, sr = 16000): AudioBuffer {
  return makeBuffer((data) => {
    for (let i = 0; i < data.length; i++) {
      data[i] = noiseAmp * (Math.random() * 2 - 1);
    }
  }, duration, sr);
}

// 極端に音量が小さい（ボソボソ声）音声
function quietBuffer(duration = 2, sr = 16000): AudioBuffer {
  return makeBuffer((data, sampleRate) => {
    for (let i = 0; i < data.length; i++) {
      data[i] = 0.005 * Math.sin(2 * Math.PI * 300 * i / sampleRate);
    }
  }, duration, sr);
}

// 低音域(100Hz)が支配的な、こもった音声
function mudBuffer(duration = 2, sr = 16000): AudioBuffer {
  return makeBuffer((data, sampleRate) => {
    const silenceSamples = Math.floor(sampleRate * 0.3);
    for (let i = 0; i < data.length; i++) {
      data[i] = i < silenceSamples
        ? 0.003 * (Math.random() * 2 - 1)
        : 0.15 * Math.sin(2 * Math.PI * 100 * i / sampleRate);
    }
  }, duration, sr);
}

/**
 * 帯域は保ったまま1kHz以上を dbPerOct で落とした音声。
 * 周波数領域で各成分の振幅を直接決めるので、傾きは構成上既知。
 */
function tiltedSpeechBuffer(dbPerOct: number, duration = 2, sr = 16000): AudioBuffer {
  return makeBuffer((data, sampleRate) => {
    const silence = Math.floor(sampleRate * 0.3);
    // 200Hz刻みで7kHzまで、自然な音声に近い -6dB/oct の傾きを基準に置く
    const comps: Array<{ f: number; a: number }> = [];
    for (let f = 200; f <= 7000; f += 200) {
      const oct = Math.log2(f / 1000);
      const baseDb = f <= 1000 ? 0 : -6 * oct;
      const addDb  = f <= 1000 ? 0 : dbPerOct * oct;
      comps.push({ f, a: Math.pow(10, (baseDb + addDb) / 20) });
    }
    let peak = 0;
    const tmp = new Float32Array(data.length);
    for (let i = silence; i < data.length; i++) {
      let v = 0;
      for (const c of comps) v += c.a * Math.sin((2 * Math.PI * c.f * i) / sampleRate + c.f);
      tmp[i] = v;
      peak = Math.max(peak, Math.abs(v));
    }
    for (let i = 0; i < data.length; i++) {
      data[i] = i < silence
        ? 0.0005 * (Math.random() * 2 - 1)
        : (tmp[i] / (peak || 1)) * 0.2;
    }
  }, duration, sr);
}

// ---- テストスイート ----

describe('analyzeAudio — 戻り値の型と範囲', () => {
  it('全スコアが 0〜100 の整数で返る', async () => {
    const result = await analyzeAudio(cleanSpeechBuffer());
    for (const k of ['overall', 'volume', 'frequency', 'reverb', 'clip', 'noise'] as const) {
      expect(result[k], `${k} should be a number`).toBeTypeOf('number');
      expect(result[k], `${k} >= 0`).toBeGreaterThanOrEqual(0);
      expect(result[k], `${k} <= 100`).toBeLessThanOrEqual(100);
      expect(Number.isInteger(result[k]), `${k} is integer`).toBe(true);
    }
  });

  it('各詳細スコアはそれぞれの満点を超えない', async () => {
    const result = await analyzeAudio(cleanSpeechBuffer());
    for (const [axis, max] of Object.entries(AXIS_MAX)) {
      expect(result[axis as keyof typeof AXIS_MAX], axis).toBeLessThanOrEqual(max);
    }
  });

  it('各軸の満点の合計が100になる', () => {
    const total = Object.values(AXIS_MAX).reduce((a, b) => a + b, 0);
    expect(total).toBe(100);
  });

  it('overall は各詳細スコアの合計と一致する', async () => {
    const result = await analyzeAudio(cleanSpeechBuffer());
    expect(result.overall).toBe(
      result.volume + result.frequency + result.reverb + result.clip + result.noise,
    );
  });

  it('advice は文面ではなくコードで返る（文面は i18n 側）', async () => {
    const result = await analyzeAudio(cleanSpeechBuffer());
    expect(Array.isArray(result.advice)).toBe(true);
    for (const tip of result.advice) {
      expect(tip.code).toBeTypeOf('string');
      if (tip.value !== undefined) expect(tip.value).toBeTypeOf('number');
    }
  });
});

describe('analyzeAudio — 音量評価', () => {
  it('理想帯域(-20〜-14dB)の音声は volume スコアが満点になる', async () => {
    // 無音区間が0.3秒あっても満点。有効音声レベル(ITU-T P.56相当)で判定しており、
    // 全体RMSを使っていた旧実装のように無音で引きずられない。
    const result = await analyzeAudio(cleanSpeechBuffer());
    expect(result.volume).toBe(AXIS_MAX.volume);
  });

  it('極端に音量が小さい音声は volume スコアが低く、アドバイスが出る', async () => {
    const quiet = await analyzeAudio(quietBuffer());
    const clean = await analyzeAudio(cleanSpeechBuffer());
    expect(quiet.volume).toBeLessThan(clean.volume);
    expect(quiet.advice.some((a) => a.code === 'level-low')).toBe(true);
  });
});

describe('analyzeAudio — 周波数バランス評価', () => {
  it('帯域外(7.5kHz)しか無い音声は満点にならない', async () => {
    // 旧設計では「1kHzの純音 > 7.5kHzの純音」を確かめていたが、内訳を
    // 帯域幅と傾斜にした時点でその比較は成り立たない——7.5kHzの純音のほうが
    // 帯域としては広いので、順序が逆になるのが正しい。どちらも録音として
    // 意味のある入力ではないので、比較ではなく「満点を与えない」ことを見る。
    const result = await analyzeAudio(highFreqBuffer());
    expect(result.frequency).toBeLessThan(AXIS_MAX.frequency);
  });

  it('1kHz以上に信号が無い音声は、周波数軸を参考値として開示する', async () => {
    // 100Hzの正弦波＋微小雑音。帯域上限としてはナイキストまで（雑音の）中身があり、
    // その判定自体は間違っていない。しかし傾斜は近似区間がスペクトルの床なので
    // 測れない。測れていない10点分を黙って中間値で埋めるのではなく開示する。
    const result = await analyzeAudio(mudBuffer());
    expect(result.unreliable).toContain('frequency');
    expect(result.verdict.level).not.toBe('good');
  });

  it('高域を緩やかに落とした音声は frequency スコアが下がり、こもりのアドバイスが出る', async () => {
    // 帯域は削らず傾きだけを与える劣化（マイクが服の下・机の下・口から遠い）。
    // 以前の内訳（500〜3000Hzの比率）は実測でこれに 0.5/25点しか反応せず、
    // 一方で話者間のばらつきが7点あった。声質を測っていたので置き換えた。
    const flat    = await analyzeAudio(tiltedSpeechBuffer(0));
    const muffled = await analyzeAudio(tiltedSpeechBuffer(-14));
    expect(muffled.frequency).toBeLessThan(flat.frequency);
    expect(muffled.advice.some((a) => a.code === 'muffled')).toBe(true);
  });
});

describe('analyzeAudio — 音割れ（クリッピング）検出', () => {
  it('スクエア波（完全クリッピング）は clip がほぼ0点になる', async () => {
    const result = await analyzeAudio(clippedBuffer());
    expect(result.clip).toBeLessThan(AXIS_MAX.clip * 0.2);
    expect(result.advice.some((a) => a.code === 'clipping')).toBe(true);
  });

  it('適度な振幅のサイン波は clip が満点になる', async () => {
    const result = await analyzeAudio(cleanSpeechBuffer(440, 0.15));
    expect(result.clip).toBe(AXIS_MAX.clip);
  });
});

describe('analyzeAudio — ノイズ・無音評価', () => {
  it('無音区間のあるクリーン音声はホワイトノイズより noise スコアが高い', async () => {
    const cleanResult = await analyzeAudio(cleanSpeechBuffer(1000));
    const noisyResult  = await analyzeAudio(pureNoiseBuffer(0.7));
    expect(cleanResult.noise).toBeGreaterThan(noisyResult.noise);
  });
});
describe('analyzeAudio — 判定（このまま会議していいか）', () => {
  it('判定と実測値を返す', async () => {
    const result = await analyzeAudio(cleanSpeechBuffer());
    expect(['good', 'usable', 'poor']).toContain(result.verdict.level);
    expect(result.measured.bandwidthHz).toBeGreaterThan(0);
  });

  it('判定は総合点の平均ではなく最も低い軸で決まる', async () => {
    // 完全クリッピングの音声。他の軸が高くても会議には使えない。
    const result = await analyzeAudio(clippedBuffer());
    expect(result.verdict.level).toBe('poor');

    // limitingAxis は達成率が最も低い軸であること（推測ではなく不変条件を検証する）
    const ratios = (Object.keys(AXIS_MAX) as Array<keyof typeof AXIS_MAX>).map((axis) => ({
      axis,
      ratio: result[axis] / AXIS_MAX[axis],
    }));
    const worst = ratios.reduce((a, b) => (b.ratio < a.ratio ? b : a));
    expect(result.verdict.limitingAxis).toBe(worst.axis);
  });

  it('総合点が同じでも、弱点が1つあれば判定は下がる', async () => {
    // 平均だけを見ると見落とす「弱点が支配する」性質を確認する
    const clipped = await analyzeAudio(clippedBuffer());
    const clean   = await analyzeAudio(cleanSpeechBuffer());
    expect(clean.overall).toBeGreaterThan(clipped.overall);
    expect(clipped.verdict.level).toBe('poor');
  });

  it('問題が無ければ足を引っ張る軸は無い', async () => {
    const result = await analyzeAudio(cleanSpeechBuffer());
    if (result.verdict.level === 'good') {
      expect(result.verdict.limitingAxis).toBeNull();
    } else {
      expect(result.verdict.limitingAxis).not.toBeNull();
    }
  });

  it('測定できなかった軸があるときは「十分」と判定しない', async () => {
    // 測定不能な軸には中間点を与えているため、そのまま good を出すと
    // 「測れなかった部屋」が「実測した悪い部屋」より高評価になる。
    for (const buf of [cleanSpeechBuffer(), highFreqBuffer(), mudBuffer(), clippedBuffer()]) {
      const r = await analyzeAudio(buf);
      if (r.unreliable.length > 0) {
        expect(r.verdict.level, r.unreliable.join(',')).not.toBe('good');
      }
    }
  });

  it('unconfirmed のときは足を引っ張っている軸として測定不能な軸を挙げる', async () => {
    const r = await analyzeAudio(cleanSpeechBuffer());
    if (r.verdict.unconfirmed) {
      expect(r.verdict.level).toBe('usable');
      expect(r.verdict.limitingAxis).not.toBeNull();
      expect(r.unreliable).toContain(r.verdict.limitingAxis);
    }
  });

  it('残響が測定不能なら残響スコアは満点の半分を超えない', async () => {
    // 0.6倍にしていた頃は、実測した0.7秒の部屋(13/20)より
    // 測定不能(12/20)のほうが高得点になっていた。
    const rnd = () => Math.random() * 2 - 1;
    const buf = makeBuffer((data) => { for (let i = 0; i < data.length; i++) data[i] = 0.1 * rnd(); });
    const r = await analyzeAudio(buf);
    expect(r.rt60Sec).toBeNull();
    expect(r.reverb).toBeLessThanOrEqual(AXIS_MAX.reverb * 0.5);
  });

  it('実測値は物理量であり、点数ではない', async () => {
    const result = await analyzeAudio(cleanSpeechBuffer());
    const m = result.measured;
    // 帯域上限はナイキスト以下
    expect(m.bandwidthHz).toBeLessThanOrEqual(16000 / 2);
    if (m.activeSpeechDbfs !== null) expect(m.activeSpeechDbfs).toBeLessThan(0);
    if (m.clipRate !== null) {
      expect(m.clipRate).toBeGreaterThanOrEqual(0);
      expect(m.clipRate).toBeLessThanOrEqual(1);
    }
  });
});
