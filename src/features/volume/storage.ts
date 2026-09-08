/**
 * 基準の保存。**リロードで消えたぶんだけを取り戻すためのものである。**
 *
 * 保存する `referenceDb` は dBFS——「そのマイクのフルスケールに対する比」であり、
 * 意味を持つのは同じ端末・同じ入力ゲイン・**同じ位置**・同じ向きのときだけである。
 * 数メートル動けば低域は10dB以上変わる。だから「別の日に使い回す」ためのものでは
 * ないし、そう使えるようにも作らない。
 *
 * **復元した基準が今も有効かを、この道具は検証できない。** ずれが20dBあれば異常と
 * して弾けるが、危ないのは3dBや6dBのずれで、それはこの道具が測るために存在して
 * いる量そのものである。原理的に自己検証できないので、防げるのは
 *
 *   - マイク名が違う（別の機材）
 *   - 時間が経ちすぎている
 *
 * の2つだけになる。**「リロードして同じ席」と「閉じて客席後方へ歩いてから開き直した」
 * は区別できない**——同じ端末・同じマイク名・数分以内で、どちらも通る。塞げないので、
 * 復元したことを画面に出し、取り直しを1タップの位置に置くことで釣り合わせる。
 */

import { SHAPE_BAND_COUNT, type Reference } from './level.ts';

/** 言語設定と同じ接頭辞。同じアプリの持ち物であることを鍵から分かるようにする */
const STORAGE_KEY = 'aqc-volume-reference';

/**
 * 保存した基準を使ってよい時間[ミリ秒]。
 *
 * **取り違えの向きが非対称なので短く倒す。** 取り直しのコストは声の10秒（喋りが
 * 疎な会場なら壁時計で20〜30秒）、間違った基準のコストは間違ったフェーダー操作で
 * ある。リロード・画面遷移・タブ破棄はどれも数秒から1分で戻ってくるので、10分あれば
 * 取りこぼさない。休憩を挟めば期限切れになるが、休憩中に会場は変わっているので
 * 取り直すのが正しい。
 */
export const REFERENCE_TTL_MS = 10 * 60 * 1000;

/**
 * 「まだ使っている」を書き戻す間隔[ミリ秒]。
 *
 * 毎フレーム書くと100msごとに localStorage を触ることになる。期限が10分なので、
 * 1分おきに延ばせば取りこぼさない。
 */
export const REFERENCE_TOUCH_INTERVAL_MS = 60 * 1000;

interface StoredReference {
  reference: Reference;
  /** 保存したときに開いていたマイクの名前。違えば復元しない */
  deviceLabel: string;
  /**
   * 基準を測り終えた時刻（epoch ms）。**画面に出す「N分前」はこちらから数える。**
   * 利用者が知りたいのは「その基準がいつの会場のものか」であって、
   * 最後にファイルへ書いた時刻ではない。
   */
  capturedAt: number;
  /**
   * 最後にこの基準で測っていた時刻（epoch ms）。**期限はこちらから数える。**
   *
   * 測り終えた時刻から数えると、**測り続けているだけで期限が切れる**——2時間の
   * 本番で最初に基準を取り、40分後にタブが落ちると、ずっと有効に使っていた基準が
   * 復元できない。この機能が防ごうとしている消え方そのものである。
   */
  lastUsedAt: number;
}

export interface RestoredReference {
  reference: Reference;
  /** 測り終えてからの経過[ミリ秒]。画面に出すため */
  ageMs: number;
}

/**
 * 読み戻した中身が基準として使える形か。
 *
 * **バンド数まで見る。** `shapeDistanceDb` は短いほうに合わせて比べるので、
 * バンドの並びを変えた後に古い値が残っていても例外にならず、**少ないバンドで
 * 比べた小さめの距離**が黙って出る。拍手や BGM を弾くための仕組みが、気づかない
 * うちに緩むことになる。読めないものは捨てる。
 */
