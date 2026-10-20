import { type JSX, useEffect, useState } from 'react';
import { MoreIcon } from './icons';

export interface MoreItem {
  readonly label: string;
  readonly onSelect: () => void;
  readonly tone?: 'danger';
  readonly disabled?: boolean;
}

interface MoreMenuProps {
  /** What the button is for, e.g. "More for pulse-mysql" (screen readers, tooltip). */
  readonly label: string;
  readonly items: readonly MoreItem[];
  readonly disabled?: boolean;
}

/**
 * A "..." button that opens the less common actions of a row or card. On a
 * phone every row would otherwise carry three or four buttons: the main one
 * stays visible, the rest live here (a bottom sheet below 641px, like every
 * .pop menu).
 */
export function MoreMenu({ label, items, disabled = false }: MoreMenuProps): JSX.Element | null {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open]);
  if (items.length === 0) return null;
  return (
    <div className="pop-anchor more-anchor">
      <button type="button" className="btn btn-icon btn-sm" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => setOpen((o) => !o)}>
        <MoreIcon size={16} />
      </button>
      {open && (
        <>
          <div className="pop-backdrop" aria-hidden="true" onClick={() => setOpen(false)} />
          <div className="pop more-pop" role="menu" aria-label={label}>
            {items.map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                className={`menu-item${item.tone === 'danger' ? ' is-danger' : ''}`}
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
              >
                <span className="menu-item-label">{item.label}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
