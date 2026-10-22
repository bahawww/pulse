import { prefersReducedMotion } from './motion';

/**
 * Pointer-follow tilt, one document listener for the whole app: service
 * cards and the login card lean toward the cursor.
 * Elements only get CSS variables and a class; motion.css draws the effect and
 * springs it back when the pointer leaves. Mouse and trackpad only.
 */

const TILT = '.svc, .login-card';

/**
 * iOS Safari applies :active (the pressed look every control gets in
 * motion.css) only when a touch listener exists. A passive no-op is enough:
 * passive listeners never hold up scrolling.
 */
export function installTouchFeedback(): void {
  document.addEventListener('touchstart', () => undefined, { passive: true });
}

export function installPointerEffects(): void {
  if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches || prefersReducedMotion()) return;

  let current: HTMLElement | null = null;
  let last: PointerEvent | null = null;
  let frame = 0;

  const release = (el: HTMLElement) => {
    el.classList.remove('is-tilting');
    el.style.removeProperty('--rx');
    el.style.removeProperty('--ry');
  };

  const update = () => {
    frame = 0;
    const ev = last;
    if (!ev) return;
    const target = ev.target instanceof Element ? ev.target : null;
    const el = (target?.closest(TILT) as HTMLElement | null) ?? null;
    if (current && current !== el) release(current);
    current = el;
    if (!el) return;

    const r = el.getBoundingClientRect();
    const px = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
    const py = Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height));

    const max = el.classList.contains('login-card') ? 3 : 6;
    el.style.setProperty('--rx', `${((0.5 - py) * max).toFixed(2)}deg`);
    el.style.setProperty('--ry', `${((px - 0.5) * max).toFixed(2)}deg`);
    el.classList.add('is-tilting');
  };

  document.addEventListener(
    'pointermove',
    (ev) => {
      if (ev.pointerType !== 'mouse') return;
      last = ev;
      if (!frame) frame = requestAnimationFrame(update);
    },
    { passive: true },
  );

  document.documentElement.addEventListener('pointerleave', () => {
    if (current) release(current);
    current = null;
  });
}
