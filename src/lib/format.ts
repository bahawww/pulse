import { formatClock, TZ_LABEL, zoned } from '../shared/time';
/**
 * Byte and rate formatting shared by the telemetry panels.
 *
 * Binary units throughout (KiB/MiB) because that is what /proc reports and
 * what disk tools show; mixing in decimal units makes a "500 GB" disk and a
 * "465.7 GiB" reading look like a 7% discrepancy that does not exist.
 */

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const;

function scale(bytes: number, precision: number): string {
  if (!Number.isFinite(bytes)) return '—';
  const negative = bytes < 0;
  let value = Math.abs(bytes);
  let unit = 0;

  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }

  const digits = unit === 0 ? 0 : value >= 100 ? 0 : precision;
  return `${negative ? '-' : ''}${value.toFixed(digits)} ${UNITS[unit]}`;
}

export function formatBytes(bytes: number): string {
  return scale(bytes, 1);
}

export function formatRate(bytesPerSec: number | null): string {
  if (bytesPerSec === null || !Number.isFinite(bytesPerSec)) return '—';
  // Rounded-to-zero reads as a broken display ("0 mB/s" is milli-BITS, not
  // bytes). Anything under a byte per second is simply idle.
  if (bytesPerSec < 1) return 'idle';
  return `${scale(bytesPerSec, 1)}/s`;
}

/** Compact duration: 45s, 12m, 3h 20m, 4d 6h. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/** Percentage with one decimal below 10, so a quiet CPU still shows movement. */
export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value === 0) return '0';
  if (value < 10) return value.toFixed(1);
  return String(Math.round(value));
}

/**
 * USD cost.
 *
 * Six decimals below a cent, because LLM spend per request is routinely
 * fractions of a penny and rounding to cents would render an entire month as
 * $0.00 — which is indistinguishable from "no data".
 */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value === 0) return '$0';
  if (value < 0.01) return `$${value.toFixed(6)}`;
  if (value < 1) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

/** Token counts: 1.2K / 3.4M / 8.1B. */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}K`;
  if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return `${(value / 1_000_000_000).toFixed(2)}B`;
}

/** Millisecond latency. Sub-10ms keeps a decimal; above that it is noise. */
export function formatMs(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value < 10) return `${value.toFixed(1)}ms`;
  return `${Math.round(value)}ms`;
}

/**
 * Wall-clock label for a history axis, in UTC+7 (src/shared/time.ts).
 *
 * The range decides the format, because a 5-minute window only needs
 * hh:mm:ss while a 12-hour view needs the date too — showing seconds on a
 * 12-hour axis is unreadable, and showing only hh:mm makes every tick from
 * yesterday look like today.
 */
export function formatAxisTime(t: number, spanMs: number): string {
  if (spanMs <= 6 * 3_600_000) return formatClock(t);
  const d = zoned(t);
  const day = String(d.getUTCDate()).padStart(2, '0');
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${day}/${month} ${formatClock(t, false)}`;
}

/**
 * Wall-clock time of day, always 24-hour, in UTC+7: "14:02:11". One formatter
 * for every timestamp in the UI, so the footer, logs, charts and the action log
 * show the same clock whatever zone the viewer's browser is in.
 */
export { formatClock };

/** The display zone's name, shown next to clock times. */
export function zoneLabel(): string {
  return TZ_LABEL;
}

/** "3m ago", "2h ago" — used by the alert feed. */
export function formatAgo(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}