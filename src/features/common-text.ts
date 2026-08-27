/**
 * 機能をまたいで同じ文言。
 *
 * 置く基準は「同じ物事を指しているか」であって、たまたま同じ文字列かどうかでは
 * ない。ここにあるのは共通の状態機械（`lib/audio/session.svelte.ts`）が持つ状態の
 * 呼び名——止まった／拒否された／いま開いているマイク——で、機能ごとに違う名前を
 * 付ける理由が無いものだけである。
 *
 * 機能固有の文言は各機能の i18n.ts に置く。ハウリングの再開ボタンが
 * "Resume listening"、ボリュームが "Resume measuring" なのは**測っているものが
 * 違うから**であり、揃えるべき差ではない。だから `MonitorText` は型として
 * 「監視機能なら必ず持つ9個」を決めるだけで、値は6個しか配らない。
 */

import type { Lang } from '../shell/i18n.ts';
import type { MonitorErrorKind } from '../lib/audio/session.svelte.ts';

/**
 * マイクを拒否されたときの断り。
 *
 * 受動リアルタイムの2機能だけでなく、バッチの音質評価も同じ文を出す——
 * 拒否したのはブラウザであって、こちらが何を測ろうとしていたかは関係が無い。
 */
export const MIC_DENIED: Record<Lang, string> = {
  ja: 'マイクへのアクセスが拒否されました。ブラウザの設定を確認してください。',
  en: 'Microphone access denied. Check your browser settings.',
};

/** 監視機能で値まで共通の文言 */
export type MonitorCommonText = {
  stopBtn: string;
  retryBtn: string;
  /** 端末が計測を止めたときの見出し */
  stalledTitle: string;
  deviceLabel: string;
  deviceUnknown: string;
  errorMicDenied: string;
};

/**
 * 受動リアルタイム機能が必ず持つ文言。
 *
 * 後半3つは機能ごとに変える。何を測っていたかで言い方が変わるものである。
 */
export type MonitorText = MonitorCommonText & {
  resumeBtn: string;
  /** 止まった理由と、再開すると何が起きるかの説明 */
  stalledBody: string;
  errorFailed: (msg: string) => string;
};

export const MONITOR: Record<Lang, MonitorCommonText> = {
  ja: {
    stopBtn:        '停止',
    retryBtn:       'もう一度試す',
    stalledTitle:   '計測が止まりました',
    deviceLabel:    '使用中のマイク',
    deviceUnknown:  '（名前を取得できませんでした）',
    errorMicDenied: MIC_DENIED.ja,
  },
  en: {
    stopBtn:        'Stop',
    retryBtn:       'Try again',
    stalledTitle:   'Measurement stopped',
    deviceLabel:    'Microphone in use',
    deviceUnknown:  '(name unavailable)',
    errorMicDenied: MIC_DENIED.en,
  },
};

/**
 * 失敗の種別を文面にする。
 *
 * 状態機械が種別で持ち、文面をここで当てるのは、**言語を切り替えたときに
 * エラー行だけ元の言語で残らないようにする**ためである。文面を状態に保存すると、
 * 保存した時点の言語がそこに焼き付く。
 */
export function monitorErrorMsg(
  kind: MonitorErrorKind,
  detail: string,
  t: MonitorText,
): string {
  if (kind === 'mic-denied') return t.errorMicDenied;
  if (kind === 'failed') return t.errorFailed(detail);
  return '';
}
