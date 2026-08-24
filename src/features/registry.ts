/**
 * 機能の一覧。
 *
 * 機能を1つ足すときに触るのはこのファイルだけになるようにしている——
 * `src/features/<名前>/` にコンポーネントと i18n.ts を置き、ここに1行足す。
 * メニューのタイルもルーティングも、この配列から導出される。
 */

import type { Component } from 'svelte';
import type { Lang } from '../shell/i18n.ts';

import QualityCheck from './quality/QualityCheck.svelte';
import HowlingCheck from './howling/HowlingCheck.svelte';
import VolumeCheck from './volume/VolumeCheck.svelte';

import { T as qualityText } from './quality/i18n.ts';
import { T as howlingText } from './howling/i18n.ts';
import { T as volumeText } from './volume/i18n.ts';

/** 'coming-soon' は「作ると決めているが、まだ無い」。作らないものはここに載せない */
export type FeatureStatus = 'ready' | 'coming-soon';

export interface FeatureText {
  name: string;
  summary: string;
}

export interface Feature {
  id: string;
  /** URL。ルーターはこれで引く */
  path: string;
  status: FeatureStatus;
  /** 名前と一行説明は機能側の i18n が持つ。シェルは機能の文言を知らない */
  text: Record<Lang, FeatureText>;
  component: Component<{ lang: Lang }>;
}

export const FEATURES: Feature[] = [
  {
    id: 'quality',
    path: '/quality',
    status: 'ready',
    text: qualityText,
    component: QualityCheck,
  },
  {
    id: 'howling',
    path: '/howling',
    status: 'coming-soon',
    text: howlingText,
    component: HowlingCheck,
  },
  {
    id: 'volume',
    path: '/volume',
    status: 'coming-soon',
    text: volumeText,
    component: VolumeCheck,
  },
];

export function findFeature(path: string): Feature | undefined {
  return FEATURES.find((f) => f.path === path);
}
