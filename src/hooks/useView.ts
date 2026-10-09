import { useEffect, useRef, useState } from 'react';
import { transition } from '../lib/motion';
import { type ViewId, VIEWS, viewFromHash } from '../lib/views';

const order = (id: ViewId) => VIEWS.findIndex((v) => v.id === id);

/**
 * Current view, read from the URL hash. Follows link clicks and the back
 * button. Each switch runs as a View Transition: moving down the menu slides
 * the page up, moving up slides it down (data-vt-dir on <html>).
 */
export function useView(): ViewId {
  const [view, setView] = useState<ViewId>(() => viewFromHash(window.location.hash));
  const viewRef = useRef(view);

  useEffect(() => {
    const onHash = () => {
      const next = viewFromHash(window.location.hash);
      const prev = viewRef.current;
      if (next === prev) return;
      document.documentElement.dataset.vtDir = order(next) > order(prev) ? 'forward' : 'back';
      transition('view', () => {
        viewRef.current = next;
        setView(next);
        window.scrollTo({ top: 0 });
      });
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  return view;
}
