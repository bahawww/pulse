import { useCallback, useEffect, useLayoutEffect, useState } from 'react';

// v3: the default changed back to the full sidebar, so browsers that saved the old minimized default start over.
const STORAGE_KEY = 'vps_sidebar_v3';

function readStoredOpen(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'closed';
  } catch {
    /* private mode */
  }
  return true;
}

/** Desktop sidebar visibility. Full (every view labelled) by default; the choice is remembered in this browser. */
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
