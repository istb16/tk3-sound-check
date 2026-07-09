<script lang="ts">
  import { scoreColor } from './scores.ts';

  interface Point { x: number; y: number; }

  interface Props {
    scores?: Record<string, number>;
    labels?: string[];
    displayLabels?: string[];
    size?: number;
  }

  let { scores = {}, labels = [], displayLabels, size = 260 }: Props = $props();
  const axisLabels = $derived(displayLabels ?? labels);

  const levels = 4;

  function cx(): number { return size / 2; }
  function cy(): number { return size / 2; }
  function r(): number  { return size * 0.36; }

  function toXY(angle: number, radius: number): Point {
    const rad = (angle - 90) * (Math.PI / 180);
    return {
      x: cx() + radius * Math.cos(rad),
      y: cy() + radius * Math.sin(rad),
    };
  }

  function angleStep(): number { return 360 / labels.length; }

  function gridPolygons(): Point[][] {
    return Array.from({ length: levels }, (_, i) => {
      const ratio = (i + 1) / levels;
      return labels.map((_, j) => toXY(j * angleStep(), r() * ratio));
    });
  }

  function axes(): Array<{ end: Point; labelPos: Point; label: string }> {
    return labels.map((_, i) => ({
      end:      toXY(i * angleStep(), r()),
      labelPos: toXY(i * angleStep(), r() * 1.22),
      label:    axisLabels[i] ?? labels[i],
    }));
  }

  function dataPoints(): Point[] {
    return labels.map((key, i) => {
      const val = (scores[key] ?? 0) / 100;
      return toXY(i * angleStep(), r() * Math.max(val, 0.02));
    });
  }

  function polyStr(pts: Point[]): string {
    return pts.map((p) => `${p.x},${p.y}`).join(' ');
  }
</script>

<svg width={size} height={size} viewBox="0 0 {size} {size}" aria-hidden="true">
  {#each gridPolygons() as pts, lvl}
    <polygon
      points={polyStr(pts)}
      fill={lvl === levels - 1 ? '#F3F4FA' : 'none'}
      stroke="#DDE0EE"
      stroke-width="1"
    />
  {/each}

  {#each axes() as ax}
    <line
      x1={cx()} y1={cy()}
      x2={ax.end.x} y2={ax.end.y}
      stroke="#DDE0EE" stroke-width="1"
    />
    <text
      x={ax.labelPos.x}
      y={ax.labelPos.y}
      text-anchor="middle"
      dominant-baseline="middle"
      font-size="10"
      font-weight="600"
      letter-spacing="0.04em"
      fill="#474964"
      font-family="system-ui, sans-serif"
      text-transform="uppercase"
    >{ax.label}</text>
  {/each}

  <polygon
    points={polyStr(dataPoints())}
    fill="rgba(0,110,128,0.12)"
    stroke="#006E80"
    stroke-width="2"
    stroke-linejoin="round"
  />

  {#each dataPoints() as pt, i}
    {@const key = labels[i]}
    {@const val = scores[key] ?? 0}
    <circle cx={pt.x} cy={pt.y} r="4.5" fill={scoreColor(val)} stroke="#FFFFFF" stroke-width="1.5" />
  {/each}
</svg>
