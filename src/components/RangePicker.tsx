import { type JSX } from 'react';
import { TIME_RANGES, type TimeRangeId } from '../shared/contract';
import { formatDuration } from '../lib/format';

export interface RangePickerProps {
  readonly value: TimeRangeId;
  readonly onChange: (range: TimeRangeId) => void;
  /** Longest window the server can serve right now. 0 = not known yet. */
  readonly maxSpanMs: number;
  readonly ready: boolean;
  readonly persisted?: boolean | undefined;
  readonly persistError?: string | null | undefined;
  /** A chosen range still loading; its button shows it while the old chart stays up. */
  readonly pending?: TimeRangeId | null | undefined;
}

/**
 * Time-range switch for the trend charts. Says how much history exists and
 * whether it survives a restart, so a short window never looks like a full one.
 */
export function RangePicker({
  value,
  onChange,
  maxSpanMs,
  ready,
  persisted,
  persistError,
  pending,
}: RangePickerProps): JSX.Element {
  const onRecord = maxSpanMs > 0 ? `${formatDuration(maxSpanMs / 1000)} on record` : '';
  const storage = persisted === false ? 'in memory only' : persisted === true ? 'saved to disk' : '';
  const note = [onRecord, storage].filter(Boolean).join(' · ');

  return (
    <div className="toolbar-compact">
      <div className="range" role="group" aria-label="Time range" aria-busy={!ready || !!pending}>
        {TIME_RANGES.map((range) => (
          <button
            key={range.id}
            type="button"
            className={`range-btn${value === range.id ? ' is-active' : ''}${pending === range.id ? ' is-loading' : ''}`}
            aria-pressed={value === range.id}
            onClick={() => onChange(range.id)}
          >
            {range.label}
          </button>
        ))}
      </div>
      {note && (
        <span className="range-note" title={persistError ?? undefined}>
          {note}
        </span>
      )}
    </div>
  );
}
