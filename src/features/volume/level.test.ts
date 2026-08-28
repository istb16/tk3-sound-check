import { describe, expect, it } from 'vitest';
import {
  VolumeMeter, barRatio,
  FLOOR_DB, FRAME_MS, LEQ_WINDOW_SEC, CLIP_WINDOW_SEC, NEAR_CLIP_WARN_SEC, STEP_DB,
} from './level.ts';
import { pinkNoise, silence, sine } from '../../test-support/signals.ts';

const SR = 48000;

describe('VolumeMeter — フレーム化', () => {
  it('1フレーム分たまるまで更新しない', () => {
    const meter = new VolumeMeter(SR);
    const frameSize = (SR * FRAME_MS) / 1000;

    expect(meter.push(sine(1000, 0.05, 0.5))).toBe(false);
    expect(meter.state.frames).toBe(0);

    expect(meter.push(new Float32Array(frameSize / 2))).toBe(true);
    expect(meter.state.frames).toBe(1);
  });

  it('チャンク境界がフレーム境界と揃っていなくても数が合う', () => {
    const meter = new VolumeMeter(SR);
    const total = sine(1000, 1, 0.5);
    for (let i = 0; i < total.length; i += 1000) {
      meter.push(total.subarray(i, Math.min(i + 1000, total.length)));
    }
    expect(meter.state.frames).toBe(1000 / FRAME_MS);
  });

  it('無音では下限を返す（-Infinity を画面に出さない）', () => {
    const meter = new VolumeMeter(SR);
    meter.push(silence(0.5));
    expect(meter.state.instantDb).toBe(FLOOR_DB);
    expect(meter.state.leqDb).toBe(FLOOR_DB);
  });
});

describe('VolumeMeter — レベル', () => {
  it('1kHz 正弦波の Leq が実効値と一致する（A特性の利得0の周波数）', () => {
    const meter = new VolumeMeter(SR);
    const input = sine(1000, 2, 0.5);
    meter.push(input);
    // 振幅0.5の正弦波の実効値は 0.3536 → -9.03dBFS
    expect(meter.state.leqDb).toBeCloseTo(-9.03, 1);
  });

  it('Leq はdBの平均ではなくパワーの平均（大きいほうに引かれる）', () => {
    const meter = new VolumeMeter(SR);
    meter.push(sine(1000, LEQ_WINDOW_SEC / 2, 0.5));   // -9.03dB
    meter.push(sine(1000, LEQ_WINDOW_SEC / 2, 0.05));  // -29.0dB

    const leq = meter.state.leqDb;
    // dBの単純平均なら -19dB 付近になるが、パワー平均では -12dB 付近に寄る
    expect(leq).toBeGreaterThan(-13);
    expect(leq).toBeLessThan(-11);
  });

  it('窓が埋まるまで leqReady は false', () => {
    const meter = new VolumeMeter(SR);
    meter.push(sine(1000, LEQ_WINDOW_SEC - 1, 0.5));
    expect(meter.state.leqReady).toBe(false);

    meter.push(sine(1000, 1, 0.5));
    expect(meter.state.leqReady).toBe(true);
  });

});

describe('VolumeMeter — ピークホールド', () => {
  it('RMSではなくサンプルピークを返す', () => {
    // 振幅0.5の正弦波: ピークは -6.02dBFS、実効値は -9.03dBFS。
    // 「RMSでは見えない波高を示す」ためにあるので、RMSを返していては役に立たない
    const meter = new VolumeMeter(SR);
    meter.push(sine(1000, 0.5, 0.5));
    expect(meter.state.peakHoldDb).toBeCloseTo(-6.02, 1);
  });

  it('A特性で落ちる低域でも入力段の振幅を示す', () => {
    // 60Hz はA特性で約27dB落ちる。重み付け後のRMSで見ていると、入力段が
    // 振り切っている波形が -30dBFS と表示されて、頭が空いているように読める
    const meter = new VolumeMeter(SR);
    meter.push(sine(60, 0.5, 0.999));
    expect(meter.state.peakHoldDb).toBeGreaterThan(-0.2);
  });

  it('直近1秒だけを保持する', () => {
    const meter = new VolumeMeter(SR);
    meter.push(sine(1000, 0.2, 0.5));
    const afterLoud = meter.state.peakHoldDb;

    meter.push(sine(1000, 0.5, 0.01));
    // まだ1秒たっていないので大きいほうを保持している
    expect(meter.state.peakHoldDb).toBeCloseTo(afterLoud, 5);

    meter.push(sine(1000, 1.0, 0.01));
    expect(meter.state.peakHoldDb).toBeCloseTo(-40, 1);
  });
});

