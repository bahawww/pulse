import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

/**
 * Interactive terminal chart, built on uPlot.
 *
 * Why uPlot and not Chart.js: this dashboard is a wall of 5-second telemetry.
 * uPlot is ~50 KB, draws to a single canvas, and ships zoom as core behaviour.
 *
 * Interaction model:
 *  - drag on the plot to select a time range and zoom to it on release
 *  - Alt-drag only highlights the range; the toolbar then shows min / avg / max
 *    per series for it, with Zoom and clear buttons (Esc clears)
 *  - touchpad pinch (or Ctrl+wheel) zooms about the cursor, smoothly
 *  - touchpad two-finger swipe sideways pans; swiping up/down scrolls the page
 *  - mouse wheel zooms about the cursor; Shift+wheel or Shift-drag pans
 *  - toolbar buttons scroll left / right and zoom in / out
 *  - the ⤢ button or double-click resets to the full recorded span
 *
 * Data honesty: nulls stay null so uPlot breaks the line instead of
 * interpolating across a collection gap, and x is real epoch time so a gap
 * reads as a gap rather than being stretched to fill the width.
 */

export interface Series {
  readonly key: string;
  readonly label: string;
  /** A CSS colour or a `var(--token)`. Resolved to a concrete value for canvas. */
  readonly color: string;
  readonly values: readonly number[];
  /** Fill the area under the line. Only sensible for the first series. */
  readonly fill?: boolean;
  /**
   * Sample timestamps, ms epoch. Supplying these makes x proportional to real
   * time, so a gap in collection shows up as a gap instead of being stretched.
   */
  readonly times?: readonly number[];
}

interface TimeChartProps {
  readonly series: readonly Series[];
  readonly height?: number;
  /** Fixed 0-100 domain; omit to scale to the data's own max. */
  readonly max?: number;
  /** Fixed 0-max domain, e.g. a computed percentile ceiling. */
  readonly domainMax?: number;
  readonly unit?: string;
  readonly ariaLabel: string;
  /** Human-readable ceiling shown on the axis. Defaults to the computed one. */
  readonly axisLabel?: string;
  /** Formats every number the chart prints: ticks, tags and the readout. */
  readonly format?: (value: number) => string;
  /** Draw the hh:mm:ss time ruler under the plot. */
  readonly showTimeAxis?: boolean;
}

/**
 * Smallest x window we will zoom to, in SECONDS (the unit of uPlot's time scale).
 * Keep the unit in the name: the x scale is seconds, not ms.
 */
const MIN_ZOOM_SPAN_S = 2;
/** Float tolerance for comparing spans that should be equal. */
const EPS = 0.001;
/** Wheel zoom step. */
const WHEEL_STEP = 1.18;
/** Pinch zoom: window scale per unit of wheel deltaY while Ctrl is held. */
const PINCH_SENSITIVITY = 0.012;
/** A drag shorter than this is a click, not a selection. */
const MIN_SELECT_PX = 6;
/** Wheel events this soon after a touchpad-looking one are never a mouse wheel. */
const TOUCHPAD_HOLD_MS = 300;
/** Fallback when a colour token cannot be resolved. */
const FALLBACK_COLOR = '#888888';

/**
 * Read the live x window. Returns nulls when the scale has not been resolved
 * yet (a zero-width chart) rather than letting NaN reach setScale.
 */
function readSpan(plot: uPlot): { min: number | null; max: number | null } {
  const x = plot.scales.x;
  const min = x?.min;
  const hi = x?.max;
  if (typeof min !== 'number' || typeof hi !== 'number') return { min: null, max: null };
  if (!Number.isFinite(min) || !Number.isFinite(hi)) return { min: null, max: null };
  return { min, max: hi };
}

