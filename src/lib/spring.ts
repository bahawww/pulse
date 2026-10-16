/**
 * Damped springs (mass 1) in JS, for motion a finger hands over mid-flight:
 * sheets, the tab bar pill. Same model as scripts/springs.mjs, but this one
 * starts from a velocity, so a flick keeps its speed instead of restarting
 * from rest. The result is a keyframe list for element.animate(), which runs
 * on the compositor like any CSS animation.
 */

export interface Spring {
  /** k: how hard it pulls toward the target. */
  readonly stiffness: number;
  /** c: how quickly the motion bleeds off. c = 2 * sqrt(k) is critically damped. */
  readonly damping: number;
}

export const SPRINGS = {
  /** Sheets settling or dismissing: no visible overshoot, about 450ms. */
  sheet: { stiffness: 300, damping: 33 },
  /** Matches --spring-snappy in motion.css. */
  snappy: { stiffness: 380, damping: 30 },
  /** Matches --spring-bouncy in motion.css. */
  bouncy: { stiffness: 260, damping: 17 },
} as const satisfies Record<string, Spring>;

export interface SpringCurve {
  /** Position at each 1/60 s step, the last one exactly `to`. */
  readonly values: readonly number[];
  /** Velocity (units per second) at each step. */
  readonly velocities: readonly number[];
  readonly durationMs: number;
}

const STEP = 1 / 60;

/** Samples a spring from `from` to `to`, starting at `velocity` units per second. */
export function springCurve(spring: Spring, from: number, to: number, velocity = 0, maxMs = 1500): SpringCurve {
  const w0 = Math.sqrt(spring.stiffness);
  const zeta = spring.damping / (2 * w0);
  const x0 = from - to;
  const v0 = velocity;

  // Displacement and velocity from the target at time t (closed form).
  let at: (t: number) => [number, number];
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    const b = (v0 + zeta * w0 * x0) / wd;
    at = (t) => {
      const e = Math.exp(-zeta * w0 * t);
      const c = Math.cos(wd * t);
      const s = Math.sin(wd * t);
      const x = e * (x0 * c + b * s);
      const v = e * ((b * wd - zeta * w0 * x0) * c - (x0 * wd + zeta * w0 * b) * s);
      return [x, v];
    };
  } else if (zeta === 1) {
    at = (t) => {
      const e = Math.exp(-w0 * t);
      const k = v0 + w0 * x0;
      return [e * (x0 + k * t), e * (k - w0 * (x0 + k * t))];
    };
  } else {
    const r = w0 * Math.sqrt(zeta * zeta - 1);
    const r1 = -zeta * w0 + r;
    const r2 = -zeta * w0 - r;
    const c1 = (v0 - r2 * x0) / (r1 - r2);
    const c2 = x0 - c1;
    at = (t) => [c1 * Math.exp(r1 * t) + c2 * Math.exp(r2 * t), c1 * r1 * Math.exp(r1 * t) + c2 * r2 * Math.exp(r2 * t)];
  }

  // Done when it is within half a unit of rest and barely moving.
  const values: number[] = [];
  const velocities: number[] = [];
  const steps = Math.ceil(maxMs / 1000 / STEP);
  for (let i = 0; i <= steps; i++) {
    const [x, v] = at(i * STEP);
    values.push(to + x);
    velocities.push(v);
    if (i > 2 && Math.abs(x) < 0.5 && Math.abs(v) < 20) break;
  }
  values[values.length - 1] = to;
  velocities[velocities.length - 1] = 0;
  return { values, velocities, durationMs: Math.round((values.length - 1) * STEP * 1000) };
}

/** Keyframes for element.animate(), one per sample. `frame` turns a value into a keyframe. */
export function springKeyframes(curve: SpringCurve, frame: (value: number, velocity: number) => Keyframe): Keyframe[] {
  return curve.values.map((value, i) => frame(value, curve.velocities[i] ?? 0));
}

/**
 * iOS-style rubber band: past an edge, movement gives way less the further it
 * goes, approaching `limit`. Same constant UIScrollView uses.
 */
export function rubberBand(overshoot: number, limit: number): number {
  const sign = Math.sign(overshoot);
  const x = Math.abs(overshoot);
  return sign * (1 - 1 / ((x * 0.55) / limit + 1)) * limit;
}

/** Where a flick would come to rest, with iOS's normal scroll deceleration (0.998 per ms). */
export function project(position: number, velocityPerSecond: number): number {
  const decel = 0.998;
  return position + ((velocityPerSecond / 1000) * decel) / (1 - decel);
}
