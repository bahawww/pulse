import { type JSX, type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from '../lib/motion';

interface ConfirmDialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

/** Matches the confirm-out animation in motion.css. */
const EXIT_MS = 200;

/**
 * Small "are you sure" alert, iOS style. Cancel has focus by default, so a
 * stray Enter never confirms. Escape or a click outside cancels. Stays mounted
 * for its exit animation after `open` turns false.
 */
export function ConfirmDialog({ open, title, message, confirmLabel, onConfirm, onCancel }: ConfirmDialogProps): JSX.Element | null {
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) {
      if (document.activeElement instanceof HTMLElement) returnFocus.current = document.activeElement;
      setClosing(false);
      setMounted(true);
      return undefined;
    }
    if (!mounted) return undefined;
    if (prefersReducedMotion()) {
      setMounted(false);
      return undefined;
    }
    setClosing(true);
    const t = setTimeout(() => {
      setMounted(false);
      setClosing(false);
    }, EXIT_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (open && mounted) cancelRef.current?.focus();
  }, [open, mounted]);

  // Back to whatever was focused before (the logout button), once gone.
  useEffect(() => {
    if (mounted || !returnFocus.current) return;
    returnFocus.current.focus({ preventScroll: true });
    returnFocus.current = null;
  }, [mounted]);

  if (!mounted) return null;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    } else if (e.key === 'Tab') {
      // Two buttons: Tab just swaps between them.
      e.preventDefault();
      (document.activeElement === cancelRef.current ? confirmRef.current : cancelRef.current)?.focus();
    }
  };

  return (
    <div className={`confirm-root${closing ? ' is-closing' : ''}`} onKeyDown={onKeyDown}>
      <div className="confirm-backdrop" aria-hidden="true" onClick={onCancel} />
      <div className="confirm" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-msg">
        <span className="confirm-icon" aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
        </span>
        <h2 id="confirm-title" className="confirm-title">
          {title}
        </h2>
        <p id="confirm-msg" className="confirm-msg">
          {message}
        </p>
        <div className="confirm-actions">
          <button ref={cancelRef} type="button" className="btn confirm-btn" onClick={onCancel} disabled={closing}>
            Cancel
          </button>
          <button ref={confirmRef} type="button" className="btn btn-danger confirm-btn" onClick={onConfirm} disabled={closing}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
