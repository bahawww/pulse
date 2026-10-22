import { type CSSProperties, type JSX, type RefObject, useLayoutEffect, useRef, useState } from 'react';
import { VIEW_GROUPS, type ViewId, groupIcon, groupTarget, noteView, shortcutLabel } from '../lib/views';
import { PanelLeftIcon, ViewIcon } from './icons';
import { BrandMark } from './Navbar';

interface PillBox {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Where the highlight behind the active link sits, measured from the DOM. One
 * pill is drawn per menu and springs from link to link (motion.css), the way an
 * iOS segmented control slides, instead of each link lighting up on its own.
 * The pill lives inside the same scrolling list as the links, so it scrolls with them.
 */
function useActivePill(listRef: RefObject<HTMLElement | null>, active: ViewId): PillBox | null {
  const [box, setBox] = useState<PillBox | null>(null);

  useLayoutEffect(() => {
    const measure = () => {
      const link = listRef.current?.querySelector<HTMLElement>('[aria-current="page"]');
      setBox(link ? { top: link.offsetTop, left: link.offsetLeft, width: link.offsetWidth, height: link.offsetHeight } : null);
    };
    measure();
    // Re-measure when the menu reflows (late web fonts, window resize).
    const observer = new ResizeObserver(measure);
    if (listRef.current) observer.observe(listRef.current);
    return () => observer.disconnect();
  }, [listRef, active]);

  return box;
}

const pillStyle = (box: PillBox): CSSProperties => ({
  width: box.width,
  height: box.height,
  transform: `translate(${box.left}px, ${box.top}px)`,
});

/** Stagger index for the entrance animation. */
const nth = (i: number): CSSProperties => ({ '--i': i }) as CSSProperties;

interface SidebarProps {
  readonly active: ViewId;
  readonly onToggle: () => void;
}

/**
 * Left menu on desktop: pinned to the left edge, full height. The brand sits in
 * its head at the same height as the top bar, then one link per view grouped by
 * topic, then a short keyboard hint. Hidden below 1024px, where the navbar's
 * view menu takes over.
 */
export function Sidebar({ active, onToggle }: SidebarProps): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);
  const pill = useActivePill(listRef, active);

  return (
    <nav className="sidebar" aria-label="Dashboard views">
      <div className="sidebar-head">
        <a href="#overview" className="brand side-brand" aria-label="Pulse home">
          <BrandMark />
          <span className="brand-name">Pulse</span>
        </a>
        <button type="button" className="side-collapse" onClick={onToggle} aria-expanded={true} aria-label="Collapse sidebar" title="Collapse sidebar ([)">
          <PanelLeftIcon size={16} />
        </button>
      </div>

      <div className="side-scroll" ref={listRef}>
        {pill && <span className="side-pill" style={pillStyle(pill)} aria-hidden="true" />}
        {VIEW_GROUPS.map((group, g) => (
          <div className="side-group" key={group.title} style={nth(g)}>
            {/* A group of one whose title repeats its only link would read twice. */}
            {!(group.items.length === 1 && group.items[0]?.label === group.title) && <p className="side-title">{group.title}</p>}
            {group.items.map((item) => {
              const current = item.id === active;
              return (
                <a
                  key={item.id}
                  href={`#${item.id}`}
                  className={`side-link${current ? ' is-active' : ''}`}
                  aria-current={current ? 'page' : undefined}
                  aria-keyshortcuts={`G ${item.key.toUpperCase()}`}
                  title={`${item.label} (${shortcutLabel(item)})`}
                >
                  <ViewIcon view={item.id} />
                  <span className="side-label">{item.label}</span>
                  <kbd className="side-kbd" aria-hidden="true">
                    {item.key.toUpperCase()}
                  </kbd>
                </a>
              );
            })}
          </div>
        ))}
      </div>

      <p className="side-foot" aria-hidden="true">
        <kbd>G</kbd> + letter to jump · <kbd>[</kbd> collapse
      </p>
    </nav>
  );
}

interface RailProps {
  readonly active: ViewId;
  readonly onExpand: () => void;
}

/**
 * Narrow strip shown on desktop while the sidebar is collapsed. The logo heads
 * it and doubles as the expand button: hovering (or focusing) it swaps the logo
 * for the expand icon, a click opens the sidebar. Below it one icon per group,
 * like the phone tab bar: it returns to the view last opened in the group, and
 * the top bar shows the group's views as a segmented control (ScopeBar inline).
 */
export function Rail({ active, onExpand }: RailProps): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);
  const current = VIEW_GROUPS.find((g) => g.items.some((i) => i.id === active));
  noteView(active);
  const pill = useActivePill(listRef, active);

  return (
    <nav className="rail" aria-label="Dashboard views">
      <div className="rail-head">
        <button type="button" className="rail-brand" onClick={onExpand} aria-expanded={false} aria-label="Expand sidebar" title="Expand sidebar ([)">
          <span className="rail-brand-logo">
            <BrandMark />
          </span>
          <span className="rail-brand-expand" aria-hidden="true">
            <PanelLeftIcon size={18} />
          </span>
        </button>
      </div>

      <div className="rail-scroll" ref={listRef}>
        {pill && <span className="rail-pill" style={pillStyle(pill)} aria-hidden="true" />}

        {VIEW_GROUPS.map((group, i) => {
          const first = group.items[0];
          if (!first) return null;
          const on = group === current;
          const views = group.items.map((v) => v.label).join(', ');
          return (
            <a
              key={group.title}
              href={`#${groupTarget(group)}`}
              className={`rail-link${on ? ' is-active' : ''}`}
              style={nth(i)}
              aria-label={group.items.length > 1 ? `${group.title}: ${views}` : first.label}
              title={group.items.length > 1 ? `${group.title}: ${views}` : `${first.label} (${shortcutLabel(first)})`}
              aria-current={on ? 'page' : undefined}
            >
              <ViewIcon view={groupIcon(group)} />
            </a>
          );
        })}
      </div>
    </nav>
  );
}
