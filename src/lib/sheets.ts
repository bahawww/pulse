import { prefersReducedMotion } from './motion';
import { SPRINGS, project, rubberBand, springCurve, springKeyframes } from './spring';

/**
 * Menus as iOS sheets. Below 641px every `.pop` (alerts, profile, select
 * menus) is drawn as a bottom sheet by mobile.css; this adds what CSS cannot:
 *
 *  - Drag to dismiss. The sheet follows the finger 1:1 once its content is
 *    scrolled to the top, rubber-bands when pulled up, and on release either
 *    springs back or leaves with the flick's own speed (lib/spring.ts). A
 *    sheet still moving can be caught again mid-flight.
 *  - An exit for every `.pop`, on any screen. React removes a closed menu at
 *    once, so a copy takes its place for the leave animation (.is-leaving in
 *    mobile.css), then goes. Components need no exit state of their own.
 *
 * Closing goes through the menu's own `.pop-backdrop` (each menu renders one
 * right before the `.pop`, and clicking it closes), so React state stays the
 * single source of truth.
 *
 * Touch listeners sit on each sheet, not on the document: a blocking
 * touchmove listener on the document would make every scroll on the page wait
 * for the main thread.
 */

const SHEET_MEDIA = '(max-width: 640px)';
/** Pixels of travel before a touch counts as a drag rather than a tap. */
const SLOP = 6;

interface Drag {
  readonly backdrop: HTMLElement | null;
  /** Distance that takes the sheet's top edge below the screen. */
  readonly travel: number;
  readonly startX: number;
  /** The grabber strip at the top always drags, even over scrolled content. */
  readonly fromGrabber: boolean;
  startY: number;
  base: number;
  lastY: number;
  lastT: number;
  velocity: number;
  offset: number;
  active: boolean;
}

const drags = new WeakMap<HTMLElement, Drag>();
/** Sheets flying off after a flick: no longer draggable. */
const leaving = new WeakSet<HTMLElement>();

const sheetMode = (): boolean => window.matchMedia(SHEET_MEDIA).matches;

function translateY(el: HTMLElement): number {
  const t = getComputedStyle(el).transform;
  return t && t !== 'none' ? new DOMMatrixReadOnly(t).m42 : 0;
}

function setOffset(sheet: HTMLElement, d: Drag, offset: number): void {
  d.offset = offset;
  sheet.style.transform = `translate3d(0, ${offset}px, 0)`;
  if (d.backdrop) d.backdrop.style.opacity = String(1 - Math.min(1, Math.max(0, offset / d.travel)) * 0.9);
}

function settle(sheet: HTMLElement, d: Drag): void {
  const v = d.velocity;
  const rest = project(d.offset, v);
  const leave = d.offset > 0 && (rest > d.travel * 0.45 || (v > 650 && d.offset > 20));
  const target = leave ? d.travel : 0;
  const curve = springCurve(SPRINGS.sheet, d.offset, target, v);
  const anim = sheet.animate(
    springKeyframes(curve, (y) => ({ transform: `translate3d(0, ${y}px, 0)` })),
    { duration: curve.durationMs, easing: 'linear' },
  );
  const fade = d.backdrop?.animate([{ opacity: d.backdrop.style.opacity || '1' }, { opacity: leave ? '0' : '1' }], {
    duration: Math.min(curve.durationMs, 300),
    easing: 'ease-out',
    fill: 'forwards',
  });
  if (leave) leaving.add(sheet);
  anim.onfinish = () => {
    if (leave) {
      // Already off screen: close for real, and keep the exit copy out of it.
      sheet.style.transform = `translate3d(0, ${target}px, 0)`;
      sheet.dataset.dismissed = '';
      if (d.backdrop) d.backdrop.dataset.dismissed = '';
      d.backdrop?.click();
    } else {
      sheet.style.transform = '';
      if (d.backdrop) d.backdrop.style.opacity = '';
      fade?.cancel();
    }
    anim.cancel();
  };
}

