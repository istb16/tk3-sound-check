import { type ScoreAxis } from './AudioAnalyzer.ts';

export type GradeCls = 'good' | 'ok' | 'warn' | 'bad';
export type ScoreLabel = ScoreAxis;

/** 表示順。環境要因(ノイズ・残響)を先に、機材設定を後に置く */
export const LABELS: ScoreLabel[] = ['noise', 'reverb', 'frequency', 'volume', 'clip'];
export const SEGMENTS = 20;

export function gradeCls(v: number): GradeCls {
  if (v >= 70) return 'good';
  if (v >= 50) return 'ok';
  if (v >= 35) return 'warn';
  return 'bad';
}

// Teal/amber/olive/red by score value — shared by VuMeter, Breakdown, RadarChart.
// The colors live in app.css (--score-*) so that they switch with the color scheme;
// these return CSS values, not hex codes.
export function scoreColor(v: number): string {
  return `var(--score-${gradeCls(v)})`;
}

// VU meter segment color by index (0..SEGMENTS-1)
export function segColor(i: number): string {
  if (i < 7)  return 'var(--score-bad)';
  if (i < 10) return 'var(--score-ok)';
  if (i < 14) return 'var(--score-warn)';
  return 'var(--score-good)';
}
