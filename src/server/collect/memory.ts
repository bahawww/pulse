import fs from 'node:fs';
import type { MemoryMetrics } from '../../shared/contract.js';

/**
 * Memory from /proc/meminfo.
 *
 * os.freemem() is misleading on Linux: it counts only completely untouched
 * pages, so a machine that has plenty of cache and reclaimable slab still looks
 * nearly full. MemAvailable is the kernel's own estimate of memory obtainable
 * without swapping, so "used" is total - available.
 */

function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function parseMeminfo(): Map<string, number> {
  const out = new Map<string, number>();
  let raw: string;
  try {
    raw = fs.readFileSync('/proc/meminfo', 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split('\n')) {
    const match = /^(\w+):\s+(\d+)/.exec(line);
    if (match?.[1] && match[2]) out.set(match[1], Number.parseInt(match[2], 10) * 1024);
  }
  return out;
}

const PAGE_SIZE = 4096;

export function collectMemory(): MemoryMetrics {
  const info = parseMeminfo();
  const kb = (key: string): number => info.get(key) ?? 0;

  // Everything is already in bytes; the parse multiplies the kB value by 1024.
  const totalBytes = kb('MemTotal');
  const availableBytes = kb('MemAvailable') || kb('MemFree') || kb('Buffers') || kb('Cached');
  const usedBytes = Math.max(0, totalBytes - availableBytes);
  const percent = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0;

  const swapTotalBytes = kb('SwapTotal');
  const swapFreeBytes = kb('SwapFree');
  const swapUsedBytes = Math.max(0, swapTotalBytes - swapFreeBytes);

  return {
    total: humanBytes(totalBytes),
    used: humanBytes(usedBytes),
    free: humanBytes(availableBytes),
    percent,
    usedBytes,
    totalBytes,
    availableBytes,
    swapTotalBytes,
    swapUsedBytes,
  };
}

export { humanBytes, PAGE_SIZE };