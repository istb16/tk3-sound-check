import { describe, expect, it } from 'vitest';
import {
  BANDS_HZ, FRAME_MS, HowlingDetector, MAX_EVENTS, PROMINENCE_DB, bandOf,
} from './detector.ts';
import { formatOctaveBand } from '../../lib/dsp/octave.ts';
import { formatFrequency } from '../../lib/format.ts';
import {
  addHarmonicStack, addImpulses, addTone, clipHard, pinkNoise, silence, whiteNoise,
} from '../../test-support/signals.ts';
import { atRms, loadCorpusFile, mix } from '../../test-support/corpus.ts';

/**
 * ハウリング検出の実測。人手のラベル付けは不要——注入した周波数が真値になる。
 *
 * **測っているのは主に適合率のほうである。** 空振りは見落としより重い、という
 * 前提を置いたので、「鳴っていないのに鳴いたと言わないこと」がここでの主題になる。
 */

const SR = 48000; // 製品のマイク録音は48kHz
/** ワークレットが実際に送ってくるチャンクサイズ。区切り方に依存しないことも見る */
const CHUNK = 4096;

function run(samples: Float32Array, sampleRate = SR): {
  everRinging: boolean;
  detected: number[];
  maxBandProminence: number[];
  clipping: boolean;
  detector: HowlingDetector;
} {
  const det = new HowlingDetector(sampleRate);
  const detected: number[] = [];
  const maxBandProminence = BANDS_HZ.map(() => 0);
  let wasRinging = false;
  let clipping = false;

  for (let off = 0; off < samples.length; off += CHUNK) {
    const chunk = samples.subarray(off, Math.min(off + CHUNK, samples.length));
    if (!det.push(chunk)) continue;
    const s = det.state;
    for (let b = 0; b < BANDS_HZ.length; b++) {
      maxBandProminence[b] = Math.max(maxBandProminence[b], s.bandProminenceDb[b]);
    }
    if (s.clipping) clipping = true;
    if (s.ringing && !wasRinging && s.freqHz !== null) detected.push(s.freqHz);
    wasRinging = s.ringing;
  }

  return { everRinging: detected.length > 0, detected, maxBandProminence, clipping, detector: det };
}

// ==========================================================================
// 検証セット
// ==========================================================================

interface Case {
  name: string;
  build: () => Float32Array;
  /** 発振と言うべきか */
  ring: boolean;
  /** 言うべきなら、その周波数[Hz] */
  freqHz?: number;
}

const SECONDS = 3;
const N = SR * SECONDS;

/** 会場の暗騒音のつもり。ハウリング以外は全部これの上に乗る */
const bed = (seed: number, rms = 0.03): Float32Array => pinkNoise(N, rms, seed);

const POSITIVE: Case[] = [
  {
    name: '3.2kHz の発振（ピンクノイズ上）',
    ring: true, freqHz: 3200,
    build: () => addTone(bed(1), SR, 3200, 0.12, { startSec: 0.4 }),
  },
  {
    name: '200Hz の発振（演台マイクの低い鳴き・検出範囲の下端に近い）',
    ring: true, freqHz: 200,
    build: () => addTone(bed(2), SR, 200, 0.12, { startSec: 0.4 }),
  },
  {
    name: '320Hz の発振',
    ring: true, freqHz: 320,
    build: () => addTone(bed(8), SR, 320, 0.12, { startSec: 0.4 }),
  },
  {
    name: '450Hz の発振',
    ring: true, freqHz: 450,
    build: () => addTone(bed(3), SR, 450, 0.12, { startSec: 0.4 }),
  },
  {
    name: '1.05kHz の発振',
    ring: true, freqHz: 1050,
    build: () => addTone(bed(4), SR, 1050, 0.12, { startSec: 0.4 }),
  },
  {
    name: '7.5kHz の発振',
    ring: true, freqHz: 7500,
    build: () => addTone(bed(5), SR, 7500, 0.12, { startSec: 0.4 }),
  },
  {
    name: '0.4秒で殺された短い鳴き',
    ring: true, freqHz: 3200,
    build: () => addTone(bed(6), SR, 3200, 0.12, { startSec: 1.0, durationSec: 0.4 }),
  },
  {
    name: '喋っている最中の発振（声の倍音列と同居）',
    ring: true, freqHz: 3200,
    build: () => {
      const d = bed(7);
      addHarmonicStack(d, SR, 180, 0.06, 14, { startSec: 0.2, durationSec: 2.6, vibratoHz: 5, vibratoCents: 25 });
      return addTone(d, SR, 3200, 0.12, { startSec: 1.0 });
    },
  },
];

