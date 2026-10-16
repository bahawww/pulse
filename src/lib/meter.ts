import type { CSSProperties } from 'react';

/**
 * Style for a .meter-fill or .core-fill showing `percent` (clamped to 0-100).
 * The reading travels as --p; styles.css turns it into a transform, so a new
 * reading animates on the compositor instead of resizing the bar.
 */
export function fill(percent: number, background?: string): CSSProperties {
  const p = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;
  return { '--p': `${p}%`, ...(background ? { background } : {}) } as CSSProperties;
}
