import { type JSX, type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { CellRange } from './model';

/** Re-renders on every scroll or buffer growth, at most once per frame. */
function useBufferPos(t: Terminal): { viewportY: number; baseY: number; rows: number } {
  const read = () => ({ viewportY: t.buffer.active.viewportY, baseY: t.buffer.active.baseY, rows: t.rows });
  const [pos, setPos] = useState(read);
  useEffect(() => {
    let frame = 0;
    const kick = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setPos((p) => {
          const n = read();
          return n.viewportY === p.viewportY && n.baseY === p.baseY && n.rows === p.rows ? p : n;
        });
      });
    };
    const subs = [t.onScroll(kick), t.onWriteParsed(kick), t.onResize(kick), t.buffer.onBufferChange(kick)];
    return () => {
      cancelAnimationFrame(frame);
      for (const s of subs) s.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t]);
  return pos;
}

interface RailProps {
  readonly term: Terminal;
  readonly marks: readonly CellRange[];
  readonly current: CellRange | null;
}

/**
 * The vertical scrollbar, drawn by us in place of xterm's. Drag the thumb, click
 * the track to jump, hover for the line number. Search hits show as ticks.
 */
export function ScrollRail({ term: t, marks, current }: RailProps): JSX.Element {
  const { viewportY, baseY, rows } = useBufferPos(t);
  const track = useRef<HTMLDivElement>(null);
  const [h, setH] = useState(0);
  const [drag, setDrag] = useState(false);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = track.current;
    if (!el) return;
    const obs = new ResizeObserver(() => setH(el.clientHeight));
    obs.observe(el);
    setH(el.clientHeight);
    return () => obs.disconnect();
  }, []);

  const total = baseY + rows;
  const thumbH = Math.max(28, total > 0 ? (h * rows) / total : h);
  const room = Math.max(1, h - thumbH);
  const thumbTop = baseY > 0 ? (viewportY / baseY) * room : 0;
  const lineAt = (y: number) => Math.round(Math.min(1, Math.max(0, (y - thumbH / 2) / room)) * baseY);

  const onTrackDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (baseY === 0 || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const box = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - box.top;
    const onThumb = y >= thumbTop && y <= thumbTop + thumbH;
    const grab = onThumb ? y - thumbTop : thumbH / 2;
    if (!onThumb) t.scrollToLine(lineAt(y));
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag(true);
    const el = e.currentTarget;
    const move = (ev: PointerEvent) => {
      const top = Math.min(room, Math.max(0, ev.clientY - box.top - grab));
      t.scrollToLine(Math.round((top / room) * baseY));
    };
    const up = () => {
      setDrag(false);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      t.focus();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  // Ticks, merged when they land on the same pixel row.
  const ticks = useMemo(() => {
    if (total <= 0 || h <= 0) return [];
    const seen = new Set<number>();
    const out: number[] = [];
    for (const m of marks) {
      const y = Math.round((m.row / total) * h);
      if (!seen.has(y)) {
        seen.add(y);
        out.push(y);
      }
    }
    return out;
  }, [marks, total, h]);

  const hoverLine = hover === null ? null : lineAt(hover);

  return (
    <div
      ref={track}
      className={`tw-rail${baseY === 0 ? ' is-empty' : ''}${drag ? ' is-drag' : ''}`}
      onPointerDown={onTrackDown}
      onPointerMove={(e) => setHover(e.clientY - e.currentTarget.getBoundingClientRect().top)}
      onPointerLeave={() => setHover(null)}
      onMouseDown={(e) => e.stopPropagation()}
      aria-hidden="true"
    >
      {ticks.map((y) => (
        <i key={y} className="tw-tick" style={{ top: y }} />
      ))}
      {current && total > 0 && <i className="tw-tick is-current" style={{ top: Math.round((current.row / total) * h) }} />}
      <div className="tw-thumb" style={{ top: thumbTop, height: thumbH }} />
      {hover !== null && hoverLine !== null && baseY > 0 && (
        <span className="tw-rail-tip" style={{ top: Math.min(h - 20, Math.max(0, hover - 10)) }}>
          {baseY - hoverLine === 0 ? 'live' : `−${baseY - hoverLine} lines`}
        </span>
      )}
    </div>
  );
}

/** "Back to live output", shown while scrolled up into history. */
export function JumpPill({ term: t }: { readonly term: Terminal }): JSX.Element | null {
  const { viewportY, baseY } = useBufferPos(t);
  const behind = baseY - viewportY;
  if (behind <= 0) return null;
  return (
    <button
      type="button"
      className="tw-jump"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={() => {
        t.scrollToBottom();
        t.focus();
      }}
    >
      ↓ {behind} {behind === 1 ? 'line' : 'lines'} below
    </button>
  );
}
