import { type JSX, type MouseEvent, type RefObject, useLayoutEffect, useRef } from 'react';
import { prefersReducedMotion } from '../lib/motion';
import { SPRINGS, type SpringCurve, springCurve, springKeyframes } from '../lib/spring';
import { TERMINAL_GROUP, VIEW_GROUPS, type ViewId, groupTarget, noteView } from '../lib/views';
import { ViewIcon } from './icons';

/**
 * Phone and tablet navigation, iOS style (below 1024px, where the sidebar is
 * hidden; mobile.css draws both):
 *
 *  - TabBar: a floating glass bar at the bottom, one tab per sidebar group
 *    (three). A group tab returns to the view last opened in it, the way iOS
 *    tabs keep their place; tapping the current tab scrolls to the top. The
 *    chat button floats beside it (ChatFab).
 *  - ScopeBar: under the top bar, a segmented control for the views inside the
 *    current group (Trends | Hardware | Workload | Capacity). The Operations
 *    one ends with Terminal, which opens the terminal overlay.
 *
 * Both read VIEW_GROUPS, already narrowed to what this login may open. Each
 * has one highlight that flies between items on a spring (useGlider).
 */

/** Labels too long for a segment. */
const SHORT: Partial<Record<ViewId, string>> = { 'logs-and-control': 'Logs' };

const STEP_MS = 1000 / 60;

/** Where the items sit. They share one width (flex: 1), so item i is at x0 + i * step. */
interface Geometry {
  readonly x0: number;
  readonly y0: number;
  readonly step: number;
  readonly w: number;
  readonly h: number;
}

interface Glide {
  x: number | null;
  anim: Animation | null;
  curve: SpringCurve | null;
  geo: Geometry | null;
}

/**
 * Places `pill` behind the list item marked data-active="true" and flies it
 * there when the active item changes: a spring on the compositor that starts
 * from wherever a previous flight was, keeps its speed, and stretches a little
 * with it, like iOS 26's tab bar lens.
 *
 * Geometry is measured only in the ResizeObserver callback, which runs after
 * layout, so reading it there costs nothing. A change of active item (inside
 * a view transition's synchronous update) never forces a layout.
 */
function useGlider(listRef: RefObject<HTMLElement | null>, activeKey: string): RefObject<HTMLSpanElement | null> {
  const pillRef = useRef<HTMLSpanElement>(null);
  const glide = useRef<Glide>({ x: null, anim: null, curve: null, geo: null });

  useLayoutEffect(() => {
    const list = listRef.current;
    const pill = pillRef.current;
    const st = glide.current;
    if (!list || !pill) {
      // Hidden (a group of one): the next showing starts in place, not from a stale spot.
      st.x = null;
      st.geo = null;
      return undefined;
    }

    const place = (animate: boolean) => {
      const items = [...list.querySelectorAll<HTMLElement>('[data-active]')];
      const index = items.findIndex((el) => el.dataset.active === 'true');
      if (index < 0) {
        pill.style.opacity = '0';
        st.x = null;
        return;
      }
      const geo = st.geo;
      if (!geo) return; // first showing: the observer places it once laid out
      const x = geo.x0 + index * geo.step;
      const y = geo.y0;
      pill.style.opacity = '';
      pill.style.width = `${geo.w}px`;
      pill.style.height = `${geo.h}px`;
      pill.style.transform = `translate3d(${x}px, ${y}px, 0)`;

      if (animate && st.x !== null && st.x !== x && !prefersReducedMotion()) {
        let from = st.x;
        let velocity = 0;
        if (st.anim?.playState === 'running' && st.curve) {
          const i = Math.min(st.curve.values.length - 1, Math.floor(Number(st.anim.currentTime ?? 0) / STEP_MS));
          from = st.curve.values[i] ?? from;
          velocity = st.curve.velocities[i] ?? 0;
        }
        st.anim?.cancel();
        const curve = springCurve(SPRINGS.snappy, from, x, velocity);
        st.curve = curve;
        st.anim = pill.animate(
          springKeyframes(curve, (v, speed) => ({
            transform: `translate3d(${v}px, ${y}px, 0) scale(${1 + Math.min(0.2, Math.abs(speed) / 6000)}, ${1 - Math.min(0.08, Math.abs(speed) / 15000)})`,
          })),
          { duration: curve.durationMs, easing: 'linear' },
        );
      }
      st.x = x;
    };

    place(true);
    // Measure (and re-place without flying) whenever the bar is laid out anew:
    // first showing, rotation, late fonts.
    const observer = new ResizeObserver(() => {
      const items = list.querySelectorAll<HTMLElement>('[data-active]');
      const first = items[0];
      if (!first) return;
      const second = items[1];
      st.geo = {
        x0: first.offsetLeft,
        y0: first.offsetTop,
        step: second ? second.offsetLeft - first.offsetLeft : first.offsetWidth,
        w: first.offsetWidth,
        h: first.offsetHeight,
      };
      place(false);
    });
    observer.observe(list);
    return () => observer.disconnect();
  }, [listRef, activeKey]);

  return pillRef;
}

