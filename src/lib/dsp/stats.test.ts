import { describe, expect, it } from 'vitest';
import {
  anyAbove, clamp, dbfs, linearFit, linearRegression, maxAbs, movingAverage,
  percentile, powerDb, rms, stdev,
} from './stats.ts';

describe('dB変換', () => {
  it('dbfs は振幅、powerDb はパワーを受ける', () => {
    expect(dbfs(1)).toBeCloseTo(0, 6);
    expect(dbfs(0.5)).toBeCloseTo(-6.02, 2);
    expect(powerDb(1)).toBeCloseTo(0, 6);
    expect(powerDb(0.25)).toBeCloseTo(-6.02, 2);
  });

  it('0 を渡しても -Infinity にならない', () => {
    // 画面に -Infinity が出るのは事故
    expect(Number.isFinite(dbfs(0))).toBe(true);
    expect(Number.isFinite(powerDb(0))).toBe(true);
  });
});

describe('rms / percentile / clamp', () => {
  it('rms は区間を切って測れる', () => {
    const d = Float32Array.from([0, 0, 3, 4, 0]);
    expect(rms(d, 2, 2)).toBeCloseTo(Math.sqrt((9 + 16) / 2), 6);
  });

  it('区間が空なら 0', () => {
    expect(rms(Float32Array.from([1, 2]), 5, 3)).toBe(0);
  });

  it('percentile は元の配列を壊さない', () => {
    const values = [5, 1, 4, 2, 3];
    expect(percentile(values, 0.5)).toBe(3);
    expect(values).toEqual([5, 1, 4, 2, 3]);
  });

  it('clamp は上下に丸める', () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-5, 0, 3)).toBe(0);
    expect(clamp(1, 0, 3)).toBe(1);
  });
});

describe('stdev / movingAverage', () => {
  it('stdev は母集団（÷n）', () => {
    // 標本標準偏差(÷n-1)ではない。VADの閾値がこの定義で調整されている
    expect(stdev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2, 6);
  });

  it('要素が1つ以下なら 0', () => {
    expect(stdev([3])).toBe(0);
    expect(stdev([])).toBe(0);
  });

  it('movingAverage は端で窓を詰める（長さが変わらない）', () => {
    const out = movingAverage([1, 2, 3, 4, 5], 3);
    expect(out.length).toBe(5);
    expect(out[0]).toBeCloseTo(1.5, 6);
    expect(out[2]).toBeCloseTo(3, 6);
    expect(out[4]).toBeCloseTo(4.5, 6);
  });
});

describe('直線あてはめ', () => {
  it('傾きと切片と決定係数を返す', () => {
    const fit = linearRegression([0, 1, 2, 3], [1, 3, 5, 7]);
    expect(fit?.slope).toBeCloseTo(2, 6);
    expect(fit?.intercept).toBeCloseTo(1, 6);
    expect(fit?.r2).toBeCloseTo(1, 6);
  });

  it('x が動かなければ傾きは定まらない（null）', () => {
    expect(linearRegression([2, 2, 2], [1, 2, 3])).toBeNull();
  });

  it('y が動かなければ決定係数は 0（NaN にしない）', () => {
    const fit = linearRegression([0, 1, 2], [5, 5, 5]);
    expect(fit?.slope).toBeCloseTo(0, 6);
    expect(fit?.r2).toBe(0);
  });

  it('linearFit は [from, to) の等間隔サンプルを見る', () => {
    // 前半だけを見れば傾き +10/秒、全体を見ればもっと緩い
    const values = [0, 1, 2, 3, 3, 3];
    expect(linearFit(values, 0, 4, 0.1).slope).toBeCloseTo(10, 6);
    expect(linearFit(values, 0, 6, 0.1).slope).toBeLessThan(10);
  });

  it('点が足りなければ傾き0を返す（例外を投げない）', () => {
    expect(linearFit([7], 0, 1, 0.1)).toEqual({ slope: 0, intercept: 7, r2: 0 });
  });
});

describe('anyAbove — 区間に閾値超えがあるか', () => {
  const d = Float32Array.from([0.1, -0.99, 0.2, 0.3]);

  it('正負どちらの向きでも見つける', () => {
    expect(anyAbove(d, 0, 4, 0.98)).toBe(true);
    expect(anyAbove(Float32Array.from([0.99]), 0, 1, 0.98)).toBe(true);
  });

  it('区間の外は見ない', () => {
    expect(anyAbove(d, 2, 2, 0.98)).toBe(false);
  });

  it('配列の終端を越えて読まない', () => {
    expect(anyAbove(d, 3, 100, 0.98)).toBe(false);
  });
});

describe('maxAbs — 区間の絶対値の最大', () => {
  it('符号によらず最大の振幅を返す', () => {
    expect(maxAbs(Float32Array.from([0.1, -0.9, 0.3]), 0, 3)).toBeCloseTo(0.9, 6);
  });

  it('区間の外は見ない', () => {
    const d = Float32Array.from([1.0, 0.1, 0.2, -1.0]);
    expect(maxAbs(d, 1, 2)).toBeCloseTo(0.2, 6);
  });

  it('長さが配列を越えても末尾で止まる', () => {
    expect(maxAbs(Float32Array.from([0.1, 0.5]), 0, 100)).toBeCloseTo(0.5, 6);
  });

  it('空の区間は 0 を返す（呼び出し側の最大値を動かさない）', () => {
    expect(maxAbs(Float32Array.from([0.9]), 1, 3)).toBe(0);
    expect(maxAbs(new Float32Array(0), 0, 1)).toBe(0);
  });

  it('無音は 0', () => {
    expect(maxAbs(new Float32Array(8), 0, 8)).toBe(0);
  });

  // ボリュームは「割れている(0.98)」「限界に近い(0.708)」「波高はいくつか」を
  // この1回の走査から導く。閾値ごとに anyAbove を回す代わりである
  it('anyAbove と同じ判定になる', () => {
    const d = Float32Array.from([0.5, -0.99, 0.2]);
    expect(maxAbs(d, 0, 3) >= 0.98).toBe(anyAbove(d, 0, 3, 0.98));
    expect(maxAbs(d, 0, 1) >= 0.98).toBe(anyAbove(d, 0, 1, 0.98));
  });
});
