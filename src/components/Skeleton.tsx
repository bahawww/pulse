import { type CSSProperties, type JSX } from 'react';

interface BoneProps {
  /** CSS width, e.g. '40%' or 120. Default 100%. */
  readonly w?: number | string;
  /** CSS height. Default 12px, roughly one line of small text. */
  readonly h?: number | string;
  /** Pill instead of the default small radius. */
  readonly round?: boolean;
  readonly className?: string;
  readonly style?: CSSProperties;
}

/** One placeholder block. Shimmers, or holds still under reduced motion. */
export function Bone({ w = '100%', h = 12, round = false, className = '', style }: BoneProps): JSX.Element {
  return (
    <span
      className={`bone${round ? ' is-round' : ''}${className ? ` ${className}` : ''}`}
      style={{ width: w, height: h, ...style }}
      aria-hidden="true"
    />
  );
}

/** Lines of text with ragged right edges, so it reads as text and not a table. */
export function BoneLines({ count = 3 }: { readonly count?: number }): JSX.Element {
  const widths = ['92%', '78%', '85%', '64%', '88%', '72%'];
  return (
    <div className="bone-lines" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <Bone key={i} w={widths[i % widths.length]} />
      ))}
    </div>
  );
}

/** Rows of "dot, name, value", the shape of most lists in Pulse. */
export function BoneRows({ count = 4, dense = false }: { readonly count?: number; readonly dense?: boolean }): JSX.Element {
  return (
    <div className={`bone-rows${dense ? ' is-dense' : ''}`} aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="bone-row">
          <Bone w={10} h={10} round />
          <Bone w={`${38 + ((i * 17) % 30)}%`} />
          <Bone w={48} className="bone-end" />
        </div>
      ))}
    </div>
  );
}

/** A card with a title, a subtitle and a body: a chart block or rows. */
export function SkeletonCard({
  rows,
  chart,
  className = '',
}: {
  readonly rows?: number;
  readonly chart?: number;
  readonly className?: string;
}): JSX.Element {
  return (
    <div className={`card skeleton-card${className ? ` ${className}` : ''}`} aria-hidden="true">
      <div className="skeleton-head">
        <Bone w="34%" h={14} />
        <Bone w="58%" h={10} />
      </div>
      {chart !== undefined && <Bone h={chart} className="bone-chart" />}
      {rows !== undefined && <BoneRows count={rows} />}
    </div>
  );
}

/**
 * Wraps placeholders so a screen reader hears one "Loading <what>" instead of
 * nothing, while the bones themselves stay hidden from it.
 */
export function Loading({ what, children }: { readonly what: string; readonly children: JSX.Element | JSX.Element[] }): JSX.Element {
  return (
    <div className="skeleton" role="status" aria-busy="true" aria-label={`Loading ${what}`}>
      {children}
    </div>
  );
}