describe('VolumeMeter — 重み付け無し(Z特性)のLeq', () => {
  it('全帯域が一律に動いたときはA特性の差と一致する', () => {
    const before = new VolumeMeter(SR);
    before.push(pinkNoise(SR * LEQ_WINDOW_SEC, 0.05, 7));
    const after = new VolumeMeter(SR);
    const loud = pinkNoise(SR * LEQ_WINDOW_SEC, 0.05, 7);
    for (let i = 0; i < loud.length; i++) loud[i] *= 2; // +6.02dB

    after.push(loud);
    const diffA = after.state.leqDb  - before.state.leqDb;
    const diffZ = after.state.leqZDb - before.state.leqZDb;
    expect(diffA).toBeCloseTo(6.02, 1);
    expect(diffZ).toBeCloseTo(6.02, 1);
  });

  it('低域だけを動かすと差が食い違う（A特性は小さく見せる）', () => {
    // 「同じ端末・同じ場所なら差は正しい」が成り立つのは全帯域が一律に
    // 動いたときだけである。サブのフェーダーを上げた形を作って確かめる
    const base = pinkNoise(SR * LEQ_WINDOW_SEC, 0.05, 11);
    const boosted = Float32Array.from(base);
    // 60Hz の成分だけを足す。A特性では約27dB落ちるが、入力には確かに入っている
    const tone = sine(60, LEQ_WINDOW_SEC, 0.05, SR);
    for (let i = 0; i < boosted.length; i++) boosted[i] += tone[i];

    const before = new VolumeMeter(SR); before.push(base);
    const after  = new VolumeMeter(SR); after.push(boosted);
    const diffA = after.state.leqDb  - before.state.leqDb;
    const diffZ = after.state.leqZDb - before.state.leqZDb;

    expect(diffZ).toBeGreaterThan(diffA + 1);
  });
});

