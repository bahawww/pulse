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

/**
 * Runs a React state update inside a View Transition. The update is flushed
 * synchronously so the browser snapshots the finished DOM. `kind` lands on
 * <html data-vt>, `vars` on <html style>, for the duration of the transition.
 * Without support (or with reduced motion) the update simply runs.
 */
export function transition(kind: TransitionKind, update: () => void, vars: Record<string, string> = {}): void {
  if (!canTransition()) {
    update();
    return;
  }
  const root = document.documentElement;
  root.dataset.vt = kind;
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  const vt = (document as DocumentWithTransitions).startViewTransition?.(() => flushSync(update));
  void vt?.finished.finally(() => {
    if (root.dataset.vt === kind) delete root.dataset.vt;
  });
}
