import type { IBufferCell, IBufferLine, Terminal } from '@xterm/xterm';

/**
 * Canvas renderer for xterm.js.
 *
 * xterm stays the terminal: it parses the byte stream, owns the buffer, the
 * keyboard, IME, paste, mouse reporting and the selection model. This class only
 * replaces how the screen looks. xterm's own DOM rows are hidden by CSS, and two
 * canvases are laid over the same box (`.xterm-screen`), so every pixel of the
 * terminal is drawn here and can be restyled freely:
 *
 *  - text canvas: cell backgrounds, selection, glyphs, decorations. Redrawn only
 *    when xterm reports a change. In `lcd` mode it is opaque, which lets the
 *    browser use LCD (subpixel, ClearType-style) antialiasing for the text where
 *    the OS has it; the browser only does that on an opaque canvas.
 *  - cursor canvas: the cursor alone, animated every frame (glide and soft pulse)
 *    without touching the text canvas.
 *
 * Both canvases draw in device pixels. Their backing store is sized from
 * `devicePixelContentBox`, so one canvas pixel is exactly one screen pixel at any
 * zoom or display scaling (125%, 150%...) and the browser never resamples the
 * bitmap. Baselines, cell edges and line art snap to whole pixels. With
 * `supersample: 2` the canvas renders at twice that and the browser averages it
 * down: softer, smoother edges instead of the sharpest possible stems.
 *
 * Neither canvas takes pointer events, so mouse selection, wheel scrolling and
 * the scrollbar keep working through xterm underneath.
 */

export interface RenderTheme {
  readonly foreground: string;
  readonly background: string;
  readonly cursor: string;
  readonly selection: string;
  /** The 16 ANSI colours, black to bright white. */
  readonly ansi: readonly string[];
}

/** How text is rasterised. */
export interface RenderQuality {
  /** 1: one canvas pixel per screen pixel. 2: render at 2x and let the browser average down. */
  readonly supersample: 1 | 2;
  /** Weight of normal text. Bold is always 700. */
  readonly weight: 400 | 500;
  /** Bold text in the eight base colours uses the bright ones, like classic xterm. */
  readonly boldBright: boolean;
  /**
   * `lcd`: subpixel (ClearType-style) antialiasing wherever the system uses it for
   * ordinary page text. `gray`: plain greyscale, for OLED or rotated panels where
   * colour fringes show. Supersampling always renders greyscale.
   */
  readonly antialias: 'lcd' | 'gray';
}

export const DEFAULT_QUALITY: RenderQuality = { supersample: 1, weight: 400, boldBright: false, antialias: 'lcd' };

/** A run of cells in absolute buffer coordinates. */
export interface CellRange {
  readonly row: number;
  readonly col: number;
  readonly len: number;
}