const NEGATIVE: Case[] = [
  { name: '無音', ring: false, build: () => silence(SECONDS, SR) },
  { name: 'ピンクノイズのみ', ring: false, build: () => bed(11, 0.05) },
  { name: '白色ノイズのみ', ring: false, build: () => whiteNoise(N, 0.05, 12) },
  {
    name: '空調のような定常ノイズ（低域に寄ったピンク）',
    ring: false,
    build: () => bed(13, 0.12),
  },
  {
    name: '電源ハム 50Hz とその倍音列',
    ring: false,
    build: () => addHarmonicStack(bed(14), SR, 50, 0.10, 24, { startSec: 0 }),
  },
  {
    name: '電源ハム 60Hz とその倍音列',
    ring: false,
    build: () => addHarmonicStack(bed(15), SR, 60, 0.10, 20, { startSec: 0 }),
  },
  {
    name: '拍手（突出するが持続しない）',
    ring: false,
    build: () => addImpulses(bed(16), SR, [0.5, 0.62, 0.71, 0.83, 0.9, 1.05, 1.2, 1.4, 1.6], 0.6, 17),
  },
  {
    name: '伸ばした歌声（ビブラート無し・最も紛らわしい）',
    ring: false,
    build: () => addHarmonicStack(bed(18), SR, 200, 0.12, 16, { startSec: 0.3, durationSec: 2.4 }),
  },
  {
    name: '伸ばした歌声（ビブラートあり）',
    ring: false,
    build: () => addHarmonicStack(bed(19), SR, 330, 0.12, 14, { startSec: 0.3, durationSec: 2.4, vibratoHz: 5.5, vibratoCents: 40 }),
  },
  {
    name: 'BGMのパッド（3和音）',
    ring: false,
    build: () => {
      const d = bed(20);
      addHarmonicStack(d, SR, 220, 0.08, 12, { startSec: 0.2, durationSec: 2.6 });
      addHarmonicStack(d, SR, 277, 0.08, 12, { startSec: 0.2, durationSec: 2.6 });
      addHarmonicStack(d, SR, 330, 0.08, 12, { startSec: 0.2, durationSec: 2.6 });
      return d;
    },
  },
  {
    name: '0.15秒しか鳴かなかった音（持続の要求を満たさない）',
    ring: false,
    build: () => addTone(bed(21), SR, 3200, 0.12, { startSec: 1.0, durationSec: 0.15, rampSec: 0.01 }),
  },
  {
    name: 'プロジェクタのファン（広帯域＋緩い山）',
    ring: false,
    build: () => {
      const d = bed(22, 0.06);
      // 細くない山。狭帯域性の判定で落ちるべき
      for (let f = 1800; f <= 2600; f += 25) addTone(d, SR, f, 0.004, { startSec: 0 });
      return d;
    },
  },
];

// ==========================================================================

describe('ハウリング検出 — 鳴いているものを指す', () => {
  for (const c of POSITIVE) {
    it(c.name, () => {
      const r = run(c.build());
      expect(r.everRinging, '発振として検出されること').toBe(true);
      const got = r.detected[0];
      const want = c.freqHz!;
      // 誤差はビン幅(11.7Hz)の半分を目安にする。放物線補間がそこまで詰める
      expect(Math.abs(got - want), `${want}Hz に対して ${got.toFixed(1)}Hz`).toBeLessThan(8);
      expect(bandOf(got)).toBe(bandOf(want));
    });
  }
});

describe('ハウリング検出 — 鳴いていないものを指さない', () => {
  for (const c of NEGATIVE) {
    it(c.name, () => {
      const r = run(c.build());
      expect(
        r.everRinging,
        `空振り: ${r.detected.map((f) => f.toFixed(0)).join(', ')}Hz`,
      ).toBe(false);
    });
  }
});

describe('ハウリング検出 — 適合率と再現率', () => {
  it('適合率は 1.0（空振りが1件も無い）', () => {
    const all = [...POSITIVE, ...NEGATIVE];
    let tp = 0, fp = 0, fn = 0;
    const misses: string[] = [];
    const falseAlarms: string[] = [];

    for (const c of all) {
      const r = run(c.build());
      if (c.ring && r.everRinging) tp++;
      else if (c.ring) { fn++; misses.push(c.name); }
      else if (r.everRinging) { fp++; falseAlarms.push(c.name); }
    }

    const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 1 : tp / (tp + fn);

    // 空振りは見落としより重い。適合率は落とせない
    expect(precision, `空振り: ${falseAlarms.join(' / ')}`).toBe(1);
    // 見落としも、この検証セットの範囲では出ないはず
    expect(recall, `見落とし: ${misses.join(' / ')}`).toBe(1);
  });
});

