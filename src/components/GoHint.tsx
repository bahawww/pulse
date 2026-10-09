import { type CSSProperties, type JSX } from 'react';
import { VIEWS } from '../lib/views';

/**
 * Shown for a moment after pressing G: every view with the letter that jumps
 * to it. The sidebar lights up the same letters (html[data-go]).
 */
export function GoHint(): JSX.Element {
  return (
    <div className="go-hint" role="status" aria-live="polite">
      <span className="go-hint-title">Go to</span>
      {VIEWS.map((view, i) => (
        <span key={view.id} className="go-hint-item" style={{ '--n': i } as CSSProperties}>
          <kbd>{view.key.toUpperCase()}</kbd>
          {view.label}
        </span>
      ))}
    </div>
  );
}
