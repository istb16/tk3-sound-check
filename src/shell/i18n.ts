/**
 * シェル（アプリ全体）の文言。
 *
 * 機能固有の文言はここに置かない。各機能が自分の i18n.ts を持ち、
 * 新しい機能を足すときにこのファイルを触らなくて済むようにしている。
 */

export type Lang = 'ja' | 'en';

export type ShellText = {
  /**
   * アプリ全体の名前。個々の機能名（音質チェック等）とは別物。
   *
   * 看板に出る綴りは `WORDMARK`（英字固定）で、こちらは文中とタブのタイトル用。
   * 言語を切り替えても看板が変わらないようにしている——JA/EN を切り替える
   * サイトでは、翻訳しなくて済む名前のほうが看板に向く。
   */
  productName: string;
  /**
   * 看板の下に置く一行。
   *
   * 仕事は説得より**安心**である。「名前と3つのボタンしか無い画面」は説明を
   * 省いたのではなく書き忘れたように見えるので、そこを埋める。
   * 誇張しないこと——「dBAは原理的に出せません」と言い続けてきた製品が、
   * 看板だけ誇張していると信用が落ちる。
   */
  tagline: string;
  menuLead: string;
  /** 機能ページから戻る先の名前。行き先を言うので「SOUND CHECK」ではない */
  backToMenu: string;
};

/** 看板の綴り。言語で変えない */
export const WORDMARK = 'SOUND CHECK';

export const SHELL: Record<Lang, ShellText> = {
  ja: {
    productName:     'サウンドチェック',
    tagline:
      '耳では分からないことを、その場で数値にする。\n' +
      '会議の録音環境から、会場のPAまで。',
    menuLead:        '調べたいものを選んでください。',
    backToMenu:      'メニュー',
  },
  en: {
    productName:     'Sound Check',
    tagline:
      "Put a number on what your ears can't tell apart.\n" +
      'From meeting rooms to the PA in the hall.',
    menuLead:        'Pick what you want to measure.',
    backToMenu:      'Menu',
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
