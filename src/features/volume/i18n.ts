import type { Lang } from '../../shell/i18n.ts';
import { MONITOR, type MonitorText } from '../common-text.ts';

/** 共通の9個（停止・再開・止まった・マイク名・失敗）は MonitorText が持つ */
export type VolumeText = MonitorText & {
  name: string;
  summary: string;
  /** 何をする（しない）機能かの説明。開始前の画面に出す */
  note: string;
  startBtn: string;
  /** 中断しても基準は残っていることの断り */
  stalledKeepsReference: string;
  /** 再開したら別のマイクだった。基準は比較に使えない */
  referenceDropped: string;
  setReferenceBtn: string;
  clearReferenceBtn: string;
  /** 窓が埋まって、まだ基準が無いときの見出し */
  setReferenceTitle: string;
  /** 基準を取る前の案内 */
  noReference: string;
  peakLabel: string;
  leqNote: string;
  /**
   * Leq の窓が埋まるまでの見出しと残り秒数。埋まるまで基準は取れず、dB も出さない。
   * 見出しと秒数を分けているのは、秒数だけを大きく出すため
   */
  warmingUpTitle: string;
  warmingUpRemaining: (sec: number) => string;
  clipLabel: string;
  /**
   * 音割れの量。「回数」ではなく時間で持つ——クリップした波形は半周期ごとに
   * 閾値を下回るので、突入を数えると桁が壊れる（level.ts の clipSeconds 参照）。
   */
  clipDuration: (sec: number) => string;
  clipNone: string;
  measuring: string;
  /** 相対値であることの断り。絶対音圧と誤解されると判断を誤る */
  relativeNote: string;
};

export const T: Record<Lang, VolumeText> = {
  ja: {
    ...MONITOR.ja,
    name:    'ボリュームチェック',
    summary: '会場の音量を測り、ミキサーで動かした量を数値で見る。',
    note:
      '会場でPAから流れている音をマイクで拾い続け、「基準にする」を押した時点からの' +
      '変化量を dB で表示します。フェーダーをどれだけ動かしたかが数値で見えます。\n' +
      'マイクの感度が判別できないため、実際の音圧（dBA）は原理的に出せません。',
    startBtn:          '測定を開始',
    resumeBtn:         '測定を再開',
    stalledBody:
      '端末の画面が消えると、ブラウザがマイクの取り込みを止めます。' +
      '固まった数字を出し続けるより、止まったことをお伝えします。\n' +
      '再開すると測り直します（平均が安定するまで10秒かかります）。',
    stalledKeepsReference: '基準は保持しています。',
    referenceDropped:
      '再開したときに別のマイクが開いたため、基準を破棄しました。取り直してください。',
    setReferenceBtn:   '基準にする',
    clearReferenceBtn: '基準を消す',
    setReferenceTitle: '基準を取ってください',
    noReference:       '「基準にする」を押すと、そこからの変化量を表示します。',
    peakLabel:         'ピーク',
    leqNote:           '直近10秒の平均（A特性）',
    warmingUpTitle:      '測定を安定させています',
    warmingUpRemaining:  (sec) => `あと ${sec} 秒`,
    clipLabel:         '音割れ',
    clipDuration:      (sec) => `直近10秒のうち ${sec.toFixed(1)} 秒`,
    clipNone:          'なし',
    measuring:         '測定中',
    relativeNote:
      '表示は相対値です。マイクが校正されていないため dB(A) ではありません。',
    errorFailed:    (msg) => `測定を開始できませんでした: ${msg}`,
  },
  en: {
    ...MONITOR.en,
    name:    'Volume Check',
    summary: 'Measure venue level and see how much a fader move actually changed it.',
    note:
      'It listens to what the PA is playing and shows how far the level has moved, in dB, ' +
      'from the moment you press "Set reference". You can see exactly how much a fader move changed.\n' +
      'The microphone sensitivity cannot be determined, so absolute sound pressure (dBA) ' +
      'is impossible in principle.',
    startBtn:          'Start measuring',
    resumeBtn:         'Resume measuring',
    stalledBody:
      'When the screen turns off, the browser stops capturing from the microphone. ' +
      'Rather than keep showing a frozen number, we tell you it stopped.\n' +
      'Resuming starts a fresh measurement (the average needs 10 s to settle).',
    stalledKeepsReference: 'Your reference has been kept.',
    referenceDropped:
      'A different microphone opened on resume, so the reference was dropped. Set it again.',
    setReferenceBtn:   'Set reference',
    clearReferenceBtn: 'Clear reference',
    setReferenceTitle: 'Set a reference',
    noReference:       'Press "Set reference" to start showing the change from that point.',
    peakLabel:         'Peak',
    leqNote:           '10-second average (A-weighted)',
    warmingUpTitle:      'Settling the measurement',
    warmingUpRemaining:  (sec) => `${sec} s to go`,
    clipLabel:         'Clipping',
    clipDuration:      (sec) => `${sec.toFixed(1)} s of the last 10 s`,
    clipNone:          'none',
    measuring:         'Measuring',
    relativeNote:
      'Values are relative. The microphone is not calibrated, so these are not dB(A).',
    errorFailed:    (msg) => `Could not start measuring: ${msg}`,
  },
};