/** Tapping the tab you are on goes back to the top, as on iOS. */
function scrollTopIfCurrent(e: MouseEvent<HTMLAnchorElement>, current: boolean): void {
  if (!current) return;
  e.preventDefault();
  window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'instant' : 'smooth' });
}

interface TabBarProps {
  readonly active: ViewId;
  /** A shell is still running behind the hidden terminal: its group's tab shows a dot. */
  readonly terminalRunning?: boolean;
}

export function TabBar({ active, terminalRunning = false }: TabBarProps): JSX.Element | null {
  const listRef = useRef<HTMLDivElement>(null);
  const groups = VIEW_GROUPS;
  const current = groups.find((g) => g.items.some((i) => i.id === active));
  noteView(active);
  const pillRef = useGlider(listRef, current?.title ?? '');

  // Room for the bar at the bottom of the page (mobile.css reads html[data-tabbar]).
  const shown = groups.length > 1;
  useLayoutEffect(() => {
    if (!shown) return undefined;
    document.documentElement.dataset.tabbar = '';
    return () => void delete document.documentElement.dataset.tabbar;
  }, [shown]);

  if (!shown) return null;

  return (
    <nav className="tabbar" aria-label="Sections">
      <div className="tabbar-list" ref={listRef}>
        <span className="tabbar-pill" ref={pillRef} aria-hidden="true" />
        {groups.map((group) => {
          const first = group.items[0];
          if (!first) return null;
          const on = group === current;
          const target = groupTarget(group);
          return (
            <a
              key={group.title}
              href={`#${target}`}
              className={`tabbar-item${on ? ' is-active' : ''}`}
              data-active={on}
              aria-current={on ? 'page' : undefined}
              onClick={(e) => scrollTopIfCurrent(e, on && target === active)}
            >
              <span className="tabbar-icon">
                <ViewIcon view={first.id} size={22} />
                {terminalRunning && group.title === TERMINAL_GROUP && <span className="tabbar-dot" aria-hidden="true" />}
              </span>
              <span className="tabbar-label">{group.title}</span>
            </a>
          );
        })}
      </div>
    </nav>
  );
}

interface ScopeBarProps {
  readonly active: ViewId;
  /** The desktop copy in the top bar, shown while the sidebar is collapsed (styles.css). */
  readonly inline?: boolean;
  /** Opens the terminal; absent when this login may not. Offered in TERMINAL_GROUP. */
  readonly onOpenTerminal?: () => void;
  /** Starts fetching the terminal's code the moment a finger lands on it. */
  readonly onWarmTerminal?: () => void;
  readonly terminalRunning?: boolean;
}

/**
 * Segmented control for the views inside the current group; nothing for a group
 * of one. Phones show it under the top bar; `inline` is the desktop copy.
 */
export function ScopeBar({ active, inline = false, onOpenTerminal, onWarmTerminal, terminalRunning = false }: ScopeBarProps): JSX.Element | null {
  const listRef = useRef<HTMLDivElement>(null);
  const group = VIEW_GROUPS.find((g) => g.items.some((i) => i.id === active));
  const pillRef = useGlider(listRef, active);
  const terminal = !!onOpenTerminal && group?.title === TERMINAL_GROUP;
  if (!group || group.items.length + (terminal ? 1 : 0) < 2) return null;

  return (
    <nav className={`scopebar${inline ? ' is-inline' : ''}`} aria-label={`${group.title} views`}>
      <div className="scopebar-list" ref={listRef}>
        <span className="scopebar-pill" ref={pillRef} aria-hidden="true" />
        {group.items.map((item) => {
          const on = item.id === active;
          return (
            <a
              key={item.id}
              href={`#${item.id}`}
              className={`scopebar-item${on ? ' is-active' : ''}`}
              data-active={on}
              aria-current={on ? 'page' : undefined}
              onClick={(e) => scrollTopIfCurrent(e, on)}
            >
              {SHORT[item.id] ?? item.label}
            </a>
          );
        })}
        {terminal && (
          <button
            type="button"
            className="scopebar-item scopebar-action"
            data-active={false}
            onPointerDown={onWarmTerminal}
            onClick={onOpenTerminal}
            aria-label={terminalRunning ? 'Terminal, session running' : 'Terminal'}
          >
            Terminal
            {terminalRunning && <span className="scopebar-dot" aria-hidden="true" />}
          </button>
        )}
      </div>
    </nav>
  );
}