describe('ハウリング検出 — 空振りへの余裕', () => {
  // 閾値が「たまたまこの乱数系列で通っただけ」でないことを確かめる。
  // 空振りは見落としより重いと決めた以上、ここが一番効く検証になる
  it('ピンクノイズを12通りの系列で流しても一度も指さない', () => {
    const fired: number[] = [];
    for (let seed = 100; seed < 112; seed++) {
      if (run(pinkNoise(N, 0.05, seed)).everRinging) fired.push(seed);
    }
    expect(fired, `空振りした系列: ${fired.join(', ')}`).toEqual([]);
  });

  it('白色ノイズを12通りの系列で流しても一度も指さない', () => {
    const fired: number[] = [];
    for (let seed = 200; seed < 212; seed++) {
      if (run(whiteNoise(N, 0.05, seed)).everRinging) fired.push(seed);
    }
    expect(fired, `空振りした系列: ${fired.join(', ')}`).toEqual([]);
  });

  it('ノイズだけのときの突出度は閾値に対して余裕がある', () => {
    // 閾値ぎりぎりで通っているなら、現場の少しの違いで空振りが出る
    let worst = 0;
    for (let seed = 300; seed < 306; seed++) {
      const r = run(pinkNoise(N, 0.05, seed));
      worst = Math.max(worst, ...r.maxBandProminence);
    }
    expect(worst, `ノイズだけで最大 ${worst.toFixed(1)}dB`).toBeLessThan(PROMINENCE_DB - 3);
  });

  it('基音を変えた歌声をどれも発振と呼ばない', () => {
    const fired: number[] = [];
    for (const f0 of [110, 147, 165, 196, 220, 262, 294, 349, 392]) {
      const d = addHarmonicStack(pinkNoise(N, 0.03, 400 + f0), SR, f0, 0.12, 16, {
        startSec: 0.3, durationSec: 2.4, vibratoHz: 5, vibratoCents: 20,
      });
      if (run(d).everRinging) fired.push(f0);
    }
    expect(fired, `空振りした基音: ${fired.join(', ')}Hz`).toEqual([]);
  });
});

// ==========================================================================
// 実音声（fixtures/corpus/ があるときだけ効く）
// ==========================================================================

/**
 * 合成の陰性セットは倍音の強さが規則正しすぎる。**本物の声でこそ空振りする。**
 *
 * ここに並ぶ4本は、実際に「発振中」と誤って言われた本人である（189〜314Hz、
 * すべて250Hz帯）。持続判定が ±1ビン だけを見ていたころ、11.7Hz のビン幅は
 * 210Hz に対して ±5.6% ＝ ほぼ半音ぶんの猶予になっていて、声の基音の揺れが
 * そのまま「同じ鳴きが続いている」と読まれていた。
 *
 * slt は米女性話者。基音が 250Hz帯 に入るので最も危ない。bdl / awb は男性で、
 * 基音は検出範囲の下——こちらは倍音のほうが候補になるので経路が違う。
 */
const CORPUS_NEGATIVE = [
  'cmu-arctic-files-slt-0003.wav',
  'cmu-arctic-files-slt-0007.wav',
  'cmu-arctic-files-slt-0011.wav',
  'cmu-arctic-files-slt-0014.wav',
  'cmu-arctic-files-bdl-0001.wav',
  'cmu-arctic-files-awb-0001.wav',
];

/** 実音声を会場の暗騒音の上に置く。素材が無ければ null */
async function hallMix(name: string, seed: number, speechRms = 0.06): Promise<Float32Array | null> {
  const speech = await loadCorpusFile(name, SR);
  if (speech === null) return null;
  return mix(atRms(speech, speechRms), pinkNoise(speech.length, 0.02, seed));
}

