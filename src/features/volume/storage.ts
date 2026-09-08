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

import type { Reference } from './level.ts';

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

interface StoredReference {
  reference: Reference;
  /** 保存したときに開いていたマイクの名前。違えば復元しない */
  deviceLabel: string;
  /** 保存した時刻（epoch ms） */
  savedAt: number;
}

export interface RestoredReference {
  reference: Reference;
  /** 保存されてからの経過[ミリ秒]。画面に出すため */
  ageMs: number;
}

function isReference(v: unknown): v is Reference {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.db === 'number' && Number.isFinite(r.db)
    && typeof r.zDb === 'number' && Number.isFinite(r.zDb)
    && typeof r.unsettled === 'boolean'
    && Array.isArray(r.shape) && r.shape.every((n) => typeof n === 'number' && Number.isFinite(n));
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
  const stored: StoredReference = { reference, deviceLabel, savedAt: now };
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(stored)); } catch { /* 容量やプライベートモード */ }
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
  let raw: string | null = null;
  try { raw = localStorage.getItem(STORAGE_KEY); } catch { return null; }
  if (raw === null) return null;

  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const s = parsed as Record<string, unknown>;
  if (typeof s.savedAt !== 'number' || typeof s.deviceLabel !== 'string') return null;
  if (!isReference(s.reference)) return null;
  if (s.deviceLabel !== deviceLabel) return null;

  const ageMs = now - s.savedAt;
  // 未来の時刻（端末の時計が動いた）は信用しない
  if (ageMs < 0 || ageMs > REFERENCE_TTL_MS) return null;

  return { reference: s.reference, ageMs };
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
