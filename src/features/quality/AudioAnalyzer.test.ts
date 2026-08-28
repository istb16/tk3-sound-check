import { describe, expect, it } from 'vitest';
import { analyzeAudio, AXIS_MAX, AXIS_RATIO_UNCERTAINTY } from './AudioAnalyzer.ts';

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

/**
 * 音量が小さい音声。振幅で指定する。
 * 0.005 → 約 -49dBFS / 0.0005 → 約 -69dBFS
 */
function quietBuffer(amp = 0.005, duration = 2, sr = 16000): AudioBuffer {
  return makeBuffer((data, sampleRate) => {
    for (let i = 0; i < data.length; i++) {
      data[i] = amp * Math.sin(2 * Math.PI * 300 * i / sampleRate);
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

/**
 * 帯域上限を指定した音声。200Hz刻みの成分を topHz まで並べる。
 * topHz より上は空になるので、帯域上限が topHz として検出される。
 */
function bandLimitedSpeechBuffer(topHz: number, sr = 32000, duration = 2): AudioBuffer {
  return makeBuffer((data, sampleRate) => {
    const silence = Math.floor(sampleRate * 0.3);
    const comps: Array<{ f: number; a: number }> = [];
    for (let f = 200; f <= topHz; f += 200) {
      const db = f <= 1000 ? 0 : -6 * Math.log2(f / 1000);
      comps.push({ f, a: Math.pow(10, db / 20) });
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

  it('音量が小さければ減点しなくても助言は出す', async () => {
    // レポートの評価とアドバイスを分けている。レベルは正規化すれば直るので
    // 減点はしないが、入力ゲインを上げたほうがよいことは伝える価値がある。
    // 実録音4本の有効音声レベルは -26.2〜-47.4dBFS で、民生機材はこの帯に入る。
    const quiet = await analyzeAudio(quietBuffer(0.005)); // 約 -49dBFS
    expect(quiet.volume).toBe(AXIS_MAX.volume);
    expect(quiet.advice.some((a) => a.code === 'level-low')).toBe(true);
  });

  it('量子化フロアに近づくと volume を減点する', async () => {
    // 減点の根拠は量子化フロア。16bitのフロアは -96dBFS なので、発話が -50dBFS でも
    // 46dBの余裕がある。それ以下になると量子化雑音が聞こえ始める。
    const veryQuiet = await analyzeAudio(quietBuffer(0.0005)); // 約 -69dBFS
    const clean = await analyzeAudio(cleanSpeechBuffer());
    expect(veryQuiet.volume).toBeLessThan(clean.volume);
    expect(veryQuiet.advice.some((a) => a.code === 'level-low')).toBe(true);
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

  it('帯域が広いほど加点するが、8kHzあれば帯域不足の助言は出さない', async () => {
    // 採点と助言を分けている。採点は品質の尺度（16kHz満点）なので8kHzでも満点には
    // ならないが、助言は明瞭度の基準（7kHz）で出す。8.1kHz帯域は16kHzサンプリング
    // 由来で、OS標準の録音アプリや会議端末の大半がこれ。会議音声として問題無い。
    const wide   = await analyzeAudio(bandLimitedSpeechBuffer(15000));
    const eightK = await analyzeAudio(bandLimitedSpeechBuffer(8000));
    expect(eightK.frequency).toBeLessThan(wide.frequency);
    expect(eightK.advice.some((a) => a.code === 'bandwidth-narrow')).toBe(false);
  });

  it('電話帯域まで削られていれば帯域不足の助言を出す', async () => {
    // 3.4kHz(電話) や 4kHz(Bluetooth HFP) は摩擦音・サ行の識別に足りず、
    // どちらも利用者が録り方を変えれば直せる。
    const narrow = await analyzeAudio(bandLimitedSpeechBuffer(4000, 16000));
    expect(narrow.advice.some((a) => a.code === 'bandwidth-narrow')).toBe(true);
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

  it('測定不能で断定しないときは、その軸を足を引っ張っている軸として挙げる', async () => {
    const r = await analyzeAudio(cleanSpeechBuffer());
    if (r.verdict.unconfirmed === 'unmeasured') {
      expect(r.verdict.level).toBe('usable');
      expect(r.verdict.limitingAxis).not.toBeNull();
      expect(r.unreliable).toContain(r.verdict.limitingAxis);
    }
  });
});

// ==========================================================================
// 判定の断定を止める条件
// ==========================================================================
//
// 判定は3値なので、問うべきは「点数の誤差が何点か」ではなく
// 「同じ部屋を測り直して同じ答えが出るか」である。実測では出なかった
// （真のRT60 0.7秒を固定して振ると good / usable / poor に3つに割れた）。
// 各軸に実測MAEから決めた不確かさを持たせ、境界の誤差圏内では断定しない。
describe('analyzeAudio — 境界に近いときは断定しない', () => {
  const AXES = Object.keys(AXIS_MAX) as Array<keyof typeof AXIS_MAX>;
  const GOOD_RATIO = 0.55;
  const USABLE_RATIO = 0.35;
  const ratiosOf = (r: Awaited<ReturnType<typeof analyzeAudio>>) =>
    AXES.map((axis) => ({ axis, ratio: r[axis] / AXIS_MAX[axis] }));

  const buffers = () => [
    cleanSpeechBuffer(), highFreqBuffer(), mudBuffer(), clippedBuffer(),
    pureNoiseBuffer(), quietBuffer(), tiltedSpeechBuffer(-12), bandLimitedSpeechBuffer(4000),
  ];

  it('「十分」と断定するのは全部の軸が境界から誤差ぶん離れているときだけ', async () => {
    // 最弱の軸だけを見てはいけない。軸が同点で並ぶと、どちらが「最弱」に
    // 選ばれるかで不確かさ（周波数0.03 / 残響0.14）が変わってしまう。
    for (const buf of buffers()) {
      const r = await analyzeAudio(buf);
      if (r.verdict.level !== 'good') continue;
      for (const { axis, ratio } of ratiosOf(r)) {
        expect(ratio - GOOD_RATIO, `${axis} が境界に近すぎる`)
          .toBeGreaterThanOrEqual(AXIS_RATIO_UNCERTAINTY[axis]);
      }
      expect(r.verdict.unconfirmed).toBe(false);
    }
  });

  it('境界の誤差圏内なら near-boundary を立てる', async () => {
    for (const buf of buffers()) {
      const r = await analyzeAudio(buf);
      if (r.verdict.unconfirmed !== 'near-boundary') continue;
      const near = ratiosOf(r).some(({ axis, ratio }) =>
        Math.abs(ratio - GOOD_RATIO) < AXIS_RATIO_UNCERTAINTY[axis]
        || Math.abs(ratio - USABLE_RATIO) < AXIS_RATIO_UNCERTAINTY[axis]);
      expect(near, 'どの軸も境界から離れているのに near-boundary が立っている').toBe(true);
    }
  });

  it('下側の境界では判定そのものは動かさない', async () => {
    // 上側は good → usable に落とす（測れていないものを褒めない）。
    // 下側で poor → usable に上げるのは良い側に振る操作なので、しない。
    // 一貫した原則は「境界では良い側に振らない」。
    for (const buf of buffers()) {
      const r = await analyzeAudio(buf);
      const worst = Math.min(...ratiosOf(r).map((x) => x.ratio));
      if (worst >= GOOD_RATIO) continue;
      expect(r.verdict.level).toBe(worst >= USABLE_RATIO ? 'usable' : 'poor');
    }
  });

  it('残響の不確かさは判定帯の幅の半分以上ある（細かく読めないことの記録）', () => {
    // 残響軸は 0.2秒で満点・0.9秒で0点なので、確定値のRT60の MAE 0.093秒 は
    // 達成率 0.13 に相当する。判定の境界の間隔は 0.55-0.35 = 0.20 しかない。
    // **この不等式が成り立つ限り、残響が限定要因の録音は境界付近で断定できない。**
    // 推定が良くなって成り立たなくなったら、この行を消してよい。
    expect(AXIS_RATIO_UNCERTAINTY.reverb).toBeGreaterThanOrEqual((GOOD_RATIO - USABLE_RATIO) / 2);
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
