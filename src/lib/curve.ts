/**
 * Smooth SVG paths through data points without inventing data.
 *
 * Monotone cubic interpolation (Fritsch–Carlson, the same as d3's
 * curveMonotoneX): corners are rounded, but between two samples the curve
 * never rises above the higher one or dips below the lower one. A plain
 * Catmull-Rom or Bézier smoothing would overshoot, drawing peaks that never
 * happened and dips below 0%.
 */

export interface Pt {
  readonly x: number;
  readonly y: number;
}

const f = (n: number): string => n.toFixed(2);

/** Path data for one run of points, x increasing. Starts with M. */
export function monotonePath(pts: readonly Pt[]): string {
  const n = pts.length;
  if (n === 0) return '';
  const p0 = pts[0] as Pt;
  if (n === 1) return `M${f(p0.x)},${f(p0.y)}`;
  if (n === 2) {
    const p1 = pts[1] as Pt;
    return `M${f(p0.x)},${f(p0.y)}L${f(p1.x)},${f(p1.y)}`;
  }

  // Secant slopes between neighbours.
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const a = pts[i] as Pt;
    const b = pts[i + 1] as Pt;
    const dx = b.x - a.x;
    d.push(dx === 0 ? 0 : (b.y - a.y) / dx);
  }

  // Tangents: zero at local extrema, harmonic-style blend elsewhere.
  const m: number[] = new Array<number>(n);
  m[0] = d[0] as number;
  m[n - 1] = d[n - 2] as number;
  for (let i = 1; i < n - 1; i++) {
    const s0 = d[i - 1] as number;
    const s1 = d[i] as number;
    m[i] = s0 * s1 <= 0 ? 0 : (s0 + s1) / 2;
  }
  // Fritsch–Carlson limit, so no segment overshoots.
  for (let i = 0; i < n - 1; i++) {
    const s = d[i] as number;
    if (s === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = (m[i] as number) / s;
    const b = (m[i + 1] as number) / s;
    const h = a * a + b * b;
    if (h > 9) {
      const t = 3 / Math.sqrt(h);
      m[i] = t * a * s;
      m[i + 1] = t * b * s;
    }
  }

  let out = `M${f(p0.x)},${f(p0.y)}`;
  for (let i = 0; i < n - 1; i++) {
    const a = pts[i] as Pt;
    const b = pts[i + 1] as Pt;
    const dx = (b.x - a.x) / 3;
    out += `C${f(a.x + dx)},${f(a.y + (m[i] as number) * dx)},${f(b.x - dx)},${f(b.y - (m[i + 1] as number) * dx)},${f(b.x)},${f(b.y)}`;
  }
  return out;
}

/** Narrowest scale, in percentage points: below this, noise would look like drama. */
const MIN_SPAN = 8;

/**
 * Scale fitted to the window instead of fixed at 0-100: the bottom and top hug
 * the lowest and highest reading with some headroom, rounded to a step that
 * keeps the middle label a whole number. Stays inside 0-100%.
 */
export function fitScale(values: readonly number[]): { lo: number; hi: number } {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = Math.max(1, (max - min) * 0.15);
  const raw = Math.max(MIN_SPAN, max - min + pad * 2);
  const step = raw <= 10 ? 2 : raw <= 30 ? 5 : raw <= 60 ? 10 : 20;
  let lo = Math.max(0, Math.floor((min - pad) / step) * step);
  let hi = Math.min(100, Math.ceil((max + pad) / step) * step);
  while (hi - lo < MIN_SPAN) {
    if (hi < 100) hi += step;
    else lo = Math.max(0, lo - step);
  }
  // An even number of steps puts the middle gridline on a whole step.
  if (((hi - lo) / step) % 2 === 1) {
    if (hi + step <= 100) hi += step;
    else lo = Math.max(0, lo - step);
  }
  return { lo, hi };
}
