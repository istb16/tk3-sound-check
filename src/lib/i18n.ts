export type Lang = 'ja' | 'en';
export type CategoryKey = 'noise' | 'distortion' | 'reverb' | 'echo' | 'clarity';
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
    categoryNames: { noise: 'ノイズ', distortion: '歪み', reverb: '残響', echo: 'エコー', clarity: '明瞭度' },
    categoryDescs: {
      noise:      '背景雑音の少なさ',
      distortion: '音割れ・歪みのなさ',
      reverb:     '反響・残響のなさ',
      echo:       'エコーのなさ',
      clarity:    '声の聞き取りやすさ',
    },
    resetBtn:    'もう一度チェックする',
    radarLabels: ['ノイズ', '歪み', '残響', 'エコー', '明瞭度'],
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
    categoryNames: { noise: 'Noise', distortion: 'Distortion', reverb: 'Reverb', echo: 'Echo', clarity: 'Clarity' },
    categoryDescs: {
      noise:      'Absence of background noise',
      distortion: 'Absence of distortion / clipping',
      reverb:     'Absence of reverb',
      echo:       'Absence of echo',
      clarity:    'Voice intelligibility',
    },
    resetBtn:    'Check again',
    radarLabels: ['Noise', 'Distortion', 'Reverb', 'Echo', 'Clarity'],
  },
};

export function initLang(): Lang {
  try {
    const stored = localStorage.getItem('aqc-lang');
    if (stored === 'ja' || stored === 'en') return stored;
  } catch {}
  return navigator.language.startsWith('ja') ? 'ja' : 'en';
}
