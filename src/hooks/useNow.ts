import { useEffect, useState } from 'react';

/**
 * Date.now(), re-read every `intervalMs` while the tab is visible.
 *
 * It does not tick while the tab is hidden, and after the tab comes back it
 * waits `resumeGraceMs` before ticking. Polling is paused while hidden too, so
 * without the grace a returning tab would compare a fresh clock against an old
 * reading and flash "stale" for the half second the catch-up poll takes.
 */
export function useNow(intervalMs: number, resumeGraceMs = 3000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let grace: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      if (document.visibilityState === 'visible' && grace === null) setNow(Date.now());
    };
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      if (grace) clearTimeout(grace);
      grace = setTimeout(() => {
        grace = null;
        setNow(Date.now());
      }, resumeGraceMs);
    };
    const timer = setInterval(tick, intervalMs);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(timer);
      if (grace) clearTimeout(grace);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [intervalMs, resumeGraceMs]);

  return now;
}