/** A link under the pointer, as start and end cells (inclusive, 0-based, absolute rows). */
export interface LinkSpan {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

export interface RendererOptions {
  readonly fontFamily: string;
  readonly getTheme: () => RenderTheme;
  /** Told the backing-store size whenever it changes, for the status strip. */
  readonly onRenderSize?: (width: number, height: number, scale: number, supersampled: boolean) => void;
}

/**
 * Supersampling stops at this many canvas pixels per CSS pixel. A 2x (4K-class)
 * screen is already there, and going further only costs memory: a 4x canvas for
 * a full-screen window is ~40 MB, twice over with the cursor layer.
 */
const MAX_SCALE = 3;

const BLINK_PERIOD_MS = 1100;
/** Time constant of the cursor's horizontal glide. */
const GLIDE_MS = 42;

// Attribute bits, packed per cell.
const BOLD = 1;
const ITALIC = 2;
const DIM = 4;
const UNDERLINE = 8;
const STRIKE = 16;
const OVERLINE = 32;
const INVISIBLE = 64;

/** How far dim text moves toward the background. Mixed as a solid colour, so LCD antialiasing survives. */
const DIM_MIX = 0.45;

/** The xterm 256-colour palette: 16 ANSI (from the theme), a 6x6x6 cube, then 24 greys. */
function buildPalette(ansi: readonly string[]): string[] {
  const out = ansi.slice(0, 16);
  const level = [0, 95, 135, 175, 215, 255];
  for (let i = 0; i < 216; i++) {
    const r = level[Math.floor(i / 36)] ?? 0;
    const g = level[Math.floor(i / 6) % 6] ?? 0;
    const b = level[i % 6] ?? 0;
    out.push(`rgb(${r},${g},${b})`);
  }
  for (let i = 0; i < 24; i++) {
    const v = 8 + i * 10;
    out.push(`rgb(${v},${v},${v})`);
  }
  return out;
}

function rgbString(value: number): string {
  return `#${(value & 0xffffff).toString(16).padStart(6, '0')}`;
}

/** [r, g, b] of a `#rgb`, `#rrggbb`, `rgb()` or `rgba()` colour, or null for anything else. */
function parseColor(c: string): [number, number, number] | null {
  let m = /^#([0-9a-f]{6})/i.exec(c);
  if (m) {
    const n = parseInt(m[1] ?? '0', 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(c);
  if (m) return [parseInt((m[1] ?? '0').repeat(2), 16), parseInt((m[2] ?? '0').repeat(2), 16), parseInt((m[3] ?? '0').repeat(2), 16)];
  m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(c);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return null;
}

/**
 * Line weights for box-drawing characters, as [up, right, down, left].
 * 0 none, 1 light, 2 heavy. Drawn as rectangles so lines join across cells
 * with no gap, which a font glyph cannot do once line-height is above 1.
 */
const BOX: Readonly<Record<number, readonly [number, number, number, number]>> = (() => {
  const t: Record<number, readonly [number, number, number, number]> = {};
  const rows: readonly (readonly [number, string])[] = [
    [0x2500, '0101'], [0x2501, '0202'], [0x2502, '1010'], [0x2503, '2020'],
    [0x250c, '0110'], [0x250d, '0210'], [0x250e, '0120'], [0x250f, '0220'],
    [0x2510, '0011'], [0x2511, '0012'], [0x2512, '0021'], [0x2513, '0022'],
    [0x2514, '1100'], [0x2515, '1200'], [0x2516, '2100'], [0x2517, '2200'],
    [0x2518, '1001'], [0x2519, '1002'], [0x251a, '2001'], [0x251b, '2002'],
    [0x251c, '1110'], [0x251d, '1210'], [0x251e, '2110'], [0x251f, '1120'],
    [0x2520, '2120'], [0x2521, '2210'], [0x2522, '1220'], [0x2523, '2220'],
    [0x2524, '1011'], [0x2525, '1012'], [0x2526, '2011'], [0x2527, '1021'],
    [0x2528, '2021'], [0x2529, '2012'], [0x252a, '1022'], [0x252b, '2022'],
    [0x252c, '0111'], [0x252d, '0112'], [0x252e, '0211'], [0x252f, '0212'],
    [0x2530, '0121'], [0x2531, '0122'], [0x2532, '0221'], [0x2533, '0222'],
    [0x2534, '1101'], [0x2535, '1102'], [0x2536, '1201'], [0x2537, '1202'],
    [0x2538, '2101'], [0x2539, '2102'], [0x253a, '2201'], [0x253b, '2202'],
    [0x253c, '1111'], [0x253d, '1112'], [0x253e, '1211'], [0x253f, '1212'],
    [0x2540, '2111'], [0x2541, '1121'], [0x2542, '2121'], [0x2543, '2112'],
    [0x2544, '2211'], [0x2545, '1122'], [0x2546, '1221'], [0x2547, '2212'],
    [0x2548, '1222'], [0x2549, '2122'], [0x254a, '2221'], [0x254b, '2222'],
  ];
  for (const [code, w] of rows) {
    t[code] = [Number(w[0]), Number(w[1]), Number(w[2]), Number(w[3])];
  }
  return t;
})();

/** Double-line characters as [up, right, down, left] presence. */
const DOUBLE: Readonly<Record<number, readonly [number, number, number, number]>> = {
  0x2550: [0, 1, 0, 1],
  0x2551: [1, 0, 1, 0],
  0x2554: [0, 1, 1, 0],
  0x2557: [0, 0, 1, 1],
  0x255a: [1, 1, 0, 0],
  0x255d: [1, 0, 0, 1],
  0x2560: [1, 1, 1, 0],
  0x2563: [1, 0, 1, 1],
  0x2566: [0, 1, 1, 1],
  0x2569: [1, 1, 0, 1],
  0x256c: [1, 1, 1, 1],
};

/** Quadrant blocks U+2596..U+259F as [upper-left, upper-right, lower-left, lower-right]. */
const QUADRANT: Readonly<Record<number, readonly [number, number, number, number]>> = {
  0x2596: [0, 0, 1, 0],
  0x2597: [0, 0, 0, 1],
  0x2598: [1, 0, 0, 0],
  0x2599: [1, 0, 1, 1],
  0x259a: [1, 0, 0, 1],
  0x259b: [1, 1, 1, 0],
  0x259c: [1, 1, 0, 1],
  0x259d: [0, 1, 0, 0],
  0x259e: [0, 1, 1, 0],
  0x259f: [0, 1, 1, 1],
};

export class CanvasRenderer {
  private readonly term: Terminal;
  private readonly opts: RendererOptions;
  private screen: HTMLElement | null = null;
  private text: HTMLCanvasElement | null = null;
  private cursor: HTMLCanvasElement | null = null;
  private textCtx: CanvasRenderingContext2D | null = null;
  private cursorCtx: CanvasRenderingContext2D | null = null;

  private theme: RenderTheme;
  private palette: string[];
  private quality: RenderQuality = DEFAULT_QUALITY;
  private readonly rgbCache = new Map<number, string>();
  private readonly mixCache = new Map<string, string>();
  private readonly scratch: IBufferCell | undefined;

  /** Search hits, by absolute row, and the one that is current. */
  private marks = new Map<number, CellRange[]>();
  private currentMark: CellRange | null = null;
  private hover: LinkSpan | null = null;

  private drawQueued = false;
  private cursorFrame = 0;
  private disposed = false;
  private focused = false;

  // Backing store and cell metrics, all in canvas pixels (device pixels times the
  // supersample factor). The cell grid is taken from xterm's own screen box, so
  // the canvas always lines up with xterm's mouse and selection mapping.
  private bw = 0;
  private bh = 0;
  /** Canvas pixels per CSS pixel. */
  private scale = 1;
  private cw = 0;
  private ch = 0;
  private ascent = 0;
  private fontKey = '';
  /** The canvas box in exact device pixels, when the browser reports it. */
  private devBox: { readonly w: number; readonly h: number } | null = null;
  private reported = '';

  // Cursor animation state.
  private glideX = 0;
  private glideY = -1;
  private lastFrame = 0;

  private readonly subs: { dispose: () => void }[] = [];
  private resizeObs: ResizeObserver | null = null;
  private boxObs: ResizeObserver | null = null;
  /** Whether the current text canvas was created opaque (LCD antialiasing possible). */
  private opaque = false;
  private readonly onWindowResize = (): void => {
    this.requestDraw();
    this.kickCursor();
  };

  constructor(term: Terminal, opts: RendererOptions) {
    this.term = term;
    this.opts = opts;
    this.theme = opts.getTheme();
    this.palette = buildPalette(this.theme.ansi);
    this.scratch = term.buffer.active.getNullCell();
  }

  /** Create the canvases over xterm's screen. Call after `term.open()`. */
  attach(): void {
    const screen = this.term.element?.querySelector<HTMLElement>('.xterm-screen');
    if (!screen) return;
    this.screen = screen;

    const make = (z: number): HTMLCanvasElement => {
      const c = document.createElement('canvas');
      c.className = 'tw-canvas';
      c.style.cssText = `position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:${z}`;
      screen.appendChild(c);
      return c;
    };
    this.text = make(2);
    this.cursor = make(3);
    this.opaque = this.wantsOpaque();
    // Opaque: the browser only uses LCD (subpixel) antialiasing for text drawn on opaque pixels.
    this.textCtx = this.text.getContext('2d', { alpha: !this.opaque });
    this.cursorCtx = this.cursor.getContext('2d', { alpha: true });

    const t = this.term;
    const redraw = (): void => this.requestDraw();
    this.subs.push(
      t.onRender(redraw),
      t.onWriteParsed(redraw),
      t.onScroll(redraw),
      t.onSelectionChange(redraw),
      t.onResize(redraw),
      t.onCursorMove(() => this.kickCursor()),
    );

    this.resizeObs = new ResizeObserver(redraw);
    this.resizeObs.observe(screen);

    // The canvas box in whole device pixels, re-reported on resize, zoom and when
    // the window moves to a screen with another scale. Safari does not support the
    // option; it falls back to rounding CSS size times devicePixelRatio.
    const box = new ResizeObserver((entries) => {
      const size = entries[0]?.devicePixelContentBoxSize?.[0];
      if (size) this.devBox = { w: size.inlineSize, h: size.blockSize };
      this.onWindowResize();
    });
    try {
      box.observe(this.text, { box: 'device-pixel-content-box' });
    } catch {
      box.observe(this.text);
    }
    this.boxObs = box;
    window.addEventListener('resize', this.onWindowResize);

    this.requestDraw();
    this.kickCursor();
  }

  setFocused(value: boolean): void {
    if (this.focused === value) return;
    this.focused = value;
    this.kickCursor();
  }

  /** Re-read the theme (site theme switched) and repaint. */
  refreshTheme(): void {
    this.theme = this.opts.getTheme();
    this.palette = buildPalette(this.theme.ansi);
    this.rgbCache.clear();
    this.mixCache.clear();
    this.requestDraw();
    this.kickCursor();
  }

  /** Change how text is rasterised, and repaint. */
  setQuality(q: RenderQuality): void {
    const now = this.quality;
    if (q.supersample === now.supersample && q.weight === now.weight && q.boldBright === now.boldBright && q.antialias === now.antialias) return;
    this.quality = q;
    this.fontKey = '';
    // A context's alpha is fixed at creation, so switching LCD on or off needs a new canvas.
    if (this.text && this.wantsOpaque() !== this.opaque) this.replaceTextCanvas();
    this.requestDraw();
    this.kickCursor();
  }

  /** LCD antialiasing needs an opaque canvas, and only makes sense at one canvas pixel per screen pixel. */
  private wantsOpaque(): boolean {
    return this.quality.antialias === 'lcd' && this.quality.supersample === 1;
  }

  private replaceTextCanvas(): void {
    const old = this.text;
    if (!old) return;
    const next = old.cloneNode(false) as HTMLCanvasElement;
    old.replaceWith(next);
    this.boxObs?.unobserve(old);
    try {
      this.boxObs?.observe(next, { box: 'device-pixel-content-box' });
    } catch {
      this.boxObs?.observe(next);
    }
    this.text = next;
    this.opaque = this.wantsOpaque();
    this.textCtx = next.getContext('2d', { alpha: !this.opaque });
  }

  /** Search hits to tint under the text. Pass an empty list to clear. */
  setMarks(ranges: readonly CellRange[], current: CellRange | null): void {
    this.marks.clear();
    for (const r of ranges) {
      const row = this.marks.get(r.row);
      if (row) row.push(r);
      else this.marks.set(r.row, [r]);
    }
    this.currentMark = current;
    this.requestDraw();
  }

  /** Underline a hovered link, or clear it with null. */
  setHover(span: LinkSpan | null): void {
    this.hover = span;
    this.requestDraw();
  }

  requestDraw(): void {
    if (this.drawQueued || this.disposed) return;
    this.drawQueued = true;
    requestAnimationFrame(() => {
      this.drawQueued = false;
      if (!this.disposed) this.drawText();
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const s of this.subs) s.dispose();
    this.subs.length = 0;
    this.resizeObs?.disconnect();
    this.boxObs?.disconnect();
    window.removeEventListener('resize', this.onWindowResize);
    if (this.cursorFrame) cancelAnimationFrame(this.cursorFrame);
    this.text?.remove();
    this.cursor?.remove();
  }

  // ---------------------------------------------------------------- sizing

  /**
   * Work out the backing-store size and cell metrics for the current screen box.
   * Returns false while the terminal has no size (hidden window).
   */
  private layout(): boolean {
    const screen = this.screen;
    if (!screen) return false;
    const cssW = screen.clientWidth;
    const cssH = screen.clientHeight;
    const cols = this.term.cols;
    const rows = this.term.rows;
    if (cssW <= 0 || cssH <= 0 || cols <= 0 || rows <= 0) return false;
    const dpr = window.devicePixelRatio || 1;
    // A box reported for an older size (the observer runs after layout) is ignored
    // until the observer catches up and asks for another frame.
    const box = this.devBox;
    const fresh = box !== null && Math.abs(box.w - cssW * dpr) < 2 && Math.abs(box.h - cssH * dpr) < 2;
    const dw = fresh ? box.w : Math.round(cssW * dpr);
    const dh = fresh ? box.h : Math.round(cssH * dpr);
    const ss = dpr * this.quality.supersample > MAX_SCALE ? 1 : this.quality.supersample;
    this.bw = dw * ss;
    this.bh = dh * ss;
    this.scale = (dw / cssW) * ss;
    this.cw = this.bw / cols;
    this.ch = this.bh / rows;
    const key = `${this.bw}x${this.bh}@${this.scale.toFixed(3)}`;
    if (key !== this.reported) {
      this.reported = key;
      this.opts.onRenderSize?.(this.bw, this.bh, this.scale, ss > 1);
    }
    return true;
  }

  /** Match a canvas's backing store to the layout. Resizing clears it and its state. */
  private fit(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): void {
    if (canvas.width !== this.bw || canvas.height !== this.bh) {
      canvas.width = this.bw;
      canvas.height = this.bh;
      this.fontKey = '';
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** Left edge of a column, in whole canvas pixels. Shared by neighbours, so runs never leave seams. */
  private colX(x: number): number {
    return Math.round(x * this.cw);
  }

  /** Top edge of a row, in whole canvas pixels. */
  private rowY(y: number): number {
    return Math.round(y * this.ch);
  }

  private fontFor(bold: boolean, italic: boolean): string {
    const size = (this.term.options.fontSize ?? 14) * this.scale;
    return `${italic ? 'italic ' : ''}${bold ? 700 : this.quality.weight} ${size}px ${this.opts.fontFamily}`;
  }

  /** Vertical placement of the baseline inside a cell, for the current font. */
  private measure(ctx: CanvasRenderingContext2D): void {
    const key = `${this.term.options.fontSize}|${this.scale}|${this.ch.toFixed(3)}|${this.quality.weight}`;
    if (key === this.fontKey) return;
    this.fontKey = key;
    ctx.font = this.fontFor(false, false);
    const m = ctx.measureText('M');
    const asc = m.fontBoundingBoxAscent ?? m.actualBoundingBoxAscent ?? this.ch * 0.8;
    const desc = m.fontBoundingBoxDescent ?? m.actualBoundingBoxDescent ?? this.ch * 0.2;
    // Whole pixels: a baseline between two pixel rows smears every horizontal stroke.
    this.ascent = Math.round((this.ch - (asc + desc)) / 2 + asc);
  }

  /** Stroke width of a light line, in canvas pixels. */
  private lightLine(): number {
    return Math.max(1, Math.round(this.cw / 8));
  }

  // ---------------------------------------------------------------- colours

  private rgb(value: number): string {
    let s = this.rgbCache.get(value);
    if (s === undefined) {
      s = rgbString(value);
      this.rgbCache.set(value, s);
    }
    return s;
  }

  private fgOf(cell: IBufferCell, bold: boolean): string | null {
    if (cell.isFgRGB()) return this.rgb(cell.getFgColor());
    if (cell.isFgPalette()) {
      let i = cell.getFgColor();
      // Classic xterm: bold text in the eight base colours uses the bright ones.
      if (bold && i < 8 && this.quality.boldBright) i += 8;
      return this.palette[i] ?? null;
    }
    return null;
  }

  private bgOf(cell: IBufferCell): string | null {
    if (cell.isBgRGB()) return this.rgb(cell.getBgColor());
    if (cell.isBgPalette()) return this.palette[cell.getBgColor()] ?? null;
    return null;
  }

  /** `color` moved toward the background, as a solid colour. Null if it cannot be parsed. */
  private dimmed(color: string): string | null {
    let v = this.mixCache.get(color);
    if (v === undefined) {
      const a = parseColor(color);
      const b = parseColor(this.theme.background);
      v = a && b
        ? `rgb(${Math.round(a[0] + (b[0] - a[0]) * DIM_MIX)},${Math.round(a[1] + (b[1] - a[1]) * DIM_MIX)},${Math.round(a[2] + (b[2] - a[2]) * DIM_MIX)})`
        : '';
      this.mixCache.set(color, v);
    }
    return v || null;
  }

  // ---------------------------------------------------------------- text layer

  private drawText(): void {
    const canvas = this.text;
    const ctx = this.textCtx;
    const scratch = this.scratch;
    if (!canvas || !ctx || !scratch) return;
    if (!this.layout()) return;
    this.fit(canvas, ctx);
    this.measure(ctx);

    const term = this.term;
    const buf = term.buffer.active;
    const theme = this.theme;
    const cols = term.cols;
    const rows = term.rows;
    ctx.globalAlpha = 1;
    ctx.fillStyle = theme.background;
    ctx.fillRect(0, 0, this.bw, this.bh);
    ctx.textBaseline = 'alphabetic';
    ctx.fontKerning = 'none';

    // Selection in absolute buffer rows.
    const sel = term.getSelectionPosition();
    const deco = Math.max(1, Math.round(this.ch / 14));

    let font = '';
    let fill = '';

    const chars: string[] = new Array<string>(cols);
    const widths: number[] = new Array<number>(cols);
    const fgs: (string | null)[] = new Array<string | null>(cols);
    const attrs: number[] = new Array<number>(cols);

    for (let y = 0; y < rows; y++) {
      const absRow = buf.viewportY + y;
      const line: IBufferLine | undefined = buf.getLine(absRow);
      if (!line) continue;
      const top = this.rowY(y);
      const bottom = this.rowY(y + 1);
      const rh = bottom - top;
      const baseline = top + this.ascent;

      // Pass 1: gather the row and paint cell backgrounds in merged runs.
      let runStart = 0;
      let runColor: string | null = null;

      for (let x = 0; x < cols; x++) {
        const cell = line.getCell(x, scratch);
        let bgc: string | null = null;
        if (!cell) {
          chars[x] = '';
          widths[x] = 1;
          fgs[x] = null;
          attrs[x] = 0;
        } else {
          const bold = !!cell.isBold();
          let a = 0;
          if (bold) a |= BOLD;
          if (cell.isItalic()) a |= ITALIC;
          if (cell.isDim()) a |= DIM;
          if (cell.isUnderline()) a |= UNDERLINE;
          if (cell.isStrikethrough()) a |= STRIKE;
          if (cell.isOverline()) a |= OVERLINE;
          if (cell.isInvisible()) a |= INVISIBLE;
          let fg = this.fgOf(cell, bold);
          bgc = this.bgOf(cell);
          if (cell.isInverse()) {
            const f = fg ?? theme.foreground;
            fg = bgc ?? theme.background;
            bgc = f;
          }
          chars[x] = cell.getChars();
          widths[x] = cell.getWidth();
          fgs[x] = fg;
          attrs[x] = a;
        }
        if (bgc !== runColor) {
          if (runColor !== null) this.fillBox(ctx, this.colX(runStart), top, this.colX(x), bottom, runColor);
          runStart = x;
          runColor = bgc;
        }
      }
      if (runColor !== null) this.fillBox(ctx, this.colX(runStart), top, this.colX(cols), bottom, runColor);

      // Selection, drawn under the glyphs.
      if (sel) this.selectionRow(ctx, sel, absRow, top, rh, cols);

      // Search hits, the current one stronger.
      const hits = this.marks.get(absRow);
      if (hits) {
        const cur = this.currentMark;
        const inset = Math.max(1, Math.round(this.scale));
        for (const h of hits) {
          const isCur = cur !== null && cur.row === h.row && cur.col === h.col;
          const hx = this.colX(h.col);
          const hw = this.colX(h.col + h.len) - hx;
          ctx.fillStyle = isCur ? 'rgba(255,149,0,0.45)' : 'rgba(255,214,10,0.26)';
          ctx.beginPath();
          if (typeof ctx.roundRect === 'function') ctx.roundRect(hx, top + inset, hw, rh - 2 * inset, 3 * this.scale);
          else ctx.rect(hx, top, hw, rh);
          ctx.fill();
          if (isCur) {
            ctx.strokeStyle = 'rgb(255,149,0)';
            ctx.lineWidth = 1.5 * this.scale;
            ctx.stroke();
          }
        }
      }

      // Pass 2: glyphs and decorations. Backgrounds, selection and hits above
      // changed fillStyle, so the cached colour is stale.
      fill = '';
      for (let x = 0; x < cols; x++) {
        const w = widths[x] ?? 1;
        const str = chars[x] ?? '';
        const a = attrs[x] ?? 0;
        if (w === 0) continue;
        let color = fgs[x] ?? theme.foreground;
        let fade = false;
        if (a & DIM) {
          const d = this.dimmed(color);
          if (d) color = d;
          else fade = true;
        }
        const left = this.colX(x);
        const right = this.colX(x + w);

        if (str !== '' && str !== ' ' && !(a & INVISIBLE)) {
          if (fade) ctx.globalAlpha = 1 - DIM_MIX;
          if (color !== fill) {
            ctx.fillStyle = color;
            fill = color;
          }
          const code = str.codePointAt(0) ?? 0;
          if (!this.special(ctx, code, left, top, this.colX(x + 1), bottom)) {
            const f = this.fontFor(!!(a & BOLD), !!(a & ITALIC));
            if (f !== font) {
              ctx.font = f;
              font = f;
            }
            ctx.fillText(str, left, baseline);
          }
          if (fade) ctx.globalAlpha = 1;
        }

        if (a & (UNDERLINE | STRIKE | OVERLINE)) {
          if (color !== fill) {
            ctx.fillStyle = color;
            fill = color;
          }
          if (a & UNDERLINE) ctx.fillRect(left, Math.min(bottom - deco, baseline + deco), right - left, deco);
          if (a & STRIKE) ctx.fillRect(left, top + Math.round(rh * 0.52), right - left, deco);
          if (a & OVERLINE) ctx.fillRect(left, top, right - left, deco);
        }
      }

      // Hovered link: underline in the cursor colour.
      const hv = this.hover;
      if (hv && absRow >= hv.y1 && absRow <= hv.y2) {
        const from = absRow === hv.y1 ? hv.x1 : 0;
        const to = absRow === hv.y2 ? hv.x2 + 1 : cols;
        ctx.fillStyle = theme.cursor;
        fill = theme.cursor;
        ctx.fillRect(this.colX(from), Math.min(bottom - deco, baseline + deco), this.colX(to) - this.colX(from), deco);
      }
    }
  }

  /** Fill the box between two pairs of whole-pixel edges. */
  private fillBox(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, color: string): void {
    ctx.fillStyle = color;
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  }

  /** Paint the selected part of one row with softly rounded ends. */
  private selectionRow(
    ctx: CanvasRenderingContext2D,
    sel: { start: { x: number; y: number }; end: { x: number; y: number } },
    absRow: number,
    top: number,
    rh: number,
    cols: number,
  ): void {
    // Normalise: start is the earlier cell.
    let s = sel.start;
    let e = sel.end;
    if (e.y < s.y || (e.y === s.y && e.x < s.x)) [s, e] = [e, s];
    if (absRow < s.y || absRow > e.y) return;
    const from = absRow === s.y ? s.x : 0;
    const to = absRow === e.y ? e.x : cols;
    if (to <= from) return;
    const x = this.colX(from);
    const w = this.colX(to) - x;
    ctx.fillStyle = this.theme.selection;
    ctx.beginPath();
    const r = Math.min(4 * this.scale, rh / 4);
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(x, top, w, rh, [
        absRow === s.y ? r : 0,
        absRow === e.y ? r : 0,
        absRow === e.y ? r : 0,
        absRow === s.y ? r : 0,
      ]);
    } else {
      ctx.rect(x, top, w, rh);
    }
    ctx.fill();
  }

  /**
   * Block elements and box-drawing lines drawn as exact shapes. They fill the
   * whole cell, so TUIs (htop, tmux, btop) join up with no gaps between rows.
   * The cell is given as whole-pixel edges. Returns false when the character is
   * left to the font.
   */
  private special(ctx: CanvasRenderingContext2D, code: number, x0: number, y0: number, x1: number, y1: number): boolean {
    const w = x1 - x0;
    const h = y1 - y0;
    if (code >= 0x2580 && code <= 0x259f) {
      const half = (fx: number, fy: number, fw: number, fh: number): void =>
        this.fillSnapped(ctx, x0 + fx * w, y0 + fy * h, fw * w, fh * h);
      if (code === 0x2580) half(0, 0, 1, 0.5);
      else if (code >= 0x2581 && code <= 0x2588) {
        const n = (code - 0x2580) / 8;
        half(0, 1 - n, 1, n);
      } else if (code >= 0x2589 && code <= 0x258f) {
        half(0, 0, (0x2590 - code) / 8, 1);
      } else if (code === 0x2590) half(0.5, 0, 0.5, 1);
      else if (code >= 0x2591 && code <= 0x2593) {
        const prev = ctx.globalAlpha;
        ctx.globalAlpha = prev * (code === 0x2591 ? 0.25 : code === 0x2592 ? 0.5 : 0.75);
        half(0, 0, 1, 1);
        ctx.globalAlpha = prev;
      } else if (code === 0x2594) half(0, 0, 1, 1 / 8);
      else if (code === 0x2595) half(7 / 8, 0, 1 / 8, 1);
      else {
        const q = QUADRANT[code];
        if (!q) return false;
        if (q[0]) half(0, 0, 0.5, 0.5);
        if (q[1]) half(0.5, 0, 0.5, 0.5);
        if (q[2]) half(0, 0.5, 0.5, 0.5);
        if (q[3]) half(0.5, 0.5, 0.5, 0.5);
      }
      return true;
    }

    const light = this.lightLine();
    const heavy = light * 2;

    // Rounded corners: one light arc each, centred on the same pixel column and
    // row as the straight lines they meet.
    if (code >= 0x256d && code <= 0x2570) {
      const cx = x0 + Math.floor((w - light) / 2) + light / 2;
      const cy = y0 + Math.floor((h - light) / 2) + light / 2;
      const r = Math.min(w, h) / 2;
      ctx.lineWidth = light;
      ctx.strokeStyle = ctx.fillStyle;
      ctx.beginPath();
      if (code === 0x256d) {
        ctx.moveTo(cx, y1);
        ctx.lineTo(cx, cy + r);
        ctx.quadraticCurveTo(cx, cy, cx + r, cy);
        ctx.lineTo(x1, cy);
      } else if (code === 0x256e) {
        ctx.moveTo(cx, y1);
        ctx.lineTo(cx, cy + r);
        ctx.quadraticCurveTo(cx, cy, cx - r, cy);
        ctx.lineTo(x0, cy);
      } else if (code === 0x256f) {
        ctx.moveTo(cx, y0);
        ctx.lineTo(cx, cy - r);
        ctx.quadraticCurveTo(cx, cy, cx - r, cy);
        ctx.lineTo(x0, cy);
      } else {
        ctx.moveTo(cx, y0);
        ctx.lineTo(cx, cy - r);
        ctx.quadraticCurveTo(cx, cy, cx + r, cy);
        ctx.lineTo(x1, cy);
      }
      ctx.stroke();
      return true;
    }

    const box = BOX[code];
    if (box) {
      const [up, right, down, left] = box;
      const thick = Math.max(up, right, down, left) === 2 ? heavy : light;
      // Where the centre strokes cross, in whole pixels, so every row and column
      // puts its line on the same pixels and lines join across cells.
      const hc = y0 + Math.floor((h - thick) / 2);
      const vc = x0 + Math.floor((w - thick) / 2);
      const vx = (t: number): number => x0 + Math.floor((w - t) / 2);
      const hy = (t: number): number => y0 + Math.floor((h - t) / 2);
      // Each arm runs from the cell edge to the far side of the crossing, so joints fill in.
      if (up) {
        const t = up === 2 ? heavy : light;
        ctx.fillRect(vx(t), y0, t, hc + thick - y0);
      }
      if (down) {
        const t = down === 2 ? heavy : light;
        ctx.fillRect(vx(t), hc, t, y1 - hc);
      }
      if (left) {
        const t = left === 2 ? heavy : light;
        ctx.fillRect(x0, hy(t), vc + thick - x0, t);
      }
      if (right) {
        const t = right === 2 ? heavy : light;
        ctx.fillRect(vc, hy(t), x1 - vc, t);
      }
      return true;
    }

    // Double lines. Each arm is two parallel strands; a strand stops short where the
    // perpendicular arm on its open side leaves a gap, and closes the corner where
    // there is no arm to continue into.
    const dbl = DOUBLE[code];
    if (dbl) {
      const [u, r, d, l] = dbl;
      const lw = light;
      const g = Math.max(lw + 1, Math.round(lw * 1.5));
      const cx = x0 + Math.floor(w / 2);
      const cy = y0 + Math.floor(h / 2);
      const half = lw / 2;
      if (l || r) {
        for (const side of [-1, 1]) {
          const sy = cy + side * g - half;
          const open = side < 0 ? u : d;
          const cutL = cx - g + half;
          const cutR = cx + g - half;
          if (open) {
            if (l) this.fillSnapped(ctx, x0, sy, cutL - x0, lw);
            if (r) this.fillSnapped(ctx, cutR, sy, x1 - cutR, lw);
          } else {
            const xa = l ? x0 : cx - g - half;
            const xb = r ? x1 : cx + g + half;
            this.fillSnapped(ctx, xa, sy, xb - xa, lw);
          }
        }
      }
      if (u || d) {
        for (const side of [-1, 1]) {
          const sx = cx + side * g - half;
          const open = side < 0 ? l : r;
          const cutT = cy - g + half;
          const cutB = cy + g - half;
          if (open) {
            if (u) this.fillSnapped(ctx, sx, y0, lw, cutT - y0);
            if (d) this.fillSnapped(ctx, sx, cutB, lw, y1 - cutB);
          } else {
            const ya = u ? y0 : cy - g - half;
            const yb = d ? y1 : cy + g + half;
            this.fillSnapped(ctx, sx, ya, lw, yb - ya);
          }
        }
      }
      return true;
    }
    return false;
  }

  /** Fill a rectangle with its edges rounded to whole canvas pixels, at least one pixel each way. */
  private fillSnapped(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
    const xa = Math.round(x);
    const ya = Math.round(y);
    const xb = Math.round(x + w);
    const yb = Math.round(y + h);
    ctx.fillRect(xa, ya, Math.max(xb - xa, 1), Math.max(yb - ya, 1));
  }

  // ---------------------------------------------------------------- cursor layer

  /** Start (or continue) the cursor animation loop. It stops itself when nothing moves. */
  private kickCursor(): void {
    if (this.cursorFrame || this.disposed) return;
    this.lastFrame = performance.now();
    this.cursorFrame = requestAnimationFrame(this.cursorTick);
  }

  private readonly cursorTick = (now: number): void => {
    this.cursorFrame = 0;
    if (this.disposed) return;
    const keepGoing = this.drawCursor(now);
    this.lastFrame = now;
    if (keepGoing) this.cursorFrame = requestAnimationFrame(this.cursorTick);
  };

  /** Draw one cursor frame. Returns true while it still needs frames (pulse or glide). */
  private drawCursor(now: number): boolean {
    const canvas = this.cursor;
    const ctx = this.cursorCtx;
    if (!canvas || !ctx || !this.layout()) return false;
    if (canvas.width !== this.bw || canvas.height !== this.bh) {
      canvas.width = this.bw;
      canvas.height = this.bh;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const term = this.term;
    ctx.clearRect(0, 0, this.bw, this.bh);

    const buf = term.buffer.active;
    // xterm's private flag for DECTCEM (TUIs hide the cursor while they draw).
    const core = (term as unknown as { _core?: { coreService?: { isCursorHidden?: boolean } } })._core;
    const hidden = core?.coreService?.isCursorHidden === true;
    // Scrolled back into history: the live cursor is off screen.
    if (hidden || buf.viewportY !== buf.baseY) {
      this.glideY = -1;
      return false;
    }

    const tx = buf.cursorX;
    const ty = buf.cursorY;
    // Glide sideways along a row; any row change snaps, so output never smears.
    if (this.glideY !== ty) {
      this.glideX = tx;
      this.glideY = ty;
    }
    const dt = Math.max(0, now - this.lastFrame);
    const k = 1 - Math.exp(-dt / GLIDE_MS);
    this.glideX += (tx - this.glideX) * k;
    const moving = Math.abs(tx - this.glideX) > 0.004;
    if (!moving) this.glideX = tx;

    const theme = this.theme;
    const style = term.options.cursorStyle ?? 'bar';
    const px = Math.max(1, Math.round(this.scale));
    const x = Math.round(this.glideX * this.cw);
    const cellW = this.colX(tx + 1) - this.colX(tx);
    const y = this.rowY(ty);
    const rh = this.rowY(ty + 1) - y;
    ctx.fillStyle = theme.cursor;
    ctx.strokeStyle = theme.cursor;

    if (!this.focused) {
      // Unfocused window: a hollow box, no animation.
      ctx.lineWidth = px;
      ctx.strokeRect(x + px / 2, y + px * 1.5, cellW - px, rh - px * 3);
      return moving;
    }

    // Soft pulse instead of a hard blink.
    const blink = term.options.cursorBlink !== false;
    const phase = (now % BLINK_PERIOD_MS) / BLINK_PERIOD_MS;
    const alpha = blink ? 0.3 + 0.7 * (0.5 + 0.5 * Math.cos(phase * Math.PI * 2)) : 1;
    ctx.globalAlpha = alpha;
    ctx.shadowColor = theme.cursor;
    ctx.shadowBlur = 10 * this.scale;

    if (style === 'block') {
      ctx.fillRect(x, y + px, cellW, rh - 2 * px);
      ctx.shadowBlur = 0;
      // The character under a block cursor flips to the background colour.
      const line = buf.getLine(buf.viewportY + ty);
      const cell = line?.getCell(tx, this.scratch);
      const str = cell?.getChars() ?? '';
      if (str.trim() !== '') {
        ctx.fillStyle = theme.background;
        ctx.font = this.fontFor(!!cell?.isBold(), !!cell?.isItalic());
        ctx.textBaseline = 'alphabetic';
        ctx.globalAlpha = 1;
        ctx.fillText(str, this.colX(tx), y + this.ascent);
      }
    } else if (style === 'underline') {
      ctx.fillRect(x, y + rh - 3 * px, cellW, 2 * px);
    } else {
      const width = Math.max(1, Math.round((term.options.cursorWidth ?? 2) * this.scale));
      ctx.fillRect(x, y + 2 * px, width, rh - 4 * px);
    }
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    return blink || moving;
  }
}