describe('ハウリング検出 — 実音声を発振と呼ばない', () => {
  for (const [i, name] of CORPUS_NEGATIVE.entries()) {
    it(`${name} を発振と呼ばない`, async () => {
      const d = await hallMix(name, 900 + i);
      if (d === null) {
        console.log(`[skip] ${name} は無い（npm run fetch-corpus で取得できる）`);
        return;
      }
      const r = run(d);
      expect(
        r.everRinging,
        `空振り: ${r.detected.map((f) => f.toFixed(0)).join(', ')}Hz`,
      ).toBe(false);
    });
  }

  // 実音声で締めた結果、本物まで落ちていないことを同じ素材で確かめる。
  // 陰性だけ足すと「常に黙る」実装がテストを通ってしまう
  for (const freq of [250, 3200]) {
    it(`実音声の上に載せた ${freq}Hz の発振は捕まえる`, async () => {
      let tried = 0;
      for (const [i, name] of CORPUS_NEGATIVE.entries()) {
        const d = await hallMix(name, 950 + i);
        if (d === null) continue;
        tried++;
        addTone(d, SR, freq, 0.12, { startSec: 1.0 });
        const r = run(d);
        expect(r.everRinging, `${name} で見落とし`).toBe(true);
        expect(Math.abs(r.detected[0] - freq), `${name}: ${r.detected[0].toFixed(1)}Hz`)
          .toBeLessThan(8);
      }
      if (tried === 0) console.log('[skip] fixtures/corpus/ が無い');
    });
  }
});

describe('ハウリング検出 — 履歴', () => {
  it('鳴き終わると履歴に残り、経過秒が進む', () => {
    const d = addTone(pinkNoise(SR * 4, 0.03, 30), SR, 3200, 0.12, {
      startSec: 0.5, durationSec: 0.8,
    });
    const { detector } = run(d);
    const s = detector.state;

    expect(s.ringing).toBe(false);
    expect(s.events.length).toBe(1);
    expect(Math.abs(s.events[0].freqHz - 3200)).toBeLessThan(8);
    expect(s.events[0].bandHz).toBe(4000);
    expect(s.events[0].count).toBe(1);
    expect(s.events[0].totalSeconds).toBeGreaterThan(0.4);
    // 鳴き終わりは約1.3秒、全体は4秒なので2秒以上前
    expect(s.events[0].agoSeconds).toBeGreaterThan(2);
  });

  it('同じ周波数で繰り返し鳴いたら1行にまとめて回数で持つ', () => {
    // まとめないと、繰り返し鳴いているという「この道具を開いた理由」そのものが
    // 同じ行の重複で画面を埋めてしまう
    const d = pinkNoise(SR * 6, 0.03, 31);
    addTone(d, SR, 3200, 0.12, { startSec: 0.5, durationSec: 0.6 });
    addTone(d, SR, 3200, 0.12, { startSec: 2.0, durationSec: 0.6 });
    addTone(d, SR, 3200, 0.12, { startSec: 3.5, durationSec: 0.6 });

    const s = run(d).detector.state;
    expect(s.events.length).toBe(1);
    expect(s.events[0].count).toBe(3);
    expect(s.events[0].totalSeconds).toBeGreaterThan(1.2);
  });

  it('別の周波数は別の行になり、新しい順に並ぶ', () => {
    const d = pinkNoise(SR * 6, 0.03, 32);
    addTone(d, SR, 3200, 0.12, { startSec: 0.5, durationSec: 0.6 });
    addTone(d, SR, 5000, 0.12, { startSec: 2.5, durationSec: 0.6 });

    const s = run(d).detector.state;
    expect(s.events.length).toBe(2);
    expect(s.events[0].bandHz).toBe(4000); // 5kHz は 4k帯(2828〜5657Hz)
    expect(Math.abs(s.events[0].freqHz - 5000)).toBeLessThan(8);
    expect(Math.abs(s.events[1].freqHz - 3200)).toBeLessThan(8);
  });

  it(`履歴は ${MAX_EVENTS} 件で打ち切る`, () => {
    const d = pinkNoise(SR * 10, 0.03, 33);
    const freqs = [800, 1600, 3200, 6400];
    freqs.forEach((f, i) => addTone(d, SR, f, 0.12, { startSec: 0.5 + i * 2, durationSec: 0.6 }));

    const s = run(d).detector.state;
    expect(s.events.length).toBe(MAX_EVENTS);
    // 最も古い 800Hz が落ちている
    expect(s.events.map((e) => Math.round(e.freqHz / 100) * 100)).not.toContain(800);
  });
});

