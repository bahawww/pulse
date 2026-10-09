import { type JSX, useEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from '../lib/motion';

interface AnimatedNumberProps {
  readonly value: number;
  readonly format: (value: number) => string;
  readonly duration?: number;
  readonly className?: string;
}

/**
 * A number that glides to each new reading instead of jumping. Counts up from
 * zero on first show. Only this span re-renders while it moves.
 */
export function AnimatedNumber({ value, format, duration = 700, className }: AnimatedNumberProps): JSX.Element {
  const [shown, setShown] = useState(0);
  const currentRef = useRef(0);

  useEffect(() => {
    if (!Number.isFinite(value) || prefersReducedMotion()) {
      currentRef.current = value;
      setShown(value);
      return undefined;
    }
    const from = Number.isFinite(currentRef.current) ? currentRef.current : value;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      // Clamped at both ends: a frame's timestamp can be earlier than `start`
      // (rAF reports when the frame began), and a negative p would extrapolate
      // the curve into huge numbers that then become the next animation's start.
      const p = Math.min(1, Math.max(0, (now - start) / duration));
      // Ease-out quint: fast start, long soft landing.
      const eased = 1 - (1 - p) ** 5;
      const raw = from + (value - from) * eased;
      const next = Number.isFinite(raw) ? raw : value;
      currentRef.current = next;
      setShown(next);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);

  return <span className={className}>{format(shown)}</span>;
}