describe('VolumeMeter — 音割れ', () => {
  /** 前後を無音で挟んだクリップの塊を1つ作る */
  function burst(clipSamples: number): Float32Array {
    const out = new Float32Array(clipSamples + 200);
    for (let i = 0; i < clipSamples; i++) out[100 + i] = 0.99;
    return out;
  }

  /** amplitude 倍に振り切らせた正弦波（実機の過大入力に近い形） */
  function overdriven(freqHz: number, seconds: number, drive: number): Float32Array {
    const raw = sine(freqHz, seconds, drive);
    const out = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = Math.max(-1, Math.min(1, raw[i]));
    return out;
  }

  it('単発のクリップは1フレーム分の時間として出る', () => {
    const meter = new VolumeMeter(SR);
    meter.push(burst(50));
    meter.push(silence(0.5));
    expect(meter.state.clipSeconds).toBeCloseTo(FRAME_MS / 1000, 6);
  });

  it('割れっぱなしなら窓いっぱいの時間になる', () => {
    // 「回数」で数えると、クリップした波形は半周期ごとに閾値を下回るため
    // 1kHz を3dB突っ込んだだけで10秒間に20000回になってしまう。
    // 時間で持てば「10秒のうち10秒」と素直に出る。
    const meter = new VolumeMeter(SR);
    meter.push(overdriven(1000, CLIP_WINDOW_SEC, 1.41));
    expect(meter.state.clipSeconds).toBeCloseTo(CLIP_WINDOW_SEC, 1);
  });

  it('割れている時間が長いほど大きい値になる', () => {
    const light = new VolumeMeter(SR);
    light.push(overdriven(1000, 1, 1.41));
    light.push(silence(4));

    const heavy = new VolumeMeter(SR);
    heavy.push(overdriven(1000, 5, 1.41));

    expect(heavy.state.clipSeconds).toBeGreaterThan(light.state.clipSeconds);
    expect(light.state.clipSeconds).toBeCloseTo(1, 1);
    expect(heavy.state.clipSeconds).toBeCloseTo(5, 1);
  });

  it('チャンクをまたいだクリップを二重に数えない', () => {
    const meter = new VolumeMeter(SR);
    const frameSize = (SR * FRAME_MS) / 1000;
    const half = new Float32Array(frameSize / 2).fill(0.99);
    meter.push(half);
    meter.push(half);
    meter.push(silence(0.5));
    expect(meter.state.clipSeconds).toBeCloseTo(FRAME_MS / 1000, 6);
  });

  it('窓を過ぎると自動的に消える（直したことが伝わる）', () => {
    const meter = new VolumeMeter(SR);
    meter.push(burst(50));
    meter.push(silence(1));
    expect(meter.state.clipSeconds).toBeGreaterThan(0);

    meter.push(silence(CLIP_WINDOW_SEC));
    expect(meter.state.clipSeconds).toBe(0);
  });

  it('割れる手前の「限界に近い」を別に数える', () => {
    // -3dBFS を超えるが 0.98 には届かない。飽和で差が縮み始める領域で、
    // clipSeconds は 0 のままなので、これが無いと警告が何も出ない
    const meter = new VolumeMeter(SR);
    meter.push(sine(1000, 5, 0.9));
    expect(meter.state.clipSeconds).toBe(0);
    expect(meter.state.nearClipSeconds).toBeCloseTo(5, 1);
    expect(meter.state.nearClipSeconds).toBeGreaterThanOrEqual(NEAR_CLIP_WARN_SEC);
  });

  it('十分に低いレベルでは限界に近いと言わない', () => {
    const meter = new VolumeMeter(SR);
    meter.push(sine(1000, 5, 0.3));
    expect(meter.state.nearClipSeconds).toBe(0);
  });

  it('A特性の重み付け前の値でクリップを見る', () => {
    // 60Hz はA特性で約27dB落ちる（-30dB になるのは50Hz）が、入力段では割れている。
    // 重み付け後の波形で判定していたら見逃す。
    const meter = new VolumeMeter(SR);
    meter.push(sine(60, 0.3, 1.0));
    expect(meter.state.clipSeconds).toBeGreaterThan(0);
  });
});

describe('VolumeMeter — 窓が埋まるまで', () => {
  it('残り時間が減っていき、埋まるとゼロになる', () => {
    const meter = new VolumeMeter(SR);
    expect(meter.state.warmupRemainingSec).toBe(LEQ_WINDOW_SEC);

    meter.push(sine(1000, 4, 0.5));
    expect(meter.state.warmupRemainingSec).toBeCloseTo(LEQ_WINDOW_SEC - 4, 5);

    meter.push(sine(1000, LEQ_WINDOW_SEC, 0.5));
    expect(meter.state.warmupRemainingSec).toBe(0);
    expect(meter.state.leqReady).toBe(true);
  });
});

