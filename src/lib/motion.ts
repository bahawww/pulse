import { flushSync } from 'react-dom';

/**
 * Motion helpers shared by the app and the login page. CSS does the actual
 * animating (src/motion.css); this file only decides when a View Transition
 * runs and tags <html> so the CSS can pick the right choreography.
 */

type TransitionKind = 'view' | 'theme' | 'login' | 'filter';

interface ViewTransitionLike {
  readonly finished: Promise<void>;
}

type DocumentWithTransitions = Document & {
  startViewTransition?: (update: () => void) => ViewTransitionLike;
};

export function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** True when the browser can morph between two DOM states and motion is welcome. */
export function canTransition(): boolean {
  return typeof (document as DocumentWithTransitions).startViewTransition === 'function' && !prefersReducedMotion();
}

/** Bumped per transition, so a finished one never clears the tags of the one that replaced it. */
let current = 0;

/**
 * Runs a React state update inside a View Transition. The update is flushed
 * synchronously so the browser snapshots the finished DOM. `kind` lands on
 * <html data-vt>, `vars` on <html style>, for the duration of the transition.
 * <html data-vt-new> is set once the old state is captured, so CSS can name an
 * element in the old state only: phones snapshot just the outgoing page and
 * let the incoming one animate live (motion.css, section 4).
 * Without support (or with reduced motion) the update simply runs.
 */
export function transition(kind: TransitionKind, update: () => void, vars: Record<string, string> = {}): void {
  // A card shuffle is not worth it on a phone: the glass bars would be redrawn as flat rectangles for the length of it.
  if (!canTransition() || (kind === 'filter' && isCompact())) {
    update();
    return;
  }
  const root = document.documentElement;
  const mine = ++current;
  root.dataset.vt = kind;
  delete root.dataset.vtNew;
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  const vt = (document as DocumentWithTransitions).startViewTransition?.(() => {
    root.dataset.vtNew = '';
    flushSync(update);
  });
  void vt?.finished.finally(() => {
    if (current !== mine) return;
    delete root.dataset.vt;
    delete root.dataset.vtNew;
  });
}

/** True where the phone layout applies: no sidebar, tab bar at the bottom (mobile.css). */
export function isCompact(): boolean {
  return window.matchMedia('(max-width: 1023px)').matches;
}
