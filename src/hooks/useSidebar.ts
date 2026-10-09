import { useCallback, useEffect, useLayoutEffect, useState } from 'react';

// v2: the default changed to minimized, so browsers that saved "open" under the old key start over.
const STORAGE_KEY = 'vps_sidebar_v2';

function readStoredOpen(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'open';
  } catch {
    /* private mode */
  }
  return false;
}

/** Desktop sidebar visibility. Minimized by default; the choice is remembered in this browser. */
export function useSidebar() {
  const [open, setOpen] = useState<boolean>(readStoredOpen);

  // The layout reads this (html[data-sidebar] in styles.css) to size the left
  // column. Set before paint, so the page never renders at the wrong offset.
  useLayoutEffect(() => {
    document.documentElement.dataset.sidebar = open ? 'open' : 'closed';
  }, [open]);
  useLayoutEffect(() => () => void delete document.documentElement.dataset.sidebar, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, open ? 'open' : 'closed');
    } catch {
      /* private mode */
    }
  }, [open]);

  const toggleSidebar = useCallback(() => {
    setOpen((prev) => !prev);
  }, []);

  return { sidebarOpen: open, toggleSidebar };
}
