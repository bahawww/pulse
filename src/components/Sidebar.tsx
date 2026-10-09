import { type CSSProperties, type JSX, type RefObject, useLayoutEffect, useRef, useState } from 'react';
import { VIEW_GROUPS, VIEWS, type ViewId, shortcutLabel } from '../lib/views';
import { PanelLeftIcon, ViewIcon } from './icons';

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
 */
function useActivePill(navRef: RefObject<HTMLElement | null>, active: ViewId): PillBox | null {
  const [box, setBox] = useState<PillBox | null>(null);

  useLayoutEffect(() => {
    const measure = () => {
      const link = navRef.current?.querySelector<HTMLElement>('[aria-current="page"]');
      setBox(link ? { top: link.offsetTop, left: link.offsetLeft, width: link.offsetWidth, height: link.offsetHeight } : null);
    };
    measure();
    // Re-measure when the menu reflows (late web fonts, window resize).
    const observer = new ResizeObserver(measure);
    if (navRef.current) observer.observe(navRef.current);
    return () => observer.disconnect();
  }, [navRef, active]);

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
 * Left menu on desktop. Hide button on top, then one link per view, grouped by
 * topic. Hidden below 1024px, where the navbar's view menu takes over.
 */
export function Sidebar({ active, onToggle }: SidebarProps): JSX.Element {
  const navRef = useRef<HTMLElement>(null);
  const pill = useActivePill(navRef, active);

  return (
    <nav ref={navRef} className="sidebar" aria-label="Dashboard views">
      {pill && <span className="side-pill" style={pillStyle(pill)} aria-hidden="true" />}

      <div className="sidebar-head">
        <button
          type="button"
          className="icon-btn"
          onClick={onToggle}
          aria-expanded={true}
          aria-label="Hide sidebar"
          title="Hide sidebar ([)"
        >
          <PanelLeftIcon size={15} />
        </button>
      </div>

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
                {item.label}
                <kbd className="side-kbd" aria-hidden="true">
                  {item.key.toUpperCase()}
                </kbd>
              </a>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

interface RailProps {
  readonly active: ViewId;
  readonly onExpand: () => void;
}

/**
 * Narrow strip shown on desktop while the sidebar is hidden. The top button
 * opens the sidebar; each icon jumps to a view. Labels show as tooltips.
 */
export function Rail({ active, onExpand }: RailProps): JSX.Element {
  const navRef = useRef<HTMLElement>(null);
  const pill = useActivePill(navRef, active);

  return (
    <nav ref={navRef} className="rail" aria-label="Dashboard views">
      {pill && <span className="rail-pill" style={pillStyle(pill)} aria-hidden="true" />}

      <button
        type="button"
        className="rail-link rail-toggle"
        onClick={onExpand}
        aria-expanded={false}
        aria-label="Show sidebar"
        title="Show sidebar ([)"
      >
        <PanelLeftIcon size={15} />
      </button>

      {VIEWS.map((view, i) => {
        const current = view.id === active;
        return (
          <a
            key={view.id}
            href={`#${view.id}`}
            className={`rail-link${current ? ' is-active' : ''}`}
            style={nth(i)}
            aria-label={view.label}
            aria-keyshortcuts={`G ${view.key.toUpperCase()}`}
            title={`${view.label} (${shortcutLabel(view)})`}
            aria-current={current ? 'page' : undefined}
          >
            <ViewIcon view={view.id} />
          </a>
        );
      })}
    </nav>
  );
}
