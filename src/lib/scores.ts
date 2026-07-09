export type GradeCls = 'good' | 'ok' | 'warn' | 'bad';

export const SEGMENTS = 20;

export function gradeCls(v: number): GradeCls {
  if (v >= 70) return 'good';
  if (v >= 50) return 'ok';
  if (v >= 35) return 'warn';
  return 'bad';
}

// Teal/amber/olive/red by score value — shared by VuMeter, Breakdown, RadarChart
export function scoreColor(v: number): string {
  if (v >= 70) return '#006E80';
  if (v >= 50) return '#B86000';
  if (v >= 35) return '#5A7800';
  return '#BF0009';
}

// VU meter segment color by index (0..SEGMENTS-1)
export function segColor(i: number): string {
  if (i < 7)  return '#BF0009';
  if (i < 10) return '#B86000';
  if (i < 14) return '#5A7800';
  return '#006E80';
}