export function TimeChart({
  series,
  height = 72,
  max,
  domainMax,
  ariaLabel,
  axisLabel,
  format,
  showTimeAxis = true,
}: TimeChartProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const plotRef = useRef<uPlot | null>(null);
  const [width, setWidth] = useState(0);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [zoomed, setZoomed] = useState(false);
  /** Selected x range in uPlot time units (seconds), or null. */
  const [sel, setSel] = useState<Selection | null>(null);
  const selRef = useRef<Selection | null>(null);
  /** Repositions the highlight element; owned by the drag effect, called from the draw hook. */
  const selPosRef = useRef<(() => void) | null>(null);
  /** View actions for the toolbar buttons; bound by the wheel effect to the live plot. */
  const viewRef = useRef<{ zoom: (factor: number) => void; pan: (fraction: number) => void } | null>(null);

  // Track the container width. uPlot needs explicit pixel dimensions, and a
  // zero-width first paint would draw a degenerate chart.
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return undefined;
    const measure = (): void => setWidth(el.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Follow the document theme. Canvas colours are baked in at build time, so a
  // theme change rebuilds the plot (see the creation effect's `theme` dep).
  useEffect(() => {
    const root = document.documentElement;
    const read = (): void => setTheme(root.dataset.theme === 'light' ? 'light' : 'dark');
    read();
    if (typeof MutationObserver === 'undefined') return undefined;
    const mo = new MutationObserver(read);
    mo.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);

  const fmt = useMemo(
    () => format ?? ((v: number): string => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2))),
    [format],
  );

  /** Aligned uPlot data: one shared x column plus one column per series. */
  const model = useMemo(() => {
    const first = series[0];
    const count = first?.values.length ?? 0;
    const times = first?.times;
    // Only trust timestamps when they line up with the values; a mismatch would
    // silently misplace points along x.
    const aligned = times !== undefined && times.length === count && count > 1;

    const xs: number[] = new Array<number>(count);
    // uPlot's time scale is in SECONDS, not milliseconds.
    for (let i = 0; i < count; i++) xs[i] = aligned ? (times?.[i] ?? i) / 1000 : i;

    const cols: (number | null)[][] = [];
    for (const s of series) {
      const col: (number | null)[] = new Array<number | null>(count).fill(null);
      for (let i = 0; i < count; i++) {
        const v = s.values[i];
        // null / NaN / Infinity break the line instead of being coerced to zero,
        // which would invent a measurement that never happened.
        col[i] = typeof v === 'number' && Number.isFinite(v) ? v : null;
      }
      cols.push(col);
    }

    // A collection hole must read as a hole, not a straight line drawn across
    // it: drop an empty point just after the last sample before any long gap.
    let gxs: number[] = xs;
    let gcols = cols;
    if (aligned && count > 2) {
      const diffs: number[] = [];
      for (let i = 1; i < count; i++) diffs.push((xs[i] ?? 0) - (xs[i - 1] ?? 0));
      const median = [...diffs].sort((a, b) => a - b)[Math.floor(diffs.length / 2)] ?? 1;
      // Archive buckets are legitimately 60-120s apart, so judge gaps relative
      // to the series' own cadence, with a 60s floor.
      const limit = Math.max(median * 3, 60);
      if (diffs.some((d) => d > limit)) {
        gxs = [];
        gcols = cols.map(() => []);
        for (let i = 0; i < count; i++) {
          gxs.push(xs[i] ?? 0);
          cols.forEach((c, k) => gcols[k]?.push(c[i] ?? null));
          const d = diffs[i];
          if (d !== undefined && d > limit) {
            gxs.push((xs[i] ?? 0) + median);
            gcols.forEach((c) => c.push(null));
          }
        }
      }
    }

    const flat = gcols.flat().filter((v): v is number => v !== null);
    const dataMax = flat.length > 0 ? Math.max(...flat) : 0;
    const ceiling = domainMax ?? max ?? (dataMax > 0 ? Math.ceil(dataMax * 1.15) : 1);

    return {
      xs: gxs,
      cols: gcols,
      ceiling,
      count: gxs.length,
      seriesCount: gcols.length,
      aligned,
      spanStart: gxs[0] ?? 0,
      spanEnd: gxs[gxs.length - 1] ?? 0,
    };
  }, [series, domainMax, max]);

  // A plot can only exist once there is a real width and at least two samples.
  // Data often arrives AFTER mount (history loads on its own request), so every
  // effect that touches the plot keys off this flag. Keying on width alone left
  // the chart unbuilt forever.
  const ready = width > 0 && model.count >= 2;

  const themeRef = useRef(theme);
  themeRef.current = theme;

  // Option callbacks (the y range fn, axis value formatters) are created once
  // when the plot is built but must keep reporting current values. Reading the
  // model through a ref is what lets the plot outlive individual polls.
  const modelRef = useRef(model);
  modelRef.current = model;

  // Create the plot once per width/layout/theme change, then update data in
  // place so a poll never throws away the user's zoom window.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !ready) return undefined;

    const t = themeRef.current === 'light';
    const text = t ? '#86868b' : '#6e6e73';
    const xRuler = showTimeAxis ? 16 : 0;
    // Short charts only get the 0 and ceiling ticks. Three labels in 54px
    // stacked on top of each other.
    const ticks = height < 80 ? 2 : 3;
    // The gutter must fit the widest label the chart will print ("143 KiB/s"),
    // so size it from the formatted ceiling rather than a fixed width.
    const widest = Math.max(...[0, modelRef.current.ceiling].map((v) => fmt(v).length));
    // ~7.2px per mono glyph at 11px, plus the tick mark and the axis gap.
    const gutter = Math.min(110, Math.max(36, Math.ceil(widest * 7.2) + 18));
    const colors = series.map((s) => resolveColor(s.color));
    const gridColor = t ? 'rgba(0,0,0,0.07)' : 'rgba(255,255,255,0.07)';
    const surface = t ? '#ffffff' : '#0d0d0d';
    // Splines read as modern but cost more per point; very dense archives stay linear.
    const smooth = model.count <= 1500 ? uPlot.paths.spline?.() : undefined;
    let tip: HTMLDivElement | null = null;

    const opts: uPlot.Options = {
      width,
      // uPlot's `height` is the whole chart box and subtracts axis sizes from it,
      // so hand it the plot-area height plus the axis bands.
      height: height + xRuler,
      legend: { show: false },
      cursor: {
        // uPlot's own drag only builds a selection rect, so pan is implemented in
        // the pointer handlers below where the modifier key picks pan vs zoom.
        drag: { x: false, y: false, setScale: false, dist: 0 },
        // Vertical guide only, with a ringed marker on each line at the cursor.
        y: false,
        points: {
          show: true,
          size: 9,
          width: 2,
          stroke: (_u, i) => colors[i - 1] ?? FALLBACK_COLOR,
          fill: () => surface,
        },
        focus: { prox: 30 },
        hover: { prox: 30 },
      },
      // Zero-sized with show:true enables the drag-select rect without
      // pre-setting it. Paint lives in .u-select in styles.css.
      select: { show: true, left: 0, top: 0, width: 0, height: 0 },
      hooks: {
        // Keeps the selection highlight glued to its time range through zoom, pan and polls.
        draw: [() => selPosRef.current?.()],
        ready: [
          (u) => {
            tip = document.createElement('div');
            tip.className = 'chart-tip';
            u.over.appendChild(tip);
          },
        ],
        setCursor: [
          (u) => {
            if (!tip) return;
            const idx = u.cursor.idx;
            const left = u.cursor.left ?? -1;
            if (idx === null || idx === undefined || left < 0) {
              tip.style.display = 'none';
              return;
            }
            const x = u.data[0]?.[idx];
            // Built with DOM nodes, not innerHTML: labels can be process names.
            const head = document.createElement('div');
            head.className = 'chart-tip-time';
            head.textContent = typeof x === 'number' ? (modelRef.current.aligned ? clock(x * 1000) : String(Math.round(x))) : '';
            const rows = series.map((s, i) => {
              const v = u.data[i + 1]?.[idx];
              const row = document.createElement('div');
              row.className = 'chart-tip-row';
              const dot = document.createElement('span');
              dot.className = 'swatch';
              dot.style.background = colors[i] ?? FALLBACK_COLOR;
              const name = document.createElement('span');
              name.className = 'chart-tip-name';
              name.textContent = s.label;
              const val = document.createElement('b');
              val.textContent = typeof v === 'number' ? fmt(v) : '—';
              row.append(dot, name, val);
              return row;
            });
            tip.replaceChildren(head, ...rows);
            tip.style.display = 'block';
            const w = tip.offsetWidth;
            const flip = left + 16 + w > u.over.clientWidth;
            tip.style.transform = `translate(${Math.max(0, flip ? left - w - 16 : left + 16)}px, 6px)`;
          },
        ],
      },
      scales: {
        x: { time: model.aligned },
        // Pin y to 0..ceiling so a percentile-pinned axis stays pinned instead
        // of being silently rescaled by the zoom.
        y: { auto: false, range: () => [0, modelRef.current.ceiling] },
      },
      axes: [
        {
          stroke: text,
          font: '11px ui-monospace, SFMono-Regular, Menlo, monospace',
          size: showTimeAxis ? 16 : 0,
          gap: 6,
          show: showTimeAxis,
          grid: { show: false },
          ticks: { show: false },
          // Zoomed in, ticks are spaced by the window, so show hh:mm:ss.
          values: (_u, splits) =>
            splits.map((s) => (model.aligned ? clock(s * 1000) : String(Math.round(s)))),
        },
        {
          stroke: text,
          font: '11px ui-monospace, SFMono-Regular, Menlo, monospace',
          size: gutter,
          gap: 6,
          show: true,
          grid: { stroke: gridColor, width: 1 },
          ticks: { show: false },
          values: (_u, splits) => splits.map((s) => fmt(s ?? 0)),
          // Label the pinned ceiling explicitly rather than letting the tick
          // values drift as live data moves.
          splits: () =>
            ticks === 2
              ? [0, modelRef.current.ceiling]
              : [0, modelRef.current.ceiling / 2, modelRef.current.ceiling],
        },
      ],
      series: [
        {},
        ...series.map((s, i) => {
          const stroke = colors[i] ?? FALLBACK_COLOR;
          return {
            label: s.label,
            stroke,
            width: 2,
            points: { show: false },
            ...(smooth ? { paths: smooth } : {}),
            // Flat translucent fill: overlapping series stay legible without gradients.
            ...(s.fill ? { fill: alphaOf(stroke, 0.14) } : {}),
          };
        }),
      ],
    };

    const plot = new uPlot(opts, [model.xs, ...model.cols], host);
    plotRef.current = plot;

    // A rebuild always starts from the full span, so the reset button must go
    // back to disabled with it.
    setZoomed(false);

    return () => {
      // Destroy on teardown: a leaked uPlot keeps its canvas and listeners alive.
      plot.destroy();
      plotRef.current = null;
    };
    // `model.count` and `model.ceiling` are deliberately NOT dependencies: both
    // move on nearly every poll, and rebuilding destroyed the zoom window.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, ready, theme, height, showTimeAxis, model.seriesCount]);

  /**
   * Push new samples into the existing plot.
   *
   * Separate from the creation effect on purpose: rebuilding destroys the zoom
   * window, so the data is updated in place while the chart keeps its view.
   */
  useEffect(() => {
    const plot = plotRef.current;
    if (!plot) return;
    if (model.count < 2) return;
    // Compare every plotted point, not just the last timestamp: at archive
    // resolution the current bucket legitimately repeats across polls.
    const cur = plot.data[0];
    let same = cur?.length === model.count;
    if (same) {
      for (let i = 0; i < model.count; i++) {
        if (cur?.[i] !== model.xs[i]) {
          same = false;
          break;
        }
      }
      if (same) {
        for (let s = 0; s < model.cols.length && same; s++) {
          const drawn = plot.data[s + 1];
          const next = model.cols[s] ?? [];
          for (let i = 0; i < next.length; i++) {
            if (drawn?.[i] !== next[i]) {
              same = false;
              break;
            }
          }
        }
      }
    }
    if (same) return;
    plot.batch((u: uPlot) => {
      u.setData([model.xs, ...model.cols]);
      // Keep the pinned value axis pinned across the update.
      u.setScale('y', { min: 0, max: model.ceiling });
    });
    plot.redraw(false, true);
  }, [model]);

  /**
   * Wheel, touchpad and gesture input.
   *
   * Browsers report a touchpad pinch as a wheel event with ctrlKey set and a small
   * continuous deltaY, so it is zoomed proportionally (smooth) and the page's own
   * zoom is suppressed. A two-finger sideways swipe pans. A two-finger vertical
   * swipe is left alone so the page still scrolls past the chart. A notched mouse
   * wheel keeps the stepped zoom. Safari reports pinch as gesture events instead.
   */
  useEffect(() => {
    const plot = plotRef.current;
    const bar = barRef.current;
    if (!plot || !bar) return undefined;

    let frame = 0;
    let lastTouchpadAt = 0;

    const overX = (clientX: number): number => clientX - plot.over.getBoundingClientRect().left;

    /** Scale the window about the x value under the pointer. factor > 1 zooms out. */
    const zoomAbout = (clientX: number, factor: number): void => {
      const { min, max: hi } = readSpan(plot);
      if (min === null || hi === null) return;
      if (!Number.isFinite(factor) || factor <= 0) return;
      // Already at the closest zoom: more zoom-in would only jitter.
      if (factor < 1 && hi - min <= MIN_ZOOM_SPAN_S + EPS) return;
      const anchor = plot.posToVal(overX(clientX), 'x');
      if (!Number.isFinite(anchor)) return;
      const live = modelRef.current;
      let nextMin = anchor - (anchor - min) * factor;
      let nextMax = anchor + (hi - anchor) * factor;
      [nextMin, nextMax] = clampSpan(nextMin, nextMax, live.spanStart, live.spanEnd);
      if (nextMax - nextMin < MIN_ZOOM_SPAN_S - EPS) return;
      plot.batch((u: uPlot) => {
        // Re-pin y in the same batch so the value axis keeps its full height.
        u.setScale('y', { min: 0, max: modelRef.current.ceiling });
        u.setScale('x', { min: nextMin, max: nextMax });
      });
      setZoomed(nextMin > live.spanStart + EPS || nextMax < live.spanEnd - EPS);

      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        plot.redraw(false, true);
      });
    };

    /** Slide the window by a pixel distance. */
    const panByPx = (px: number): void => {
      const { min, max: hi } = readSpan(plot);
      if (min === null || hi === null) return;
      const width = plot.over.clientWidth;
      if (width <= 0) return;
      const shift = px * ((hi - min) / width);
      pan(plot, min + shift, hi + shift, modelRef.current.spanStart, modelRef.current.spanEnd);
    };

    viewRef.current = {
      zoom: (factor) => {
        const box = plot.over.getBoundingClientRect();
        zoomAbout(box.left + box.width / 2, factor);
      },
      pan: (fraction) => panByPx(fraction * plot.over.clientWidth),
    };

    const onWheel = (ev: WheelEvent): void => {
      // Line-based deltas (Firefox mouse wheel) become pixels.
      const unit = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? plot.over.clientHeight : 1;
      const dx = ev.deltaX * unit;
      const dy = ev.deltaY * unit;

      // Over the button strip, pan rather than zoom, so the controls stay usable.
      if (ev.target instanceof Node && bar.contains(ev.target)) {
        ev.preventDefault();
        panByPx(Math.abs(dx) > Math.abs(dy) ? dx : dy);
        return;
      }

      // Touchpad pinch (and Ctrl+wheel): proportional, so slow pinches are fine-grained.
      if (ev.ctrlKey) {
        ev.preventDefault();
        const clamped = Math.max(-60, Math.min(60, dy));
        zoomAbout(ev.clientX, Math.exp(clamped * PINCH_SENSITIVITY));
        return;
      }

      // Notched wheels send whole numbers, one big step per click, never sideways.
      const mouseLike = ev.deltaMode === 1 || (dx === 0 && Number.isInteger(dy) && Math.abs(dy) >= 50);
      const now = ev.timeStamp;

      // Two-finger sideways swipe, or Shift+wheel (Firefox sends that as deltaY): pan.
      if (Math.abs(dx) > Math.abs(dy) || (ev.shiftKey && dy !== 0)) {
        if (dx !== 0) lastTouchpadAt = now;
        ev.preventDefault();
        panByPx(dx !== 0 ? dx : dy);
        return;
      }

      if (mouseLike && now - lastTouchpadAt > TOUCHPAD_HOLD_MS) {
        ev.preventDefault();
        zoomAbout(ev.clientX, dy > 0 ? WHEEL_STEP : 1 / WHEEL_STEP);
        return;
      }

      // Touchpad vertical swipe (or its momentum): let the page scroll.
      lastTouchpadAt = now;
    };

    // Safari: pinch arrives as gesture events carrying a cumulative scale.
    let lastScale = 1;
    const onGestureStart = (ev: Event): void => {
      ev.preventDefault();
      lastScale = 1;
    };
    const onGestureChange = (ev: Event): void => {
      ev.preventDefault();
      const g = ev as Event & { scale?: number; clientX?: number };
      if (typeof g.scale !== 'number' || g.scale <= 0 || typeof g.clientX !== 'number') return;
      zoomAbout(g.clientX, lastScale / g.scale);
      lastScale = g.scale;
    };
    const onGestureEnd = (ev: Event): void => ev.preventDefault();

    plot.over.addEventListener('wheel', onWheel, { passive: false });
    bar.addEventListener('wheel', onWheel, { passive: false });
    plot.over.addEventListener('gesturestart', onGestureStart);
    plot.over.addEventListener('gesturechange', onGestureChange);
    plot.over.addEventListener('gestureend', onGestureEnd);
    return () => {
      plot.over.removeEventListener('wheel', onWheel);
      bar.removeEventListener('wheel', onWheel);
      plot.over.removeEventListener('gesturestart', onGestureStart);
      plot.over.removeEventListener('gesturechange', onGestureChange);
      plot.over.removeEventListener('gestureend', onGestureEnd);
      if (frame) cancelAnimationFrame(frame);
      viewRef.current = null;
    };
    // Rebound only when the plot itself is rebuilt. The handlers read the live
    // model through modelRef, so a rebind on every poll only risks dropping a
    // gesture mid-flight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, ready, theme]);

  /** Store a selection (or null), mirror it to state and repaint the highlight. */
  const commitSel = useCallback((next: Selection | null): void => {
    selRef.current = next;
    setSel(next);
    selPosRef.current?.();
  }, []);

  /**
   * Drag to select a time range, Shift-drag to pan.
   *
   * The highlight is its own element inside the plot overlay rather than uPlot's
   * select rect, because uPlot clears that rect whenever data or scales change and
   * a selection has to survive polls, zoom and pan. It is stored as a time range and
   * re-placed from the x scale on every draw.
   *
   * Listeners go on `document` for move/up so a drag that leaves the plot still
   * tracks and releases cleanly.
   */
  useEffect(() => {
    const plot = plotRef.current;
    const over = plot?.over;
    if (!plot || !over) return undefined;

    const mark = document.createElement('div');
    mark.className = 'chart-sel';
    // Behind the tooltip and cursor, above the canvas.
    over.insertBefore(mark, over.firstChild);

    const position = (): void => {
      const s = selRef.current;
      if (!s) {
        mark.style.display = 'none';
        return;
      }
      const x0 = plot.valToPos(s.a, 'x');
      const x1 = plot.valToPos(s.b, 'x');
      const left = Math.max(0, Math.min(x0, x1));
      const right = Math.min(over.clientWidth, Math.max(x0, x1));
      if (!Number.isFinite(left) || !Number.isFinite(right) || right <= left) {
        mark.style.display = 'none';
        return;
      }
      mark.style.display = 'block';
      mark.style.left = `${left}px`;
      mark.style.width = `${right - left}px`;
    };
    selPosRef.current = position;
    position();

    // None: idle. Pan: dragging to slide. Select: dragging out a range.
    let mode: 'none' | 'pan' | 'select' = 'none';
    let startX = 0;
    let startMin = 0;
    let startMax = 0;
    // Alt-drag only highlights and shows stats; a plain drag zooms on release.
    let highlightOnly = false;

    /** Pointer x in CSS pixels, relative to the plot area. */
    const localX = (clientX: number): number => clientX - over.getBoundingClientRect().left;

    const rangeBetween = (x0: number, x1: number): Selection | null => {
      const live = modelRef.current;
      const a = plot.posToVal(Math.min(x0, x1), 'x');
      const b = plot.posToVal(Math.max(x0, x1), 'x');
      if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
      return { a: Math.max(a, live.spanStart), b: Math.min(b, live.spanEnd) };
    };

    const onDown = (ev: MouseEvent): void => {
      // Ignore secondary buttons so a right-click context menu still works.
      if (ev.button !== 0) return;
      const { min, max } = readSpan(plot);
      if (min === null || max === null) return;
      // Stops the browser starting its own text selection under the drag.
      ev.preventDefault();
      mode = ev.shiftKey ? 'pan' : 'select';
      highlightOnly = ev.altKey;
      startX = localX(ev.clientX);
      startMin = min;
      startMax = max;
      over.style.cursor = mode === 'pan' ? 'grabbing' : 'crosshair';
    };

    const onMove = (ev: MouseEvent): void => {
      if (mode === 'none') return;
      const x = Math.max(0, Math.min(over.clientWidth, localX(ev.clientX)));

      if (mode === 'pan') {
        // Pixel delta to value delta, clamped to the recorded span so the edges
        // cannot be dragged past.
        const perPx = (startMax - startMin) / (over.clientWidth || 1);
        const shift = (x - startX) * perPx;
        pan(plot, startMin - shift, startMax - shift, modelRef.current.spanStart, modelRef.current.spanEnd);
        return;
      }

      // Select: paint the range live, committing to state on release.
      if (Math.abs(x - startX) < MIN_SELECT_PX) return;
      const next = rangeBetween(startX, x);
      if (!next) return;
      selRef.current = next;
      position();
    };

    const onUp = (ev: MouseEvent): void => {
      if (mode === 'none') return;
      const finished = mode;
      mode = 'none';
      over.style.cursor = '';
      if (finished !== 'select') return;

      const x = Math.max(0, Math.min(over.clientWidth, localX(ev.clientX)));
      // A drag of a few pixels is a click: it clears the selection.
      if (Math.abs(x - startX) < MIN_SELECT_PX) {
        commitSel(null);
        return;
      }
      const next = rangeBetween(startX, x);
      if (!next || next.b <= next.a) {
        commitSel(null);
        return;
      }
      commitSel(next);
      if (!highlightOnly) zoomToSelection();
    };

    over.addEventListener('mousedown', onDown);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      over.removeEventListener('mousedown', onDown);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      mark.remove();
      if (selPosRef.current === position) selPosRef.current = null;
    };
    // Rebound only on plot rebuild: rebinding mid-drag would tear down the gesture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, ready, theme]);

  // Esc clears a selection. Listens only while one exists.
  useEffect(() => {
    if (!sel) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') commitSel(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [sel, commitSel]);

  /** Zoom the x window to the selection, then drop the selection. */
  const zoomToSelection = useCallback((): void => {
    const plot = plotRef.current;
    const s = selRef.current;
    if (!plot || !s) return;
    const live = modelRef.current;
    const [nextMin, nextMax] = clampSpan(s.a, s.b, live.spanStart, live.spanEnd);
    if (nextMax - nextMin < MIN_ZOOM_SPAN_S - EPS) return;
    plot.batch((u: uPlot) => {
      u.setScale('y', { min: 0, max: live.ceiling });
      u.setScale('x', { min: nextMin, max: nextMax });
    });
    setZoomed(true);
    plot.redraw(false, true);
    commitSel(null);
  }, [commitSel]);

  /** Per-series min / avg / max over the selected range. */
  const selStats = useMemo(() => {
    if (!sel) return null;
    const rows = model.cols.map((col, k) => {
      let lo = Infinity;
      let hi = -Infinity;
      let sum = 0;
      let n = 0;
      for (let i = 0; i < model.xs.length; i++) {
        const x = model.xs[i];
        const v = col[i];
        if (x === undefined || x < sel.a || x > sel.b) continue;
        if (typeof v !== 'number') continue;
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
        sum += v;
        n += 1;
      }
      const s = series[k];
      return {
        key: s?.key ?? String(k),
        label: s?.label ?? '',
        color: resolveColor(s?.color ?? FALLBACK_COLOR),
        n,
        lo,
        hi,
        avg: n > 0 ? sum / n : 0,
      };
    });
    return rows.filter((r) => r.n > 0);
  }, [sel, model, series]);

  /** Double-click / ⤢ resets the x window to the full recorded span. */
  const resetView = useCallback((): void => {
    const plot = plotRef.current;
    if (!plot) return;
    // Reset to whatever the data spans NOW, not what it spanned when this
    // callback was last created.
    const live = modelRef.current;
    plot.batch((u: uPlot) => {
      u.setScale('y', { min: 0, max: live.ceiling });
      u.setScale('x', { min: live.spanStart, max: live.spanEnd });
    });
    setZoomed(false);
    plot.redraw(false, true);
  }, []);

  useEffect(() => {
    const plot = plotRef.current;
    if (!plot) return undefined;
    const onDbl = (ev: MouseEvent): void => {
      ev.preventDefault();
      resetView();
    };
    plot.over.addEventListener('dblclick', onDbl);
    return () => plot.over.removeEventListener('dblclick', onDbl);
  }, [resetView, model, ready, theme]);

  return (
    <div className="spark-wrap">
      <div
        className="spark-plot"
        style={{ height: `${height + (showTimeAxis ? 16 : 0)}px` }}
      >
        <div ref={hostRef} className="spark-host" role="img" aria-label={ariaLabel} />
        {axisLabel !== undefined && (
          <span className="spark-axis-label" aria-hidden="true">
            {axisLabel}
          </span>
        )}
      </div>
      <div className="spark-toolbar" ref={barRef}>
        <button
          type="button"
          className="spark-btn spark-btn-reset"
          onClick={resetView}
          disabled={!zoomed}
          title="Reset zoom to full span"
          aria-label="Reset zoom"
        >
          ⤢
        </button>
        <button type="button" className="spark-btn" onClick={() => viewRef.current?.pan(-0.4)} title="Scroll left" aria-label="Scroll left">
          ◀
        </button>
        <button type="button" className="spark-btn" onClick={() => viewRef.current?.pan(0.4)} title="Scroll right" aria-label="Scroll right">
          ▶
        </button>
        <button type="button" className="spark-btn" onClick={() => viewRef.current?.zoom(1.6)} title="Zoom out" aria-label="Zoom out">
          −
        </button>
        <button type="button" className="spark-btn" onClick={() => viewRef.current?.zoom(1 / 1.6)} title="Zoom in" aria-label="Zoom in">
          +
        </button>
        {sel && selStats && (
          <div className="spark-sel" role="group" aria-label="Selected range">
            <span className="spark-sel-range">
              {model.aligned ? `${clock(sel.a * 1000)} – ${clock(sel.b * 1000)}` : `${Math.round(sel.a)} – ${Math.round(sel.b)}`}
              {model.aligned && ` · ${duration(sel.b - sel.a)}`}
            </span>
            {selStats.map((r) => (
              <span className="spark-sel-stat" key={r.key}>
                <span className="swatch" style={{ background: r.color }} aria-hidden="true" />
                {r.label}
                <b>
                  {fmt(r.lo)} / {fmt(r.avg)} / {fmt(r.hi)}
                </b>
              </span>
            ))}
            <span className="spark-sel-key">min / avg / max</span>
            <button type="button" className="spark-btn spark-btn-text" onClick={zoomToSelection} title="Zoom to the selection">
              Zoom
            </button>
            <button type="button" className="spark-btn" onClick={() => commitSel(null)} title="Clear selection (Esc)" aria-label="Clear selection">
              ✕
            </button>
          </div>
        )}
        {showTimeAxis && !sel && (
          <span className="spark-hint" aria-hidden="true">
            drag zoom · alt+drag stats · shift+wheel scroll
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Canvas cannot resolve `var(--token)`, so a themed colour reaches uPlot as an
 * invalid string and every line draws as nothing. Resolve tokens to their value.
 */
function resolveColor(color: string): string {
  const match = /^var\((--[\w-]+)\)$/.exec(color.trim());
  if (!match) return color;
  const value = getComputedStyle(document.documentElement).getPropertyValue(match[1] ?? '').trim();
  return value || FALLBACK_COLOR;
}

/**
 * Clamp a proposed x window so it can never escape the recorded data or collapse
 * below a usable span. Returns the corrected [min, max].
 */
function clampSpan(min: number, max: number, lo: number, hi: number): [number, number] {
  const span = Math.max(max - min, MIN_ZOOM_SPAN_S);
  // Do not let the window slide outside the recorded span.
  if (min < lo) {
    min = lo;
    max = Math.min(max, lo + span);
  }
  if (max > hi) {
    max = hi;
    min = Math.max(min, hi - span);
  }
  // Only snap back when the window is genuinely WIDER than the recorded data.
  if (max - min > hi - lo + EPS) return [lo, hi];
  return [min, max];
}

/** Shift a window, keeping it inside the recorded span. */
function pan(plot: uPlot, min: number, max: number, lo: number, hi: number): void {
  const span = max - min;
  if (span <= 0) return;
  let nextMin = min;
  let nextMax = max;
  if (nextMin < lo) {
    nextMin = lo;
    nextMax = lo + span;
  }
  if (nextMax > hi) {
    nextMax = hi;
    nextMin = hi - span;
  }
  plot.setScale('x', { min: nextMin, max: nextMax });
}

/** Selected x range in uPlot time units (seconds). */
interface Selection {
  readonly a: number;
  readonly b: number;
}

/** 90 -> "1m 30s". Input in seconds. */
function duration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/** hh:mm:ss for an epoch-ms tick. */
function clock(ms: number): string {
  const d = new Date(ms);
  return (
    `${String(d.getHours()).padStart(2, '0')}:` +
    `${String(d.getMinutes()).padStart(2, '0')}:` +
    `${String(d.getSeconds()).padStart(2, '0')}`
  );
}

/** #rgb/#rrggbb + alpha -> rgba(), so a series colour can fill without a token. */
function alphaOf(hex: string, alpha: number): string {
  if (!hex.startsWith('#') || (hex.length !== 7 && hex.length !== 4)) return hex;
  const full =
    hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;
  const r = Number.parseInt(full.slice(1, 3), 16);
  const g = Number.parseInt(full.slice(3, 5), 16);
  const b = Number.parseInt(full.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