describe('VolumeMeter — 収束（フェーダーを動かした直後）', () => {
  /** 定常のピンクノイズを seconds 秒ぶん、gain 倍で流す */
  function feed(meter: VolumeMeter, seconds: number, gain: number, seed: number): void {
    const sig = pinkNoise(Math.round(SR * seconds), 0.05, seed);
    if (gain !== 1) for (let i = 0; i < sig.length; i++) sig[i] *= gain;
    meter.push(sig);
  }

  it('レベルが変わっていなければ収束済みとして扱う', () => {
    const meter = new VolumeMeter(SR);
    feed(meter, LEQ_WINDOW_SEC + 5, 1, 3);
    expect(meter.state.stepDb).toBe(0);
    expect(meter.state.settlingRemainingSec).toBe(0);
  });

  it('2回続けて動かしても残り秒数は巻き戻らない', () => {
    // 「最も margin の大きい段差」を選んでいた頃は、古くて大きいほうが勝つので
    // カウントダウンが 0.2秒 まで進んだ直後に 3.1秒 へ跳ね上がっていた。
    // 操作の可否をカウントダウンで見て決める相手に、操作していないのに増える
    // 数字は渡せない。増えてよいのは新しい操作をした瞬間だけである。
    const meter = new VolumeMeter(SR);
    feed(meter, LEQ_WINDOW_SEC, 1, 3);        // 窓を埋める
    feed(meter, 3, 2, 4);                     // +6.02dB
    feed(meter, 0.1, 1.585, 5);               // 3秒後に -2dB（ここだけ増えてよい）

    // 2回目の操作は、新しい側が 0.2秒 に満たない間は位置を決められない
    // （分割点は窓の両端に置けない）。検出できるようになるまで待ってから見る
    for (let i = 0; i < 5; i++) feed(meter, 0.1, 1.585, 50 + i);

    let prev = meter.state.settlingRemainingSec;
    for (let i = 0; i < 120; i++) {           // 以後12秒、0.1秒ずつ進める
      feed(meter, 0.1, 1.585, 100 + i);
      const now = meter.state.settlingRemainingSec;
      // 1フレーム(0.1秒)の揺れは素材のばらつきで分割点が隣に動くもの。
      // 直したのは 0.2秒 → 3.1秒 のような、操作していないのに数秒戻る動きである
      expect(now, `${i / 10}秒後に ${prev} から ${now} へ巻き戻った`)
        .toBeLessThanOrEqual(prev + FRAME_MS / 1000 + 1e-9);
      prev = now;
    }
    expect(prev).toBe(0);                     // 最後は収束している
  });

  it('3dB の山なら、上げて戻す操作でも収束前に確定した顔にしない', () => {
    // 上げてから戻すと窓は3レベルの混合になり、山が中ほどにある間は
    // どの単一分割でも前後がどちらも混合になる。宣言した分解能(1.5dB)と
    // 同じ大きさの山は捕まえられないが、3dB あれば捕まえられる——
    // ここが「捕まえられる」と言える下限なので固定する。
    const meter = new VolumeMeter(SR);
    feed(meter, LEQ_WINDOW_SEC, 1, 3);
    feed(meter, 5, 1.413, 4);                 // +3.0dB を5秒
    feed(meter, 1, 1, 5);                     // 元に戻す

    // 山が窓から完全に出るまで（残り9秒）ずっと「収束中」であること
    for (let i = 0; i < 85; i++) {
      expect(meter.state.settlingRemainingSec, `${i / 10}秒後に収束済みと答えた`)
        .toBeGreaterThan(0);
      feed(meter, 0.1, 1, 200 + i);
    }
  });

  it('段差の大きさと、確定までの残り秒数を返す', () => {
    const meter = new VolumeMeter(SR);
    feed(meter, LEQ_WINDOW_SEC, 1, 3);        // 窓を埋める
    feed(meter, 3, 2, 4);                     // +6.02dB にして3秒

    const s = meter.state;
    expect(s.stepDb).toBeCloseTo(6.02, 0);
    // 窓10秒のうち7秒がまだ操作前。それが出ていくまで数値は動き続ける
    expect(s.settlingRemainingSec).toBeCloseTo(7, 1);
  });

  it('表示される差は、収束するまで真の変化より小さい', () => {
    const meter = new VolumeMeter(SR);
    feed(meter, LEQ_WINDOW_SEC, 1, 3);
    const reference = meter.state.leqDb;

    feed(meter, 5, 2, 4);
    // 移動窓の必然。10log10((5+4*5)/10) = 3.98dB —— 真値 6.02dB ではない
    expect(meter.state.leqDb - reference).toBeCloseTo(3.98, 0);
    expect(meter.state.settlingRemainingSec).toBeGreaterThan(0);

    feed(meter, 5, 2, 5);
    expect(meter.state.leqDb - reference).toBeCloseTo(6.02, 0);
    expect(meter.state.settlingRemainingSec).toBe(0);
  });

  it('小さな段差でも操作の0.5秒後には収束中になる', () => {
    // ここが遅れると、操作直後のいちばん危険な数百ミリ秒のあいだ、確定色つきの
    // 小さすぎる数値（+2dB 動かして +0.2dB）がそのまま読まれる
    const base = pinkNoise(Math.round(SR * (LEQ_WINDOW_SEC + 1)), 0.05, 31);
    const meter = new VolumeMeter(SR);
    meter.push(base.subarray(0, SR * LEQ_WINDOW_SEC));

    const g = Math.pow(10, 2 / 20); // +2dB
    const after = base.slice(SR * LEQ_WINDOW_SEC, Math.round(SR * (LEQ_WINDOW_SEC + 0.5)));
    for (let i = 0; i < after.length; i++) after[i] *= g;
    meter.push(after);

    expect(meter.state.settlingRemainingSec).toBeGreaterThan(0);
  });

  it('残り秒数は操作の直後から動く（止まって見えない）', () => {
    // 分割点が探索範囲の端に張り付くと、カウントダウンが数秒間固まる。
    // 主役の位置で動かない数字は「壊れた」と読まれる
    const base = pinkNoise(Math.round(SR * (LEQ_WINDOW_SEC + 6)), 0.05, 32);
    const meter = new VolumeMeter(SR);
    meter.push(base.subarray(0, SR * LEQ_WINDOW_SEC));

    const g = 2; // +6.02dB
    const after = base.slice(SR * LEQ_WINDOW_SEC);
    for (let i = 0; i < after.length; i++) after[i] *= g;

    const at = (sec: number): number => {
      const from = Math.round(SR * sec);
      meter.push(after.subarray(from - Math.round(SR * 0.5), from));
      return meter.state.settlingRemainingSec;
    };
    const half = at(0.5), two = at(2), five = at(5);

    expect(half).toBeGreaterThan(9);   // 窓のほぼ全部がまだ操作前
    expect(two).toBeLessThan(half);
    expect(five).toBeLessThan(two);
  });

  it('窓が埋まる前は段差を言わない（全体が収束前なので）', () => {
    const meter = new VolumeMeter(SR);
    feed(meter, 3, 1, 3);
    feed(meter, 3, 4, 4);
    expect(meter.state.leqReady).toBe(false);
    expect(meter.state.settlingRemainingSec).toBe(0);
  });
});