function attach(sheet: HTMLElement): void {
  if (drags.has(sheet)) return;

  sheet.addEventListener(
    'touchstart',
    (e) => {
      const touch = e.touches[0];
      if (e.touches.length !== 1 || !touch || !sheetMode() || leaving.has(sheet)) {
        drags.delete(sheet);
        return;
      }
      const box = sheet.getBoundingClientRect();
      const prev = sheet.previousElementSibling;
      drags.set(sheet, {
        backdrop: prev instanceof HTMLElement && prev.matches('.pop-backdrop') ? prev : null,
        travel: Math.max(1, window.innerHeight - box.top + translateY(sheet) + 12),
        startX: touch.clientX,
        fromGrabber: touch.clientY - box.top < 28,
        startY: touch.clientY,
        base: 0,
        lastY: touch.clientY,
        lastT: e.timeStamp,
        velocity: 0,
        offset: 0,
        active: false,
      });
    },
    { passive: true },
  );

  sheet.addEventListener(
    'touchmove',
    (e) => {
      const d = drags.get(sheet);
      const touch = e.touches[0];
      if (!d || !touch) return;
      const dy = touch.clientY - d.startY;

      if (!d.active) {
        if (Math.abs(touch.clientX - d.startX) > Math.abs(dy) + SLOP) {
          drags.delete(sheet); // sideways: a horizontal scroller inside gets it
          return;
        }
        if (Math.abs(dy) < SLOP) return;
        const atTop = sheet.scrollTop <= 0;
        const scrollable = sheet.scrollHeight > sheet.clientHeight + 1;
        // Down at the top of the content (or on the grabber) moves the sheet;
        // up moves it only when there is nothing to scroll.
        if (!(d.fromGrabber || (dy > 0 && atTop) || (dy < 0 && !scrollable))) {
          drags.delete(sheet);
          return;
        }
        // Caught mid-flight (opening, or springing back): carry on from where it is.
        d.base = translateY(sheet);
        sheet.getAnimations().forEach((a) => a.cancel());
        d.backdrop?.getAnimations().forEach((a) => a.cancel());
        d.active = true;
        d.startY = touch.clientY;
        sheet.classList.add('is-dragging');
      }

      if (e.cancelable) e.preventDefault();
      const raw = d.base + touch.clientY - d.startY;
      setOffset(sheet, d, raw >= 0 ? raw : rubberBand(raw, 80));
      const dt = Math.max(1, e.timeStamp - d.lastT);
      d.velocity = d.velocity * 0.25 + ((touch.clientY - d.lastY) / dt) * 1000 * 0.75;
      d.lastY = touch.clientY;
      d.lastT = e.timeStamp;
    },
    { passive: false },
  );

  const end = (e: TouchEvent) => {
    const d = drags.get(sheet);
    if (!d || e.touches.length > 0) return;
    drags.delete(sheet);
    if (!d.active) return;
    sheet.classList.remove('is-dragging');
    // A finger that stopped before lifting has no speed left to hand over.
    if (e.timeStamp - d.lastT > 80) d.velocity = 0;
    settle(sheet, d);
  };
  sheet.addEventListener('touchend', end, { passive: true });
  sheet.addEventListener('touchcancel', end, { passive: true });
}

/** Plays the leave animation on a copy of a menu React just removed. */
function ghost(removed: HTMLElement, parent: Node, next: Node | null): void {
  const copy = removed.cloneNode(true) as HTMLElement;
  copy.classList.add('is-leaving');
  copy.setAttribute('aria-hidden', 'true');
  copy.inert = true;
  for (const el of [copy, ...copy.querySelectorAll('[id]')]) el.removeAttribute('id');
  parent.insertBefore(copy, next && next.parentNode === parent ? next : null);
  const done = () => copy.remove();
  copy.addEventListener('animationend', (ev) => ev.target === copy && done());
  window.setTimeout(done, 700);
}

export function installSheets(): void {
  const observer = new MutationObserver((records) => {
    const reduced = prefersReducedMotion();
    const sheets = sheetMode();
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof HTMLElement) || node.matches('.is-leaving')) continue;
        if (node.matches('.pop')) attach(node);
        else if (node.firstElementChild) node.querySelectorAll<HTMLElement>('.pop').forEach(attach);
      }
      if (reduced || !record.target.isConnected) continue;
      for (const node of record.removedNodes) {
        if (!(node instanceof HTMLElement) || node.matches('.is-leaving') || node.dataset.dismissed !== undefined) continue;
        // The backdrop only shows (and so only fades) where menus are sheets.
        if (node.matches('.pop') || (sheets && node.matches('.pop-backdrop'))) ghost(node, record.target, record.nextSibling);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
