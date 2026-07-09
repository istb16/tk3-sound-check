export type Lang = 'ja' | 'en';
export type CategoryKey = 'volume' | 'frequency' | 'clip' | 'noise';
export type GradeKey = 'good' | 'ok' | 'warn' | 'bad';

export type Translations = {
  title: string;
  dropMain: string;
  dropSub: string;
  dropAriaLabel: string;
  or: string;
  micBtn: (sec: number) => string;
  errorInvalidFile: string;
  errorAnalysis: (msg: string) => string;
  errorMicDenied: string;
  errorRecording: (msg: string) => string;
  vuAriaLabel: (score: number) => string;
  grades: Record<GradeKey, string>;
  categoryNames: Record<CategoryKey, string>;
  categoryDescs: Record<CategoryKey, string>;
  resetBtn: string;
  radarLabels: string[];
  adviceLabel: string;
};

export const T: Record<Lang, Translations> = {
  ja: {
    title:         '音質チェッカー',
    dropMain:      'WAV / MP3 をドロップ',
    dropSub:       'クリックしてファイルを選択',
    dropAriaLabel: 'ファイルをドロップするか、クリックして選択',
    or:            'または',
    micBtn:        (sec) => `マイクで録音（${sec}秒）`,
    errorInvalidFile: 'WAV または MP3 ファイルを選択してください。',
    errorAnalysis:    (msg) => `解析に失敗しました: ${msg}`,
    errorMicDenied:   'マイクへのアクセスが拒否されました。ブラウザの設定を確認してください。',
    errorRecording:   (msg) => `録音に失敗しました: ${msg}`,
    vuAriaLabel:      (score) => `総合スコア ${score}点`,
    grades: { good: '優秀', ok: '良好', warn: '普通', bad: '要改善' },
    categoryNames: { volume: '音量', frequency: '周波数バランス', clip: '音割れ', noise: 'ノイズ・無音' },
    categoryDescs: {
      volume:    '音量レベルと抑揚の適切さ',
      frequency: 'こもり・キンキン音のなさと明瞭度',
      clip:      'クリッピングのなさ',
      noise:     '背景雑音・無音バランスの適切さ',
    },
    resetBtn:    'もう一度チェックする',
    radarLabels: ['音量', '周波数バランス', '音割れ', 'ノイズ・無音'],
    adviceLabel: 'アドバイス',
  },
  en: {
    title:         'Audio Quality Checker',
    dropMain:      'Drop WAV / MP3',
    dropSub:       'Click to select a file',
    dropAriaLabel: 'Drop a file or click to select',
    or:            'or',
    micBtn:        (sec) => `Record with mic (${sec}s)`,
    errorInvalidFile: 'Please select a WAV or MP3 file.',
    errorAnalysis:    (msg) => `Analysis failed: ${msg}`,
    errorMicDenied:   'Microphone access denied. Check your browser settings.',
    errorRecording:   (msg) => `Recording failed: ${msg}`,
    vuAriaLabel:      (score) => `Overall score: ${score}`,
    grades: { good: 'Excellent', ok: 'Good', warn: 'Fair', bad: 'Poor' },
    categoryNames: { volume: 'Volume', frequency: 'Frequency Balance', clip: 'Clipping', noise: 'Noise/Silence' },
    categoryDescs: {
      volume:    'Appropriate loudness and dynamics',
      frequency: 'Absence of muddiness/harshness and clarity',
      clip:      'Absence of clipping/distortion',
      noise:     'Balance of background noise and silence',
    },
    resetBtn:    'Check again',
    radarLabels: ['Volume', 'Frequency Balance', 'Clipping', 'Noise/Silence'],
    adviceLabel: 'Advice',
  },
};

export function initLang(): Lang {
  try {
    const stored = localStorage.getItem('aqc-lang');
    if (stored === 'ja' || stored === 'en') return stored;
  } catch {}
  return navigator.language.startsWith('ja') ? 'ja' : 'en';
}
