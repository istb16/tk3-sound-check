import type { Lang } from '../../shell/i18n.ts';

export type HowlingText = {
  name: string;
  summary: string;
  /** 準備中ページに出す、この機能が何をする（しない）かの補足 */
  note: string;
};

export const T: Record<Lang, HowlingText> = {
  ja: {
    name:    'ハウリングチェック',
    summary: '鳴っているハウリングの周波数を特定します。',
    note:
      'マイクで拾い続け、いま鳴いている帯域を「4kHz帯」のようなバンド名と周波数の' +
      '両方で出し続けます。鳴っていること自体は誰でも分かりますが、3.2kHzか4.5kHzかは' +
      '耳では区別できません。そこを数値にするための道具です。' +
      'このツール自身は音を出しません。',
  },
  en: {
    name:    'Howling Check',
    summary: 'Identifies the frequency of howling while it is happening.',
    note:
      'It listens continuously and reports the ringing band both as a band name ' +
      '(e.g. "4 kHz") and as a frequency. Everyone in the room can hear that it is ' +
      'howling; nobody can hear whether it is 3.2 kHz or 4.5 kHz. This tool puts a ' +
      'number on it. It never plays sound itself.',
  },
};
