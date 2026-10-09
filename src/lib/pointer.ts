import { prefersReducedMotion } from './motion';

/**
 * Pointer-follow effects, one document listener for the whole app:
 *  - tilt: service cards and the login card lean toward the cursor.
 *  - spotlight: KPI tiles and overview service rows get a soft light that
 *    follows the cursor.
 * Elements only get CSS variables and a class; motion.css draws the effect and
 * springs it back when the pointer leaves. Mouse and trackpad only.
 */

const TILT = '.svc, .login-card';
const SPOTLIGHT = '.kpi, .lamp-row, .card';
const ANY = `${TILT}, ${SPOTLIGHT}`;

export function installPointerEffects(): void {
  if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches || prefersReducedMotion()) return;

  let current: HTMLElement | null = null;
  let last: PointerEvent | null = null;
  let frame = 0;

  const release = (el: HTMLElement) => {
    el.classList.remove('is-tilting', 'is-lit');
    el.style.removeProperty('--rx');
    el.style.removeProperty('--ry');
  };

  const update = () => {
    frame = 0;
    const ev = last;
    if (!ev) return;
    const target = ev.target instanceof Element ? ev.target : null;
    // Innermost match wins, so a KPI tile lights up rather than its card.
    const el = (target?.closest(ANY) as HTMLElement | null) ?? null;
    if (current && current !== el) release(current);
    current = el;
    if (!el) return;

    const r = el.getBoundingClientRect();
    const px = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
    const py = Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height));
    el.style.setProperty('--px', `${(px * 100).toFixed(1)}%`);
    el.style.setProperty('--py', `${(py * 100).toFixed(1)}%`);

    if (el.matches(TILT)) {
      const max = el.classList.contains('login-card') ? 3 : 6;
      el.style.setProperty('--rx', `${((0.5 - py) * max).toFixed(2)}deg`);
      el.style.setProperty('--ry', `${((px - 0.5) * max).toFixed(2)}deg`);
      el.classList.add('is-tilting');
    } else {
      el.classList.add('is-lit');
    }
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