function isReference(v: unknown): v is Reference {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.db === 'number' && Number.isFinite(r.db)
    && typeof r.zDb === 'number' && Number.isFinite(r.zDb)
    && typeof r.unsettled === 'boolean'
    && Array.isArray(r.shape) && r.shape.length === SHAPE_BAND_COUNT
    && r.shape.every((n) => typeof n === 'number' && Number.isFinite(n));
}

/**
 * 基準を保存する。
 *
 * **信用できない基準は保存しない。** 画面で「この基準からの差は信用できません」と
 * 断っている値を、次のセッションで断りごと復元するか、断りを落として復元するかの
 * 二択はどちらも筋が悪い。マイク名が取れないときも保存しない——復元してよいかを
 * 確かめる手立てが無くなる。
 */
export function saveReference(
  reference: Reference, deviceLabel: string, now = Date.now(),
): void {
  if (reference.unsettled || !deviceLabel) return;
  const stored: StoredReference = {
    reference, deviceLabel, capturedAt: now, lastUsedAt: now,
  };
  write(stored);
}

/**
 * 「この基準でまだ測り続けている」と記録する。期限だけを延ばし、
 * 測り終えた時刻（画面に出す古さ）は動かさない。
 *
 * 測定中に定期的に呼ぶ。呼ばないと、長い本番の途中でリロードしたときに
 * **使い続けていた基準が期限切れで捨てられる**。
 */
export function touchReference(deviceLabel: string, now = Date.now()): void {
  const stored = read();
  if (stored === null || !deviceLabel || stored.deviceLabel !== deviceLabel) return;
  write({ ...stored, lastUsedAt: now });
}

function write(stored: StoredReference): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(stored)); } catch { /* 容量やプライベートモード */ }
}

/** 読めて、形が揃っているときだけ返す */
function read(): StoredReference | null {
  let raw: string | null = null;
  try { raw = localStorage.getItem(STORAGE_KEY); } catch { return null; }
  if (raw === null) return null;

  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const s = parsed as Record<string, unknown>;
  if (typeof s.capturedAt !== 'number' || typeof s.lastUsedAt !== 'number') return null;
  if (typeof s.deviceLabel !== 'string') return null;
  if (!isReference(s.reference)) return null;
  return {
    reference: s.reference,
    deviceLabel: s.deviceLabel,
    capturedAt: s.capturedAt,
    lastUsedAt: s.lastUsedAt,
  };
}

/**
 * 保存された基準を読む。マイク名が一致し、期限内のときだけ返す。
 *
 * マイク名が空のときは復元しない。**同じ機材か確かめられないなら破棄する**という
 * 中断からの再開での判断と、向きを揃える。
 */
export function loadReference(
  deviceLabel: string, now = Date.now(),
): RestoredReference | null {
  if (!deviceLabel) return null;
  const stored = read();
  if (stored === null || stored.deviceLabel !== deviceLabel) return null;

  // 期限は「最後に使っていた時刻」から、画面に出す古さは「測り終えた時刻」から
  const idleMs = now - stored.lastUsedAt;
  const ageMs  = now - stored.capturedAt;
  // 未来の時刻（端末の時計が動いた）は信用しない
  if (idleMs < 0 || ageMs < 0 || idleMs > REFERENCE_TTL_MS) return null;

  return { reference: stored.reference, ageMs };
}

/**
 * 保存された基準を消す。
 *
 * **`停止` と `基準を消す` から呼ぶ。** どちらも「この基準はもう使わない」という
 * 意思表示であり、それを黙って裏返して10分以内の再訪で復元したら、
 * ボタンが何を消しているのか説明できなくなる。生き残ってよいのは
 * **利用者が終わりを宣言していない消え方**（閉じた・リロード・タブ破棄）だけである。
 */
export function clearStoredReference(): void {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* 触れないなら何もしない */ }
}
