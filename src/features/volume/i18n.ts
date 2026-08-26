import type { Lang } from '../../shell/i18n.ts';

export type VolumeText = {
  name: string;
  summary: string;
  /** 何をする（しない）機能かの説明。開始前の画面に出す */
  note: string;
  startBtn: string;
  stopBtn: string;
  setReferenceBtn: string;
  clearReferenceBtn: string;
  /** 基準を取る前の案内 */
  noReference: string;
  referenceLabel: string;
  currentLabel: string;
  peakLabel: string;
  leqNote: string;
  /** Leq の窓が埋まるまでの案内。埋まるまで基準は取れない */
  warmingUp: (sec: number) => string;
  clipLabel: string;
  /**
   * 音割れの量。「回数」ではなく時間で持つ——クリップした波形は半周期ごとに
   * 閾値を下回るので、突入を数えると桁が壊れる（level.ts の clipSeconds 参照）。
   */
  clipDuration: (sec: number) => string;
  clipNone: string;
  deviceLabel: string;
  deviceUnknown: string;
  measuring: string;
  /** 相対値であることの断り。絶対音圧と誤解されると判断を誤る */
  relativeNote: string;
  errorMicDenied: string;
  errorFailed: (msg: string) => string;
  retryBtn: string;
};

export const T: Record<Lang, VolumeText> = {
  ja: {
    name:    'ボリュームチェック',
    summary: '会場の音量を測り、ミキサーで動かした量を数値で見る。',
    note:
      '会場でPAから流れている音をマイクで拾い続け、「基準にする」を押した時点からの' +
      '変化量を dB で表示します。フェーダーをどれだけ動かしたかが数値で見えます。\n' +
      'ブラウザはマイクの感度を知らないため、実際の音圧（dBA）は原理的に出せません。' +
      'このツールが答えられるのは「さっきと比べてどう変わったか」だけです。',
    startBtn:          '測定を開始',
    stopBtn:           '停止',
    setReferenceBtn:   '基準にする',
    clearReferenceBtn: '基準を消す',
    noReference:       '「基準にする」を押すと、そこからの変化量を表示します。',
    referenceLabel:    '基準',
    currentLabel:      '現在',
    peakLabel:         'ピーク',
    leqNote:           '直近10秒の平均（A特性）',
    warmingUp:         (sec) => `測定を安定させています（あと ${sec} 秒）`,
    clipLabel:         '音割れ',
    clipDuration:      (sec) => `直近10秒のうち ${sec.toFixed(1)} 秒`,
    clipNone:          'なし',
    deviceLabel:       '使用中のマイク',
    deviceUnknown:     '（名前を取得できませんでした）',
    measuring:         '測定中',
    relativeNote:
      '表示は相対値です。マイクが校正されていないため dB(A) ではありません。',
    errorMicDenied: 'マイクへのアクセスが拒否されました。ブラウザの設定を確認してください。',
    errorFailed:    (msg) => `測定を開始できませんでした: ${msg}`,
    retryBtn:       'もう一度試す',
  },
  en: {
    name:    'Volume Check',
    summary: 'Measure venue level and see how much a fader move actually changed it.',
    note:
      'It listens to what the PA is playing and shows how far the level has moved, in dB, ' +
      'from the moment you press "Set reference". You can see exactly how much a fader move changed.\n' +
      'The browser does not know the microphone sensitivity, so absolute sound pressure (dBA) ' +
      'is impossible in principle. All this tool can answer is "how does it compare to before".',
    startBtn:          'Start measuring',
    stopBtn:           'Stop',
    setReferenceBtn:   'Set reference',
    clearReferenceBtn: 'Clear reference',
    noReference:       'Press "Set reference" to start showing the change from that point.',
    referenceLabel:    'Reference',
    currentLabel:      'Now',
    peakLabel:         'Peak',
    leqNote:           '10-second average (A-weighted)',
    warmingUp:         (sec) => `Settling the measurement (${sec} s to go)`,
    clipLabel:         'Clipping',
    clipDuration:      (sec) => `${sec.toFixed(1)} s of the last 10 s`,
    clipNone:          'none',
    deviceLabel:       'Microphone in use',
    deviceUnknown:     '(name unavailable)',
    measuring:         'Measuring',
    relativeNote:
      'Values are relative. The microphone is not calibrated, so these are not dB(A).',
    errorMicDenied: 'Microphone access denied. Check your browser settings.',
    errorFailed:    (msg) => `Could not start measuring: ${msg}`,
    retryBtn:       'Try again',
  },
};
