import { useCallback, useEffect, useState } from 'react';
import { canTransition, transition } from '../lib/motion';

export type Theme = 'dark' | 'light';

/** Where a theme switch was triggered, in viewport pixels. The new theme grows out from here. */
export interface ThemeOrigin {
  readonly x: number;
  readonly y: number;
}

// v2: the default became light, so a theme saved by the old design does not hide it.
const STORAGE_KEY = 'vps_theme_v2';

function readStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    /* private mode */
  }
  return 'light';
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(readStoredTheme);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* private mode */
    }
  }, [theme]);

  const toggleTheme = useCallback((origin?: ThemeOrigin) => {
    const root = document.documentElement;
    const next: Theme = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    // Set the attribute right away: the transition snapshots the DOM as soon as
    // this returns, before React's effect would run.
    const apply = () => {
      root.setAttribute('data-theme', next);
      setTheme(next);
    };

    if (canTransition()) {
      // The new theme is revealed as a circle growing from the button.
      const x = origin?.x ?? window.innerWidth - 40;
      const y = origin?.y ?? 28;
      const r = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
      transition('theme', apply, { '--vt-x': `${x}px`, '--vt-y': `${y}px`, '--vt-r': `${r}px` });
      return;
    }

    // Fallback: cross-fade every colour for a moment, then drop the class so
    // ordinary hover transitions are not slowed down.
    root.classList.add('theme-switching');
    window.setTimeout(() => root.classList.remove('theme-switching'), 380);
    apply();
  }, []);

  return { theme, toggleTheme };
}
