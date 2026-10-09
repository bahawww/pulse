import { type JSX, useMemo } from 'react';

interface SparklineProps {
  readonly values: readonly number[];
  /** Any CSS colour, including `var(--token)`. Set through `style`, so vars resolve. */
  readonly color: string;
  /** Fixed ceiling. Omit to scale to the data. */
  readonly max?: number;
  readonly label: string;
}

const H = 40;
const PAD = 3;

interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * Tiny inline trend for KPI tiles. A non-finite sample breaks the line instead
 * of dropping to zero: an invented zero reads as a real dip.
 */
export function Sparkline({ values, color, max, label }: SparklineProps): JSX.Element {
  const { line, area } = useMemo(() => {
    const n = values.length;
    let top = max ?? 0;
    if (max === undefined) {
      for (const v of values) if (Number.isFinite(v) && v > top) top = v;
    }
    if (top <= 0) top = 1;

    const segments: Point[][] = [];
    let current: Point[] = [];
    values.forEach((v, i) => {
      if (!Number.isFinite(v)) {
        if (current.length > 0) segments.push(current);
        current = [];
        return;
      }
      const x = n > 1 ? (i / (n - 1)) * 100 : 0;
      const y = H - PAD - (Math.min(Math.max(v, 0), top) / top) * (H - PAD * 2);
      current.push({ x, y });
    });
    if (current.length > 0) segments.push(current);

    const linePath = segments
      .map((seg) => seg.map((p, j) => `${j === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(''))
      .join('');

    const areaPath = segments
      .filter((seg) => seg.length > 1)
      .map((seg) => {
        const first = seg[0];
        const last = seg[seg.length - 1];
        if (!first || !last) return '';
        const top = seg.map((p, j) => `${j === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join('');
        return `${top}L${last.x.toFixed(2)},${H}L${first.x.toFixed(2)},${H}Z`;
      })
      .join('');

    return { line: linePath, area: areaPath };
  }, [values, max]);

  return (
    <div className="kpi-spark" role="img" aria-label={label}>
      <svg viewBox={`0 0 100 ${H}`} preserveAspectRatio="none" aria-hidden="true">
        {area && <path d={area} style={{ fill: color }} fillOpacity={0.14} />}
        {line && (
          <path
            d={line}
            fill="none"
            style={{ stroke: color }}
            strokeWidth={1.6}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
    </div>
  );
}
