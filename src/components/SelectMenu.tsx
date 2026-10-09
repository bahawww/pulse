import { type CSSProperties, type JSX, type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from 'react';
import { CheckIcon } from './icons';

interface SelectOption {
  readonly value: string;
  readonly label: string;
}

interface SelectMenuProps {
  readonly label: string;
  readonly value: string;
  readonly options: readonly SelectOption[];
  readonly onChange: (value: string) => void;
}

/**
 * Dropdown in the page's own style. A native <select> opens an OS popup that
 * ignores the theme, so this uses the same popover and rows as the navbar menus.
 */
export function SelectMenu({ label, value, options, onChange }: SelectMenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  // Where the list opens: below the button unless there is clearly more room
  // above, and never taller than the room it has, so it stays on screen.
  const [place, setPlace] = useState<{ up: boolean; maxHeight: number }>({ up: false, maxHeight: 360 });
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const current = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (e.target instanceof Node && !wrapRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const row = wrapRef.current?.querySelector<HTMLButtonElement>('.menu-item.is-selected');
    if (!row) return;
    // Focus without scrolling the page (that made the page jump on open); bring
    // the row into view inside the list only.
    row.focus({ preventScroll: true });
    const list = row.closest<HTMLElement>('.select-pop');
    if (list) list.scrollTop = row.offsetTop - list.clientHeight / 2 + row.offsetHeight / 2;
  }, [open]);

  const toggle = () => {
    if (!open) {
      const box = triggerRef.current?.getBoundingClientRect();
      if (box) {
        const margin = 12;
        const gap = 8;
        const below = window.innerHeight - box.bottom - gap - margin;
        const above = box.top - gap - margin;
        const up = below < 240 && above > below;
        setPlace({ up, maxHeight: Math.max(160, Math.min(420, up ? above : below)) });
      }
    }
    setOpen((o) => !o);
  };

  /** Arrow keys move focus between rows, like a native listbox. */
  const onListKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const rows = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]'));
    const i = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'ArrowDown' ? Math.min(i + 1, rows.length - 1) : Math.max(i - 1, 0);
    rows[next]?.focus();
  };

  return (
    <div className="pop-anchor select-menu" ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className="select select-trigger"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={toggle}
      >
        {current?.label ?? value}
      </button>
      {open && (
        <>
          <div className="pop-backdrop" aria-hidden="true" onClick={() => setOpen(false)} />
          <div
            className={`pop select-pop${place.up ? ' is-up' : ''}`}
            role="listbox"
            aria-label={label}
            onKeyDown={onListKey}
            style={{ maxHeight: place.maxHeight } as CSSProperties}
          >
            {options.map((o) => (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={o.value === value}
                className={`menu-item${o.value === value ? ' is-selected' : ''}`}
                onClick={() => {
                  setOpen(false);
                  onChange(o.value);
                  triggerRef.current?.focus();
                }}
              >
                <CheckIcon className="menu-check" size={14} />
                <span className="menu-item-label">{o.label}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
