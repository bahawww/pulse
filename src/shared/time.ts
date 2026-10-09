/**
 * One display time zone for the whole app, server and browser alike: UTC+7
 * (the box's local time). Fixed, not the viewer's own zone, so a log line, a
 * chart tooltip and a Telegram alert all show the same clock wherever they are
 * read. Indonesia has no daylight saving, so a constant offset is exact.
 */
export const TZ_OFFSET_MS = 7 * 3_600_000;
export const TZ_LABEL = 'UTC+7';

/** A Date whose UTC fields read as UTC+7 wall-clock time. Use only with getUTC*(). */
export function zoned(ms: number): Date {
  return new Date(ms + TZ_OFFSET_MS);
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** "2026-10-10" in UTC+7. */
export function formatDay(ms: number): string {
  const d = zoned(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** "14:02:11" (or "14:02") in UTC+7, always 24-hour. */
export function formatClock(ms: number, seconds = true): string {
  const d = zoned(ms);
  const hm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return seconds ? `${hm}:${pad(d.getUTCSeconds())}` : hm;
}

/** Epoch ms of 00:00 UTC+7 on the given "YYYY-MM-DD". */
export function dayStart(day: string): number {
  return Date.parse(`${day}T00:00:00Z`) - TZ_OFFSET_MS;
}
