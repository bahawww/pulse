import { type JSX, useEffect, useRef } from 'react';
import { prefersReducedMotion } from '../lib/motion';

interface AnimatedNumberProps {
  readonly value: number;
  readonly format: (value: number) => string;
  readonly duration?: number;
  readonly className?: string;
}

/**
 * A number that glides to each new reading instead of jumping. Counts up from
 * zero on first show. Each frame writes straight into the span's text node:
 * React renders the span once per reading, not once per frame, and the node
 * stays the one React owns, so its next render lands in the same place.
 */
export function AnimatedNumber({ value, format, duration = 700, className }: AnimatedNumberProps): JSX.Element {
  const spanRef = useRef<HTMLSpanElement>(null);
  const currentRef = useRef(0);
  const formatRef = useRef(format);
  formatRef.current = format;

  useEffect(() => {
    const write = (n: number) => {
      currentRef.current = n;
      const span = spanRef.current;
      if (!span) return;
      const text = formatRef.current(n);
      const node = span.firstChild;
      if (node && node.nodeType === Node.TEXT_NODE) {
        if (node.nodeValue !== text) node.nodeValue = text;
      } else span.textContent = text;
    };

    if (!Number.isFinite(value) || prefersReducedMotion()) {
      write(value);
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
      write(Number.isFinite(raw) ? raw : value);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);

  return (
    <span ref={spanRef} className={className}>
      {format(currentRef.current)}
    </span>
  );
}
