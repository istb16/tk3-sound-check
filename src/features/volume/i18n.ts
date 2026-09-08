import type { Lang } from '../../shell/i18n.ts';
import { MONITOR, type MonitorText } from '../common-text.ts';

/** 共通の9個（停止・再開・止まった・マイク名・失敗）は MonitorText が持つ */
export type VolumeText = MonitorText & {
  name: string;
  summary: string;
  /**
   * 何をする（しない）機能かの説明。
   *
   * 画面を開くとそのまま測り始めるので、**通常は誰も読まない**——出るのは
   * 起動に失敗したときと、自分で停止したあとだけである。読まれないから
   * 削るのではなく、その2つの画面には他に読むものが無いから残している。
   */
  note: string;
  /** 起動に失敗したとき／自分で止めたあとの、測り始めるボタン */
  startBtn: string;
  /** 中断しても基準は残っていることの断り */
  stalledKeepsReference: string;
  /** 再開したら別のマイクだった。基準は比較に使えない */
  referenceDropped: string;
  /**
   * 再開したが、同じマイクかを確かめられなかった。
   *
   * マイク名が取れない環境では食い違いを検出しようが無い。**確かめられないときは
   * 破棄する側に倒す**——取り直しは10秒で済むが、別の機材との差は取り返せない。
   */
  referenceUnverified: string;
  setReferenceBtn: string;
  clearReferenceBtn: string;
  /** 窓が埋まって、まだ基準が無いときの見出し */
  setReferenceTitle: string;
  /**
   * 基準を測っている最中の見出し。残り秒数は speechRemaining を使う。
   *
   * 基準は押した時点から先の「声10秒ぶん」で測る。遡って測ると押す前のレベル変化が
   * 焼き付くので、ここは待ってもらうしかない。
   */
  capturingReferenceTitle: string;
  /** 基準を取る前の案内 */
  noReference: string;
  /**
   * 声が足りなくて数値を出せないときの見出し。
   *
   * 間・休憩・無音。窓は有音フレームで数えるので、誰も喋っていない間は進まない。
   */
  notEnoughSpeechTitle: string;
  /**
   * 基準を取ったときと違う音を測っているときの見出しと説明。
   *
   * 拍手・映像・BGM だけの区間。ゲートは「大きい側」を通すので、これが無いと
   * 拍手を声のつもりで平均して、確定した顔で誤った差を出す。
   */
  differentSoundTitle: string;
  differentSoundNote: string;
  /**
   * 保持している数値の但し書き。**経過秒は実時間である。**
   *
   * フェーダーを動かした直後に喋りが途切れていることは普通にあるので、そこで
   * 数値を消すと動かした量を確認する手段がその場で無くなる。残す代わりに、
   * いつ測った値かを必ず添える。
   */
  heldNote: (sec: number) => string;
  /**
   * 前回の基準を localStorage から復元して使っていることの断り。
   *
   * 黙って使い始めない。取られたことに気づけない基準は、`+0.0 dB` から始まって
   * しまうぶん、基準が無いことより質が悪い。
   */
  restoredReference: (minutes: number) => string;
  peakLabel: string;
  leqNote: string;
  /**
   * 表示がまだ収束していないときの断りと、確定までの**声の秒数**。
   *
   * 移動窓は、フェーダーを動かした直後は操作前と操作後の混合になる。+6dB 動かした
   * 声5秒ぶん後の表示は理論値どおり +4.0dB で、**収束済みの +4.0dB と見分けが
   * つかない**。読んで足りないと判断されると、そのぶん行き過ぎる。
   *
   * **秒数が実時間ではないことを文面で言い切る。** この数字は「次の操作をして
   * いいのはいつか」を決めるために読まれるので、壁時計と取り違えられるのが
   * いちばん重い誤読になる。
   */
  settlingNote: (sec: number) => string;
  /**
   * A特性の差とZ特性の差が食い違ったときの断り。
   *
   * 「差は正しい」が成り立つのは全帯域が一律に動いたときだけで、低域だけを
   * 動かす操作では主役の数字が実際の変化を小さく見せる。
   */
  bandMismatch: (signedDb: string) => string;
  /** 入力段が限界に近い。割れてはいないが差が縮む */
  nearClipWarning: (sec: number) => string;
  /** 端末側のAGCを切れなかった。レベル比較そのものが成立しない */
  agcWarning: string;
  /**
   * 基準を測っている10秒の中でレベルが変わった。
   *
   * 遡らないだけでは足りない——測っている最中に変われば、やはり混合した基準が
   * 焼き付く。窓が入れ替われば収束中の断りは消えるので、これが無いと確定した
   * 数値の顔で誤った差が出続ける。
   */
  referenceUnsettled: string;
  /**
   * 窓が満たされるまでに足りない**声の秒数**。
   *
   * 壁時計ではないので、誰も喋っていない間は減らない。**止まることは巻き戻りでは
   * ない**（巻き戻りは操作していないのに増えること）し、止まる理由は会場に実在する。
   * 壁時計に換算するには未来の喋りの密度を予測することになり、外れれば増える。
   */
  speechRemaining: (sec: number) => string;
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
      '会場でPAから流れている音をマイクで拾い続け、「基準を計測する」を押した時点からの' +
      '変化量を dB で表示します。フェーダーをどれだけ動かしたかが数値で見えます。\n' +
      '平均するのは声が出ている時間だけです（間は数えません）。\n' +
      'マイクの感度が判別できないため、実際の音圧（dBA）は原理的に出せません。',
    startBtn:          '測定を開始',
    resumeBtn:         '測定を再開',
    stalledBody:
      '端末の画面が消えると、ブラウザがマイクの取り込みを止めます。' +
      '固まった数字を出し続けるより、止まったことをお伝えします。\n' +
      '再開すると測り直します（平均が安定するまで声10秒ぶんかかります）。',
    stalledKeepsReference: '基準は保持しています。',
    referenceDropped:
      '再開したときに別のマイクが開いたため、基準を破棄しました。取り直してください。',
    referenceUnverified:
      '再開したときに同じマイクかを確認できなかったため、基準を破棄しました。取り直してください。',
    setReferenceBtn:   '基準を計測する',
    clearReferenceBtn: '基準を消す',
    setReferenceTitle: '基準を取ってください',
    capturingReferenceTitle: '基準を測っています',
    noReference:
      '「基準を計測する」を押すと、そこから声10秒ぶんの平均を基準にして、変化量を表示します。',
    notEnoughSpeechTitle: '声が足りません',
    differentSoundTitle:  '基準と違う音を測っています',
    differentSoundNote:
      '拍手・映像・BGM など、基準を取ったときと違う音が主になっています。' +
      '声が戻れば数値も戻ります。',
    heldNote:          (sec) => `${sec} 秒前の声で測った値です`,
    restoredReference: (min) =>
      `前回の基準を使っています（${min}分前）。` +
      'マイクを動かした・場所を変えた場合は取り直してください。',
    peakLabel:         'ピーク',
    leqNote:           '直近の声10秒ぶんの平均（A特性）',
    settlingNote:      (sec) =>
      `レベルが変わりました。声があと ${sec} 秒ぶんで確定します（この数値はまだ動きます）`,
    bandMismatch:      (db) => `広帯域では ${db} dB。帯域ごとに変化量が違うため、この数値だけでは読めません。`,
    nearClipWarning:   (sec) =>
      `入力が限界に近い状態が直近10秒のうち ${sec.toFixed(1)} 秒ありました。` +
      '端末のマイクが飽和すると、変化量が実際より小さく出ます。',
    agcWarning:
      'この端末は自動ゲイン調整を切れませんでした。端末が音量を勝手に戻すため、' +
      '変化量は信用できません。',
    referenceUnsettled:
      '基準を測っている間にレベルが変わりました。この基準からの差は信用できません。' +
      '取り直してください。',
    speechRemaining:     (sec) => `声があと ${sec} 秒ぶん`,
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
      'from the moment you press "Measure reference". You can see exactly how much a fader move changed.\n' +
      'The microphone sensitivity cannot be determined, so absolute sound pressure (dBA) ' +
      'is impossible in principle.\n' +
      'Only the time someone is speaking is averaged; the pauses are not counted.',
    startBtn:          'Start measuring',
    resumeBtn:         'Resume measuring',
    stalledBody:
      'When the screen turns off, the browser stops capturing from the microphone. ' +
      'Rather than keep showing a frozen number, we tell you it stopped.\n' +
      'Resuming starts a fresh measurement (the average needs 10 s of speech to settle).',
    stalledKeepsReference: 'Your reference has been kept.',
    referenceDropped:
      'A different microphone opened on resume, so the reference was dropped. Set it again.',
    referenceUnverified:
      'We could not confirm the same microphone came back on resume, so the reference was dropped. Set it again.',
    setReferenceBtn:   'Measure reference',
    clearReferenceBtn: 'Clear reference',
    setReferenceTitle: 'Set a reference',
    capturingReferenceTitle: 'Measuring the reference',
    noReference:
      'Press "Measure reference" to average the next 10 seconds of speech and show the change from there.',
    notEnoughSpeechTitle: 'Not enough speech',
    differentSoundTitle:  'This is not the sound you set the reference on',
    differentSoundNote:
      'Applause, video or music is mostly what is coming through now, not the voice the ' +
      'reference was set on. The number comes back when the speech does.',
    heldNote:          (sec) => `Measured on speech ${sec} s ago`,
    restoredReference: (min) =>
      `Using your previous reference (${min} min ago). ` +
      'Set it again if the microphone or your position has moved.',
    peakLabel:         'Peak',
    leqNote:           'Average of the last 10 s of speech (A-weighted)',
    settlingNote:      (sec) =>
      `The level changed. ${sec} more seconds of speech until this settles ` +
      '(the number is still moving)',
    bandMismatch:      (db) => `Broadband it is ${db} dB. The change is not the same across the spectrum, so this number alone does not tell you.`,
    nearClipWarning:   (sec) =>
      `The input was near its limit for ${sec.toFixed(1)} s of the last 10 s. ` +
      'If the phone microphone saturates, the change reads smaller than it really is.',
    agcWarning:
      'This device would not turn off automatic gain control. It moves the level back on its own, ' +
      'so the change shown cannot be trusted.',
    referenceUnsettled:
      'The level changed while the reference was being measured, so the change shown from it ' +
      'cannot be trusted. Set the reference again.',
    speechRemaining:     (sec) => `${sec} s of speech to go`,
    clipLabel:         'Clipping',
    clipDuration:      (sec) => `${sec.toFixed(1)} s of the last 10 s`,
    clipNone:          'none',
    measuring:         'Measuring',
    relativeNote:
      'Values are relative. The microphone is not calibrated, so these are not dB(A).',
    errorFailed:    (msg) => `Could not start measuring: ${msg}`,
  },
};