describe('ハウリング検出 — 入力の飽和', () => {
  it('マイクが飽和したら申告する', () => {
    // 大きなハウリングでは端末のマイクが飽和する。飽和すると広帯域の歪みが
    // 周辺の中央値を持ち上げ、突出度の分母が上がって検出しにくくなる——
    // つまり鳴きが大きいほど黙る。それが唯一の「静かに間違える」経路なので、
    // 黙る代わりに申告する
    const d = clipHard(addTone(pinkNoise(N, 0.05, 40), SR, 3200, 1.6, { startSec: 0.4 }));
    expect(run(d).clipping).toBe(true);
  });

  it('飽和していなければ申告しない', () => {
    const d = addTone(pinkNoise(N, 0.03, 41), SR, 3200, 0.12, { startSec: 0.4 });
    expect(run(d).clipping).toBe(false);
  });
});

describe('ハウリング検出 — 骨組み', () => {
  it('チャンクの区切り方によらず同じ結果になる', () => {
    const build = (): Float32Array =>
      addTone(pinkNoise(N, 0.03, 50), SR, 3200, 0.12, { startSec: 0.4 });

    const feed = (size: number): number => {
      const det = new HowlingDetector(SR);
      const s = build();
      for (let off = 0; off < s.length; off += size) {
        det.push(s.subarray(off, Math.min(off + size, s.length)));
      }
      return det.state.events[0]?.freqHz ?? det.state.freqHz ?? 0;
    };

    // ワークレットは4096固定だが、区切りに依存する実装だと
    // サンプルレートが変わった瞬間に壊れる
    expect(Math.abs(feed(4096) - feed(1000))).toBeLessThan(2);
  });

  it('44.1kHz でも同じ周波数を指す', () => {
    const sr = 44100;
    const d = addTone(pinkNoise(sr * SECONDS, 0.03, 51), sr, 3200, 0.12, { startSec: 0.4 });
    const r = run(d, sr);
    expect(r.everRinging).toBe(true);
    expect(Math.abs(r.detected[0] - 3200)).toBeLessThan(8);
  });

  it('立ち上がりから判定までが 0.5秒 を超えない', () => {
    // 見ながら操作する道具なのでレイテンシが製品価値そのもの
    const d = addTone(pinkNoise(SR * 3, 0.03, 52), SR, 3200, 0.12, {
      startSec: 1.0, rampSec: 0.01,
    });
    const det = new HowlingDetector(SR);
    let firstRingingFrame = -1;
    for (let off = 0; off < d.length; off += CHUNK) {
      if (!det.push(d.subarray(off, Math.min(off + CHUNK, d.length)))) continue;
      const s = det.state;
      if (s.ringing && firstRingingFrame < 0) firstRingingFrame = s.frames;
    }
    expect(firstRingingFrame).toBeGreaterThan(0);
    const detectedAtSec = (firstRingingFrame * FRAME_MS) / 1000;
    expect(detectedAtSec - 1.0).toBeLessThanOrEqual(0.5);
  });

  it('0.3秒の鳴きは、開始位置がフレーム格子のどこでも捕まる', () => {
    // 3フレーム連続を要求するが、窓(85ms)がホップ(100ms)より短いので重なりが無く、
    // 実際には約285〜385msの連続が要る。**捕まえられる下限は 250ms ではなく 300ms**
    // であり、その境界が開始位置のずれで揺れないことをここで固定する
    for (let k = 0; k < 5; k++) {
      const start = 1.0 + k * 0.02;
      const d = addTone(pinkNoise(SR * 3, 0.03, 900 + k), SR, 3200, 0.12, {
        startSec: start, durationSec: 0.3, rampSec: 0.01,
      });
      expect(run(d).everRinging, `開始 ${start.toFixed(2)}秒 で見落とし`).toBe(true);
    }
  });
});

