import type { Lang } from '../../shell/i18n.ts';

export type VolumeText = {
  name: string;
  summary: string;
  note: string;
};

export const T: Record<Lang, VolumeText> = {
  ja: {
    name:    'ボリュームチェック',
    summary: 'マイクの入力レベルをリアルタイムに表示します。',
    note:
      '喋りながら「小さすぎ / 適正 / 割れている」を見て、その場でゲインを合わせるための' +
      'メーターです。音質チェックの音量軸が録音後の採点なのに対し、こちらは録る前に' +
      '合わせるための道具になります。なお表示は相対値（dBFS）です。' +
      'ブラウザはマイクの感度を知らないため、実際の音圧（dBA）は原理的に出せません。',
  },
  en: {
    name:    'Volume Check',
    summary: 'Shows the microphone input level in real time.',
    note:
      'A live meter reading too quiet / just right / clipping, so you can set the gain ' +
      'while you speak. The quality checker scores volume after the fact; this one is ' +
      'for getting it right before you record. Levels are relative (dBFS): the browser ' +
      'does not know the microphone sensitivity, so absolute sound pressure (dBA) is ' +
      'impossible in principle.',
  },
};
