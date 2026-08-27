import { describe, expect, it } from 'vitest';
import { FrameSplitter, RingWindow, SampleRing } from './frames.ts';

/**
 * 終わりの無い流れの骨組み。ここが崩れると、受動リアルタイムの2機能が
 * 同時に、しかも「動いているように見えたまま」壊れる。
 */

describe('FrameSplitter — チャンクをフレームに区切る', () => {
  /** 呼ばれた区間を (offset, length, completed) で記録する */
  function record(frameSize: number, chunkSizes: number[]) {
    const f = new FrameSplitter(frameSize);
    const segments: [number, number, boolean][] = [];
    const completions: boolean[] = [];
    for (const size of chunkSizes) {
      completions.push(
        f.push(new Float32Array(size), (o, l, c) => segments.push([o, l, c])),
      );
    }
    return { segments, completions };
  }

  it('チャンクがフレームより短ければ、たまるまで完成しない', () => {
    const { segments, completions } = record(100, [30, 30, 30]);
    expect(completions).toEqual([false, false, false]);
    expect(segments.every(([, , c]) => !c)).toBe(true);
  });

  it('ちょうどたまったところで完成する', () => {
    const { completions } = record(100, [30, 30, 40]);
    expect(completions).toEqual([false, false, true]);
  });

  it('1チャンクに複数フレームが入っていれば、その回数だけ区切る', () => {
    const { segments } = record(100, [250]);
    // 100 / 100 / 50 の3区間。完成は最初の2つ
    expect(segments.map(([, l, c]) => [l, c])).toEqual([
      [100, true], [100, true], [50, false],
    ]);
  });

  it('区切りはチャンク内のオフセットで返る（呼び出し側が元の波形を見られる）', () => {
    const { segments } = record(100, [250]);
    expect(segments.map(([o]) => o)).toEqual([0, 100, 200]);
  });

  it('チャンクの区切り方を変えても、完成する総数は変わらない', () => {
    const total = (sizes: number[]): number =>
      record(100, sizes).segments.filter(([, , c]) => c).length;
    expect(total([1000])).toBe(10);
    expect(total([333, 333, 334])).toBe(10);
    expect(total(new Array(1000).fill(1))).toBe(10);
  });
});

describe('RingWindow — 直近N件だけを保つ', () => {
  it('容量を超えたら古いほうから捨てる', () => {
    const w = new RingWindow(3);
    for (const v of [1, 2, 3, 4, 5]) w.push(v);
    expect([...w.values]).toEqual([3, 4, 5]);
    expect(w.length).toBe(3);
  });

  it('埋まったかどうかが分かる（埋まる前の集計値は参考値）', () => {
    const w = new RingWindow(3);
    w.push(1); expect(w.full).toBe(false);
    w.push(2); expect(w.full).toBe(false);
    w.push(3); expect(w.full).toBe(true);
  });

  it('平均・最大・最新・件数を返す', () => {
    const w = new RingWindow(4);
    for (const v of [2, 4, 6, 8]) w.push(v);
    expect(w.mean()).toBe(5);
    expect(w.max()).toBe(8);
    expect(w.last()).toBe(8);
    expect(w.count((v) => v > 4)).toBe(2);
  });

  it('空のときも例外を出さない', () => {
    const w = new RingWindow(3);
    expect(w.mean()).toBe(0);
    expect(w.last()).toBeUndefined();
    expect(w.count(() => true)).toBe(0);
  });
});

describe('SampleRing — 直近Nサンプルだけを保つ', () => {
  function write(ring: SampleRing, values: number[]): void {
    const chunk = Float32Array.from(values);
    ring.write(chunk, 0, chunk.length);
  }

  it('埋まる前は書いたぶんだけ数える', () => {
    const ring = new SampleRing(8);
    write(ring, [1, 2, 3]);
    expect(ring.filled).toBe(3);
  });

  it('容量を超えても filled は容量で頭打ちになる', () => {
    const ring = new SampleRing(4);
    write(ring, [1, 2, 3, 4, 5, 6]);
    expect(ring.filled).toBe(4);
  });

  it('古い順に読み出せる（環状であることが外から見えない）', () => {
    const ring = new SampleRing(4);
    write(ring, [1, 2, 3, 4, 5, 6]);
    const out = new Float32Array(4);
    ring.readInto(out);
    expect([...out]).toEqual([3, 4, 5, 6]);
  });

  it('書き込みを分割しても結果は同じ', () => {
    const a = new SampleRing(4);
    write(a, [1, 2, 3, 4, 5, 6]);
    const b = new SampleRing(4);
    write(b, [1, 2]);
    write(b, [3, 4, 5]);
    write(b, [6]);

    const oa = new Float32Array(4), ob = new Float32Array(4);
    a.readInto(oa); b.readInto(ob);
    expect([...ob]).toEqual([...oa]);
  });

  it('チャンクの一部だけを書ける（フレーム境界で切るため）', () => {
    const ring = new SampleRing(3);
    const chunk = Float32Array.from([9, 1, 2, 3, 9]);
    ring.write(chunk, 1, 3);
    const out = new Float32Array(3);
    ring.readInto(out);
    expect([...out]).toEqual([1, 2, 3]);
  });
});