describe('ハウリング検出 — 発振とバンド名は必ず一致する', () => {
  // 「発振中」なのにバンド名が無い、が起きると、画面は赤くなるのに文字は
  // 「聞いています」のままになる。この道具が最も避けたい自己矛盾そのもの
  const EDGES = BANDS_HZ.flatMap((c) => {
    const lo = c * Math.SQRT1_2, hi = c * Math.SQRT2;
    return [lo * 1.02, c, hi * 0.999];
  });

  for (const f of EDGES) {
    it(`${f.toFixed(1)}Hz — 鳴いたならバンド名も周波数もそのバンドに収まる`, () => {
      const r = run(addTone(bed(700 + Math.round(f)), SR, f, 0.12, { startSec: 0.4 }));
      const s = r.detector.state;
      const seen = [...r.detected, ...(s.freqHz === null ? [] : [s.freqHz])];
      for (const got of seen) {
        const band = bandOf(got);
        expect(band, `${got.toFixed(2)}Hz がどのバンドにも属さない`).not.toBeNull();
        expect(got).toBeGreaterThanOrEqual(band! * Math.SQRT1_2);
        expect(got).toBeLessThan(band! * Math.SQRT2);
      }
      for (const e of s.events) expect(bandOf(e.freqHz)).toBe(e.bandHz);
    });
  }

  it('最上位ビンで補間が外へはみ出しても、バンド名が消えない', () => {
    // 48kHz・FFT4096 では最上位ビン(965)が 11308.6Hz。補間が +0.44ビン以上
    // 動くと 8kHz帯の上端 11313.7Hz を超え、bandOf が null を返していた
    const r = run(addTone(bed(777), SR, 11314, 0.12, { startSec: 0.4 }));
    expect(r.everRinging, '最上位ビン付近の発振が検出されること').toBe(true);
    for (const f of r.detected) expect(bandOf(f)).toBe(8000);
    expect(r.detector.state.events.every((e) => e.bandHz === 8000)).toBe(true);
  });
});

describe('ハウリング検出 — 中断時の確定', () => {
  it('finish() は鳴っている最中の発振を履歴へ確定させる', () => {
    // 画面が消えた瞬間に鳴っていた1件が落ちると、記録を残す動機そのものが
    // 果たされない
    const d = addTone(pinkNoise(SR * 2, 0.03, 800), SR, 3200, 0.12, { startSec: 0.5 });
    const { detector } = run(d);

    expect(detector.state.ringing).toBe(true);
    expect(detector.state.events.length).toBe(0);

    const final = detector.finish();
    expect(final.ringing).toBe(false);
    expect(final.events.length).toBe(1);
    expect(Math.abs(final.events[0].freqHz - 3200)).toBeLessThan(8);
    expect(final.events[0].totalSeconds).toBeGreaterThan(0.5);
  });

  it('鳴っていなければ finish() は何も足さない', () => {
    const { detector } = run(bed(801));
    expect(detector.finish().events).toEqual([]);
  });
});

describe('ハウリング検出 — バンドと表示', () => {
  it('測れないバンドの箱だけを並べない', () => {
    // 突出度は上下両側の中央値と比べて初めて意味を持つ。48kHz・FFT4096 では
    // 125Hz はビン10.7本目で、ガードを引くと下側に1本も残らない
    expect(BANDS_HZ).not.toContain(63);
    expect(BANDS_HZ).not.toContain(125);
    expect(BANDS_HZ[0]).toBe(250);
  });

  it('下側のビンが足りない周波数は突出度を返さない（測れないと言う）', () => {
    // 125Hz帯を載せていたとき、基音110Hzの歌声を「110Hzで発振中」と誤検出した。
    // 片側だけの中央値は、スペクトルの傾きを突出度に化けさせる
    const d = addHarmonicStack(pinkNoise(N, 0.03, 510), SR, 110, 0.12, 16, {
      startSec: 0.3, durationSec: 2.4, vibratoHz: 5, vibratoCents: 20,
    });
    expect(run(d).everRinging).toBe(false);
  });

  it('オクターブの境界で隣のバンドに移る', () => {
    expect(bandOf(3200)).toBe(4000);
    expect(bandOf(2000)).toBe(2000);
    expect(bandOf(2829)).toBe(4000); // 2000 * √2 = 2828.4
    expect(bandOf(2827)).toBe(2000);
    expect(bandOf(60)).toBeNull();
    expect(bandOf(110)).toBeNull(); // 125Hz帯は載せていない
    expect(bandOf(20000)).toBeNull();
  });

  it('固定バンドのグライコにも数値EQにも渡せる表記になる', () => {
    expect(formatOctaveBand(4000)).toBe('4k');
    expect(formatOctaveBand(250)).toBe('250');
    expect(formatOctaveBand(8000)).toBe('8k');
    expect(formatFrequency(3204.2)).toBe('3.20 kHz');
    expect(formatFrequency(221.6)).toBe('222 Hz');
  });

  it('発振している帯域の突出度が閾値を超える', () => {
    const r = run(addTone(bed(60), SR, 3200, 0.12, { startSec: 0.4 }));
    const idx = BANDS_HZ.indexOf(4000);
    expect(r.maxBandProminence[idx]).toBeGreaterThanOrEqual(PROMINENCE_DB);
  });
});
