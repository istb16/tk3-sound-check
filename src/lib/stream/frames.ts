/**
 * 終わりの無い流れを扱う骨組み。DOM非依存。
 *
 * 受動リアルタイム機能（ボリューム・ハウリング）は、どちらも
 * 「マイクから不定長のチャンクが届き続ける」形をしている。チャンクの長さは
 * ワークレットの都合で決まり、測りたい単位（100msのフレーム）とは一致しない。
 * その食い違いを吸収するのがここにある3つだけである。
 *
 * **何を積むかはここでは決めない。** ボリュームは二乗和だけを積み、
 * ハウリングはFFTのために波形そのものを持つ。そこを共通化すると、
 * 片方に要らないものを持たせることになる。
 */

/**
 * チャンクを固定長のフレームに区切る。
 *
 * 状態はフレーム内の充填数だけで、サンプルは保持しない。積むものは
 * 呼び出し側が `onSegment` の中で決める。
 */
export class FrameSplitter {
  readonly frameSize: number;
  /** いまのフレームに何サンプル入っているか */
  private filled = 0;

  constructor(frameSize: number) {
    this.frameSize = Math.max(1, Math.round(frameSize));
  }

  /**
   * チャンクをフレーム境界で切り、区間ごとに `onSegment` を呼ぶ。
   * フレームが完成する区間では `completed` が true になる。
   *
   * 戻り値はフレームが1つ以上完成したかどうか
   * （呼び出し側が画面を更新すべきタイミング）。
   */
  push(
    chunk: Float32Array,
    onSegment: (offset: number, length: number, completed: boolean) => void,
  ): boolean {
    let offset = 0;
    let completed = false;

    while (offset < chunk.length) {
      const take = Math.min(this.frameSize - this.filled, chunk.length - offset);
      this.filled += take;
      const done = this.filled === this.frameSize;

      onSegment(offset, take, done);

      if (done) { this.filled = 0; completed = true; }
      offset += take;
    }
    return completed;
  }

  reset(): void {
    this.filled = 0;
  }
}

/**
 * 直近 `capacity` 件だけを保つ列。フレームごとの集計値を溜める窓。
 *
 * 「表示用の短期履歴」であって「終了時サマリ用の長期履歴」ではない。
 * 前者は判定に必要なので持つ。後者は作らない。
 */
export class RingWindow {
  readonly capacity: number;
  private readonly items: number[] = [];

  constructor(capacity: number) {
    this.capacity = Math.max(1, Math.round(capacity));
  }

  push(value: number): void {
    this.items.push(value);
    if (this.items.length > this.capacity) this.items.shift();
  }

  get length(): number { return this.items.length; }
  /** 窓が埋まったか。埋まる前の集計値は参考値である */
  get full(): boolean { return this.items.length >= this.capacity; }
  get values(): readonly number[] { return this.items; }

  last(): number | undefined { return this.items[this.items.length - 1]; }

  mean(): number {
    if (this.items.length === 0) return 0;
    let sum = 0;
    for (const v of this.items) sum += v;
    return sum / this.items.length;
  }

  max(): number {
    let m = -Infinity;
    for (const v of this.items) if (v > m) m = v;
    return m;
  }

  /** 条件を満たす件数。真偽を 0/1 で積んだ窓の集計に使う */
  count(predicate: (v: number) => boolean): number {
    let n = 0;
    for (const v of this.items) if (predicate(v)) n++;
    return n;
  }

  clear(): void { this.items.length = 0; }
}

/**
 * 直近 `size` サンプルだけを保持する環状バッファ。
 *
 * スペクトルを取るには「いまから遡って N サンプル」が要る。チャンクを
 * 連結して伸ばし続けると、終わりの無い監視ではメモリが伸び続ける。
 */
export class SampleRing {
  readonly size: number;
  private readonly buf: Float32Array;
  private writeIdx = 0;
  private written = 0;

  constructor(size: number) {
    this.size = Math.max(1, Math.round(size));
    this.buf = new Float32Array(this.size);
  }

  /** 何サンプル溜まっているか（size で頭打ち） */
  get filled(): number { return this.written; }

  write(chunk: Float32Array, offset: number, length: number): void {
    const end = Math.min(offset + length, chunk.length);
    for (let i = offset; i < end; i++) {
      this.buf[this.writeIdx] = chunk[i];
      this.writeIdx = (this.writeIdx + 1) % this.size;
      if (this.written < this.size) this.written++;
    }
  }

  /** 古い順に out へ書き出す。out.length は size と同じであること */
  readInto(out: Float32Array): void {
    const start = this.writeIdx; // 埋まっていれば、書き込み位置がそのまま最古
    for (let i = 0; i < this.size; i++) out[i] = this.buf[(start + i) % this.size];
  }

  clear(): void {
    this.buf.fill(0);
    this.writeIdx = 0;
    this.written = 0;
  }
}
