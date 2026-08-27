/**
 * 機能の一覧。
 *
 * 機能を1つ足すときに触るのはこのファイルだけになるようにしている——
 * `src/features/<名前>/` にコンポーネント・アイコン・i18n.ts を置き、
 * ここに1行足す。メニューのタイルもルーティングも、この配列から導出される。
 */

import type { Component } from 'svelte';
import type { Lang } from '../shell/i18n.ts';

import QualityCheck from './quality/QualityCheck.svelte';
import HowlingCheck from './howling/HowlingCheck.svelte';
import VolumeCheck from './volume/VolumeCheck.svelte';

import QualityIcon from './quality/Icon.svelte';
import HowlingIcon from './howling/Icon.svelte';
import VolumeIcon from './volume/Icon.svelte';

import { T as qualityText } from './quality/i18n.ts';
import { T as howlingText } from './howling/i18n.ts';
import { T as volumeText } from './volume/i18n.ts';

export interface FeatureText {
  name: string;
  summary: string;
}

export interface Feature {
  id: string;
  /** URL。ルーターはこれで引く */
  path: string;
  /** 名前と一行説明は機能側の i18n が持つ。シェルは機能の文言を知らない */
  text: Record<Lang, FeatureText>;
  component: Component<{ lang: Lang }>;
  /**
   * メニューのタイルに出すアイコン。**その機能の画面の縮小図**を描く。
   * 一般的な比喩ではない——メニューの仕事は説明ではなく見分けだから。
   */
  icon: Component;
  /**
   * その機能の色。メニューのタイルと、機能ページの戻るボタン・タイトル下線に使う。
   *
   * **機能ページの中身（バー・ボタン・フォーカスリング）には持ち込まない。**
   * ハウリングの突出度バーもボリュームのレベルバーも、閾値を超えると
   * `--accent` から赤へ変わることで異常を示している。基調色を赤に近づけるほど
   * その変化が読めなくなる。
   *
   * 同じ理由で**赤系は使わない**。赤は「何かがおかしい」専用に予約してある。
   */
  accent: string;
}

/** 並び順がそのままメニューの並び順になる */
export const FEATURES: Feature[] = [
  {
    id: 'quality',
    path: '/quality',
    text: qualityText,
    component: QualityCheck,
    icon: QualityIcon,
    // 唯一のバッチ処理・唯一の採点なので、既存の基準色をそのまま持たせる
    accent: '#006E80',
  },
  {
    id: 'volume',
    path: '/volume',
    text: volumeText,
    component: VolumeCheck,
    icon: VolumeIcon,
    // 青緑と隣接しつつ明確に別。落ち着いた計測の色
    accent: '#2E4B8F',
  },
  {
    id: 'howling',
    path: '/howling',
    text: howlingText,
    component: HowlingCheck,
    icon: HowlingIcon,
    // 唯一「鳴っている最中に使う」道具なので温度が高い。赤ではないので警告と混ざらない。
    // 琥珀のまま #B86000 だと白地でのコントラストが 4.46 で、戻るボタンの
    // 文字色として 4.5:1 をわずかに割る。一段落として 5.34 にしてある
    accent: '#A85400',
  },
];

export function findFeature(path: string): Feature | undefined {
  return FEATURES.find((f) => f.path === path);
}
