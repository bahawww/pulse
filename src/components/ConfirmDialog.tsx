import { type JSX, type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from '../lib/motion';
import { FileReplaceIcon, LogOutIcon, TrashIcon } from './icons';

/** The glyph says what will happen: every caller picks one. */
type ConfirmIcon = 'logout' | 'delete' | 'replace';

const ICONS: Readonly<Record<ConfirmIcon, (size: number) => JSX.Element>> = {
  logout: (size) => <LogOutIcon size={size} />,
  delete: (size) => <TrashIcon size={size} />,
  replace: (size) => <FileReplaceIcon size={size} />,
};

interface ConfirmDialogProps {
  readonly open: boolean;
  readonly icon: ConfirmIcon;
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
export function ConfirmDialog({ open, icon, title, message, confirmLabel, onConfirm, onCancel }: ConfirmDialogProps): JSX.Element | null {
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
          {ICONS[icon](22)}
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
