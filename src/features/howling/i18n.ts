import type { Lang } from '../../shell/i18n.ts';

export type HowlingText = {
  name: string;
  summary: string;
  /** 何をする（しない）機能かの説明。開始前の画面に出す */
  note: string;
  startBtn: string;
  stopBtn: string;
  retryBtn: string;
  resumeBtn: string;
  /** 端末が計測を止めたときの見出しと説明 */
  stalledTitle: string;
  stalledBody: string;
  /** 中断前に捕まえていた周波数の見出しと、経過時間が分からないことの断り */
  frozenLabel: string;
  frozenNote: string;
  /** 測定中であることのラベル */
  monitoring: string;
  /** 突出したピークが無い状態 */
  listening: string;
  /** 発振していることの断定 */
  ringing: string;
  listeningHint: string;
  /** 発振中に、何秒鳴き続けているか */
  ringingFor: (sec: number) => string;
  bandSuffix: string;
  barsLabel: string;
  historyLabel: string;
  historyEmpty: string;
  /** 履歴の1行。回数と合計秒 */
  eventDetail: (count: number, totalSec: number) => string;
  /** 何秒前に鳴き終わったか。古い数字を現在と読み違えないための鍵 */
  ago: (sec: number) => string;
  /** 鳴き終わった直後（まだ経過秒が意味を持たない） */
  agoJustNow: string;
  clipWarn: string;
  deviceLabel: string;
  deviceUnknown: string;
  /** 音を出さないことの明示 */
  passiveNote: string;
  errorMicDenied: string;
  errorFailed: (msg: string) => string;
};

const jaAgo = (sec: number): string => {
  const s = Math.floor(sec);
  if (s < 60) return `${s}秒前`;
  const m = Math.floor(s / 60);
  return `${m}分${s % 60}秒前`;
};

const enAgo = (sec: number): string => {
  const s = Math.floor(sec);
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  return `${m} min ${s % 60} s ago`;
};

export const T: Record<Lang, HowlingText> = {
  ja: {
    name:    'ハウリングチェック',
    summary: '鳴っているハウリングの周波数を特定する。',
    note:
      'マイクで拾い続け、いま鳴いている帯域を「4k帯」のようなバンド名と周波数の' +
      '両方で出します。鳴っていること自体は誰でも分かりますが、3.2kHzか4.5kHzかは' +
      '耳では区別できません。そこを数値にするための道具です。\n' +
      'ハウった後に開いて、次に鳴くのを待つ使い方を想定しています。鳴き終わった' +
      '周波数は次の発振まで画面に残るので、フェーダーを戻してから読めます。\n' +
      'このツール自身は音を出しません。鳴きかけの予兆も出しません' +
      '（空調やファンと区別がつかないため）。',
    startBtn: '測定を開始',
    stopBtn:  '停止',
    retryBtn: 'もう一度試す',
    resumeBtn: '測定を再開',
    stalledTitle: '計測が止まりました',
    stalledBody:
      '端末の画面が消えると、ブラウザがマイクの取り込みを止めます。' +
      '聞いていないのに「聞いています」と出し続けるより、止まったことをお伝えします。\n' +
      '「測定を再開」を押すと、また聞き始めます。',
    frozenLabel: '止まる前に捕まえた周波数',
    frozenNote: '止まってからどれだけ経ったかは分かりません。',

    monitoring: '測定中',
    listening:  '聞いています',
    ringing:    '発振中',
    listeningHint: '突出した狭いピークはありません。',
    ringingFor: (sec) => `${sec.toFixed(1)} 秒 継続中`,
    bandSuffix: '帯',

    barsLabel:  'バンドごとの突出度（周辺との差）',
    historyLabel: '直前に鳴いた周波数',
    historyEmpty: 'まだ捕まえていません。鳴いたらここに残ります。',
    eventDetail: (count, totalSec) =>
      count > 1 ? `${count}回・計${totalSec.toFixed(1)}秒` : `${totalSec.toFixed(1)}秒`,
    ago: jaAgo,
    agoJustNow: 'たった今',

    clipWarn:
      '入力が割れています。端末を音源から離してください。' +
      'この状態では周波数を取り逃すことがあります。',

    deviceLabel:   '使用中のマイク',
    deviceUnknown: '（名前を取得できませんでした）',
    passiveNote:   'このツールは音を出しません。聞いているだけです。',

    errorMicDenied: 'マイクへのアクセスが拒否されました。ブラウザの設定を確認してください。',
    errorFailed:    (msg) => `測定を開始できませんでした: ${msg}`,
  },

  en: {
    name:    'Howling Check',
    summary: 'Identify the frequency of the feedback that is ringing.',
    note:
      'It listens continuously and reports the ringing band both as a band name ' +
      '(e.g. "4k") and as a frequency. Everyone in the room can hear that it is ' +
      'howling; nobody can hear whether it is 3.2 kHz or 4.5 kHz. This tool puts a ' +
      'number on it.\n' +
      'It is meant to be opened after a howl and left running until the next one. ' +
      'A frequency stays on screen until the next howl, so you can read it after ' +
      'you have pulled the fader back.\n' +
      'It never plays sound itself, and it never warns about feedback that has not ' +
      'happened yet (that cannot be told apart from HVAC or a fan).',
    startBtn: 'Start listening',
    stopBtn:  'Stop',
    retryBtn: 'Try again',
    resumeBtn: 'Resume listening',
    stalledTitle: 'Measurement stopped',
    stalledBody:
      'When the screen turns off, the browser stops capturing from the microphone. ' +
      'Rather than keep saying "nothing ringing" while not listening, we tell you it stopped.\n' +
      'Press "Resume listening" to start again.',
    frozenLabel: 'Caught before it stopped',
    frozenNote: 'How long ago this was is no longer known.',

    monitoring: 'Listening',
    listening:  'Nothing ringing',
    ringing:    'Ringing',
    listeningHint: 'No narrow peak standing out.',
    ringingFor: (sec) => `${sec.toFixed(1)} s and counting`,
    bandSuffix: ' band',

    barsLabel:  'Prominence per band (peak above its neighbours)',
    historyLabel: 'Last frequencies caught',
    historyEmpty: 'Nothing caught yet. It will stay here once something rings.',
    eventDetail: (count, totalSec) =>
      count > 1 ? `${count}× · ${totalSec.toFixed(1)}s total` : `${totalSec.toFixed(1)}s`,
    ago: enAgo,
    agoJustNow: 'just now',

    clipWarn:
      'The input is clipping. Move the device away from the source — ' +
      'the frequency can be missed while this lasts.',

    deviceLabel:   'Microphone in use',
    deviceUnknown: '(name unavailable)',
    passiveNote:   'This tool never plays sound. It only listens.',

    errorMicDenied: 'Microphone access denied. Check your browser settings.',
    errorFailed:    (msg) => `Could not start listening: ${msg}`,
  },
};
