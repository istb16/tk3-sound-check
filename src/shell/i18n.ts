/**
 * シェル（アプリ全体）の文言。
 *
 * 機能固有の文言はここに置かない。各機能が自分の i18n.ts を持ち、
 * 新しい機能を足すときにこのファイルを触らなくて済むようにしている。
 */

export type Lang = 'ja' | 'en';

export type ShellText = {
  /** アプリ全体の名前。個々の機能名（音質チェック等）とは別物 */
  productName: string;
  menuLead: string;
  /** 未実装機能の見出しと本文 */
  comingSoonLabel: string;
  comingSoonBody: string;
  backToMenu: string;
};

export const SHELL: Record<Lang, ShellText> = {
  ja: {
    productName:     'サウンドチェック',
    menuLead:        '調べたいものを選んでください。',
    comingSoonLabel: '準備中',
    comingSoonBody:  'この機能はまだ作っていません。',
    backToMenu:      'メニューに戻る',
  },
  en: {
    productName:     'Sound Check',
    menuLead:        'Pick what you want to measure.',
    comingSoonLabel: 'Coming soon',
    comingSoonBody:  'This one is not built yet.',
    backToMenu:      'Back to menu',
  },
};

const STORAGE_KEY = 'aqc-lang';

export function initLang(): Lang {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'ja' || stored === 'en') return stored;
  } catch {}
  return navigator.language.startsWith('ja') ? 'ja' : 'en';
}

export function saveLang(lang: Lang): void {
  try { localStorage.setItem(STORAGE_KEY, lang); } catch {}
}
