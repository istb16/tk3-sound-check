/**
 * ボリュームチェックの測定。DOM非依存。
 *
 * 会場でPAから流れている音を客席で拾い、ミキサーを調整するための相対レベル計。
 * **絶対音圧(dBA)は出さない。** マイクの感度が判別できないので、dBFS からの
 * 換算は原理的に不可能である。したがってここが返すのは「フルスケールに対する
 * A特性重み付けレベル」であり、それ自体には意味が無い。意味を持つのは差だけ。
 */

import { anyAbove, dbfs } from '../../lib/dsp/stats.ts';
import { AWeightingFilter } from '../../lib/dsp/weighting.ts';
import { FrameSplitter, RingWindow } from '../../lib/stream/frames.ts';

/** 表示とLeqの更新間隔。バーの手応えと計算量の折り合い */
export const FRAME_MS = 100;
/** 比較に使う等価レベルの窓。PAの音は瞬間ごとに10dB以上揺れるので平均で見る */
export const LEQ_WINDOW_SEC = 10;
/** 音割れ回数を数える窓。原因を取り除けば自動で消える長さ */
export const CLIP_WINDOW_SEC = 10;
/** ピークホールドの保持時間 */
export const PEAK_HOLD_SEC = 1;

/**
 * クリップとみなす振幅。音質チェックの estimateClipping と同じ値だが、
 * **定数は共有しない**——あちらは採点の尺度、こちらは会場での目安であり、
 * 片方を動かしたときにもう片方が黙って壊れるのを避ける。
 */
const CLIP_THRESHOLD = 0.98;

// ==========================================================================
// メーター
// ==========================================================================

export interface MeterState {
  /** 直近フレームのA特性レベル[dBFS]。バーを動かすための瞬時値 */
  instantDb: number;
  /** 直近 LEQ_WINDOW_SEC の等価レベル[dBFS]。比較に使うのはこちら */
  leqDb: number;
  /** 直近 PEAK_HOLD_SEC の最大瞬時値[dBFS] */
  peakHoldDb: number;
  /**
 * 直近 CLIP_WINDOW_SEC のうち、音割れが含まれていた時間[秒]。
 *
 * 「回数」では数えられない。クリップした波形は半周期ごとに閾値を下回るので、
 * 閾値の再突入を数えると 1kHz の正弦波を3dB突っ込んだだけで10秒間に20000回になる。
 * かといって近接した突入をまとめて「1回」にすると、鳴りっぱなしのときに
 * 移動窓が始点を通り過ぎた時点で0に戻ってしまう。
 * フレーム単位の時間で持てば、単発は 0.1秒、鳴りっぱなしは 10.0秒 と素直に出る。
 */
  clipSeconds: number;
  /** Leq の窓が埋まったか。埋まる前の値は参考値 */
  leqReady: boolean;
  /** 更新されたフレーム数。テストと「まだ測っていない」の判定に使う */
  frames: number;
  /** Leq の窓が埋まるまでの残り秒数。0 なら埋まっている */
  warmupRemainingSec: number;
}

/** 無音（完全な0）のときに返す下限。-Infinity を画面に出さないため */
export const FLOOR_DB = -120;

/**
 * 流れてくるPCMを受け取り、100msごとに測定値を更新する。
 *
 * 設計上の要点は「バーは瞬時値、比較は平均」。PAから流れる音楽や話し声は
 * 瞬間ごとに10dB以上揺れるので、瞬時値どうしを引き算してもフェーダーを
 * 何dB動かせばよいか決まらない。
 */
export class VolumeMeter {
  private readonly filter: AWeightingFilter;
  private readonly framer: FrameSplitter;

  /** フレーム未満の端数。波形そのものは要らないので二乗和だけ持つ */
  private pendingSum = 0;
  private pendingClipped = false;

  /** フレームごとのA特性パワー（振幅の二乗平均）。Leq の窓 */
  private readonly powers: RingWindow;
  /** フレームごとの瞬時dB。ピークホールドの窓 */
  private readonly instants: RingWindow;
  /** フレームごとに、そのフレームが音割れを含んでいたか（1/0）。クリップの窓 */
  private readonly clips: RingWindow;

  private frames = 0;

  constructor(sampleRate: number) {
    this.filter = new AWeightingFilter(sampleRate);
    this.framer = new FrameSplitter((sampleRate * FRAME_MS) / 1000);
    this.powers   = new RingWindow((LEQ_WINDOW_SEC * 1000) / FRAME_MS);
    this.instants = new RingWindow((PEAK_HOLD_SEC * 1000) / FRAME_MS);
    this.clips    = new RingWindow((CLIP_WINDOW_SEC * 1000) / FRAME_MS);
  }

  /**
   * PCMチャンクを流し込む。フレームが1つ以上完成したら true を返す
   * （呼び出し側が画面を更新すべきタイミング）。
   */
  push(chunk: Float32Array): boolean {
    // A特性は生の波形にかける。フィルタは状態を持つのでチャンクをまたいで連続する
    const weighted = this.filter.process(chunk);

    return this.framer.push(chunk, (offset, length, completed) => {
      for (let i = offset; i < offset + length; i++) {
        const w = weighted[i];
        this.pendingSum += w * w;
      }
      // クリップは重み付け前の値で見る。割れているかどうかは入力段の話であって
      // 聞こえ方の話ではない
      if (!this.pendingClipped && anyAbove(chunk, offset, length, CLIP_THRESHOLD)) {
        this.pendingClipped = true;
      }
      if (completed) this.commitFrame();
    });
  }

  private commitFrame(): void {
    const power = this.pendingSum / this.framer.frameSize;
    this.powers.push(power);
    this.instants.push(power > 0 ? dbfs(Math.sqrt(power)) : FLOOR_DB);
    this.clips.push(this.pendingClipped ? 1 : 0);

    this.pendingSum = 0;
    this.pendingClipped = false;
    this.frames++;
  }

  get state(): MeterState {
    if (this.frames === 0) {
      return {
        instantDb: FLOOR_DB, leqDb: FLOOR_DB, peakHoldDb: FLOOR_DB,
        clipSeconds: 0, leqReady: false, frames: 0,
        warmupRemainingSec: LEQ_WINDOW_SEC,
      };
    }
    // Leq はパワーの平均を dB にする（dB の平均ではない）
    const meanPower = this.powers.mean();

    return {
      instantDb:  this.instants.last() ?? FLOOR_DB,
      leqDb:      meanPower > 0 ? dbfs(Math.sqrt(meanPower)) : FLOOR_DB,
      peakHoldDb: this.instants.max(),
      clipSeconds: (this.clips.count((c) => c === 1) * FRAME_MS) / 1000,
      leqReady:   this.powers.full,
      frames:     this.frames,
      warmupRemainingSec:
        Math.max(0, (this.powers.capacity - this.powers.length) * FRAME_MS) / 1000,
    };
  }
}

/**
 * バーの表示位置(0..1)。
 *
 * 会場では絶対的な「適正位置」が無いので、目盛りは意味を持たない。
 * -70dBFS を左端、0dBFS を右端に置いて、動きが見えることだけを目的にする。
 */
export function barRatio(db: number): number {
  const lo = -70;
  if (!Number.isFinite(db)) return 0;
  return Math.min(1, Math.max(0, (db - lo) / (0 - lo)));
}