describe('VolumeMeter — 基準の測定', () => {
  it('押した時点から先の10秒で測る（遡らない）', () => {
    // 開始してから客席へ歩き、着席直後に基準を取る形。遡って測ると歩行中の音が
    // 基準の半分を占め、**フェーダーに触れていないのに差が出続ける**——しかも
    // 窓が入れ替わったあとは収束中の断りも消えるので、確定した数値の顔で出る
    const material = pinkNoise(SR * 30, 0.05, 41);
    const sig = Float32Array.from(material);
    for (let i = 0; i < SR * 5; i++) sig[i] *= 0.5; // 最初の5秒だけ -6dB（歩行中）

    const meter = new VolumeMeter(SR);
    meter.push(sig.subarray(0, SR * LEQ_WINDOW_SEC)); // 窓の半分が歩行中の音
    expect(meter.state.leqReady).toBe(true);
    const backward = meter.state.leqDb; // 遡る10秒＝旧実装が基準にしていた値

    meter.beginReference();
    meter.push(sig.subarray(SR * LEQ_WINDOW_SEC, SR * (LEQ_WINDOW_SEC * 2)));
    const ref = meter.state.referenceDb;
    expect(ref).not.toBeNull();

    // 遡る窓は歩行中の音に引かれて2dB近く低い。そこを基準にすると、その差が
    // そのまま「フェーダーを上げた」に見える
    expect(ref! - backward).toBeGreaterThan(1.5);

    // 以後レベルは変わらない。触っていないのだから差はゼロであるべき
    meter.push(sig.subarray(SR * (LEQ_WINDOW_SEC * 2), SR * (LEQ_WINDOW_SEC * 3)));
    expect(meter.state.leqDb - ref!).toBeCloseTo(0, 0);
  });

  it('測っている間は残り秒数を返し、揃うまで基準を出さない', () => {
    const meter = new VolumeMeter(SR);
    meter.beginReference();
    expect(meter.state.referenceCapturing).toBe(true);
    expect(meter.state.referenceRemainingSec).toBe(LEQ_WINDOW_SEC);

    meter.push(pinkNoise(SR * 4, 0.05, 42));
    expect(meter.state.referenceDb).toBeNull();
    expect(meter.state.referenceRemainingSec).toBeCloseTo(LEQ_WINDOW_SEC - 4, 5);

    meter.push(pinkNoise(SR * (LEQ_WINDOW_SEC - 4), 0.05, 43));
    expect(meter.state.referenceCapturing).toBe(false);
    expect(meter.state.referenceRemainingSec).toBe(0);
    expect(meter.state.referenceDb).not.toBeNull();
  });

  it('測っている間にレベルが変わったら申告する', () => {
    // 遡らないだけでは足りない。測定中に変われば同じ混合が起きるが、窓が
    // 入れ替われば収束中の断りは消えるので、確定した数値の顔で出てしまう
    const material = pinkNoise(SR * LEQ_WINDOW_SEC, 0.05, 46);
    const sig = Float32Array.from(material);
    for (let i = SR * 3; i < sig.length; i++) sig[i] *= 2; // 押した3秒後に +6.02dB

    const meter = new VolumeMeter(SR);
    meter.beginReference();
    meter.push(sig);

    expect(meter.state.referenceDb).not.toBeNull();
    expect(Math.abs(meter.state.referenceStepDb)).toBeGreaterThan(STEP_DB);
  });

  it('レベルが変わらなければ申告しない', () => {
    const meter = new VolumeMeter(SR);
    meter.beginReference();
    meter.push(pinkNoise(SR * LEQ_WINDOW_SEC, 0.05, 47));

    expect(meter.state.referenceDb).not.toBeNull();
    expect(meter.state.referenceStepDb).toBe(0);
  });

  it('clearReference は測定中でも捨てる', () => {
    const meter = new VolumeMeter(SR);
    meter.beginReference();
    meter.push(pinkNoise(SR * 4, 0.05, 44));
    meter.clearReference();
    expect(meter.state.referenceCapturing).toBe(false);
    expect(meter.state.referenceDb).toBeNull();

    meter.push(pinkNoise(SR * LEQ_WINDOW_SEC, 0.05, 45));
    expect(meter.state.referenceDb).toBeNull(); // 中止したので勝手に揃わない
  });
});

describe('表示の整形', () => {
  it('バーは 0..1 に収まる', () => {
    expect(barRatio(-120)).toBe(0);
    expect(barRatio(0)).toBe(1);
    expect(barRatio(10)).toBe(1);
    expect(barRatio(-35)).toBeGreaterThan(0);
    expect(barRatio(-35)).toBeLessThan(1);
  });
});
