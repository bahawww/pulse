import fs from 'node:fs';
import type { CpuMetrics } from '../../shared/contract.js';

/**
 * CPU utilisation from /proc/stat jiffy deltas.
 *
 * The load average is deliberately NOT used as the percentage: load is a
 * run-queue depth that can exceed core count and says nothing about how busy
 * the CPU actually is. /proc/stat exposes monotonic counters, so a real
 * percentage requires two samples separated by a measurable amount of time.
 */

interface CpuTimes {
  readonly total: number;
  /** Busy = total - idle - iowait. Guest time is already inside user/nice, and
   *  iowait is genuinely idle from the scheduler's view. */
  readonly busy: number;
}

function parseCpuLine(line: string): CpuTimes | null {
  const parts = line.trim().split(/\s+/);
  // parts: ["cpuN", user, nice, system, idle, iowait, irq, softirq, steal]
  if (parts.length < 5) return null;

  const at = (i: number): number => {
    const n = Number(parts[i]);
    return Number.isFinite(n) ? n : 0;
  };

  const idle = at(4);
  const iowait = at(5);
  const total = at(1) + at(2) + at(3) + idle + iowait + at(6) + at(7) + at(8);
  return { total, busy: total - idle - iowait };
}

export function readCpuTimes(): { total: CpuTimes; cores: CpuTimes[] } | null {
  let raw: string;
  try {
    raw = fs.readFileSync('/proc/stat', 'utf8');
  } catch {
    return null;
  }

  const lines = raw.split('\n');
  const totalLine = lines.find((l) => l.startsWith('cpu '));
  const total = totalLine ? parseCpuLine(totalLine) : null;
  if (!total) return null;

  const cores: CpuTimes[] = [];
  for (const line of lines) {
    if (!/^cpu\d+\s/.test(line)) continue;
    const parsed = parseCpuLine(line);
    if (parsed) cores.push(parsed);
  }
  return { total, cores };
}

/** Busy share between two jiffy samples. A zero span yields 0, never NaN. */
function busyPercent(now: CpuTimes, before: CpuTimes): number {
  const totalDelta = now.total - before.total;
  if (totalDelta <= 0) return 0;
  return Math.min(100, Math.max(0, ((now.busy - before.busy) / totalDelta) * 100));
}

function readLoadavg(): readonly string[] {
  try {
    const raw = fs.readFileSync('/proc/loadavg', 'utf8');
    return raw
      .trim()
      .split(/\s+/)
      .slice(0, 3)
      .map((n) => (Number.isFinite(Number.parseFloat(n)) ? Number.parseFloat(n).toFixed(2) : '0.00'));
  } catch {
    return ['0.00', '0.00', '0.00'];
  }
}

/**
 * Last /proc/stat sample, cached at module scope.
 *
 * The BEST window is the interval between polls (~5s), which is long enough
 * that per-core percentages are stable. Only the very first snapshot has no
 * prior sample, so it takes a short inline reading instead.
 */
let previous: { readonly total: CpuTimes; readonly cores: readonly CpuTimes[] } | null = null;

const FIRST_SAMPLE_WINDOW_MS = 120;

/**
 * Samples /proc/stat twice when there is no baseline, otherwise once and
 * computes the delta against the previous poll.
 *
 * A zero-length window is useless (two reads in the same tick have a zero
 * total delta and can only produce 0%), which is why the cold path sleeps.
 */
export async function collectCpu(model: string, cores: number): Promise<CpuMetrics> {
  const load1m = readLoadavg();

  let before = previous;
  if (!before) {
    const first = readCpuTimes();
    if (!first) return idleCpu(model, cores, load1m);
    await new Promise((resolve) => setTimeout(resolve, FIRST_SAMPLE_WINDOW_MS));
    before = first;
  }

  const after = readCpuTimes();
  if (!after) return idleCpu(model, cores, load1m);

  previous = { total: after.total, cores: after.cores };

  const usage = busyPercent(after.total, before.total);
  const perCore = after.cores.map((core, i) => {
    const prev = before?.cores[i];
    return prev ? busyPercent(core, prev) : 0;
  });

  return {
    model,
    cores,
    load1m: load1m[0] ?? '0.00',
    load5m: load1m[1] ?? '0.00',
    load15m: load1m[2] ?? '0.00',
    usage: Math.round(usage),
    perCore: perCore.map((p) => Math.round(p)),
  };
}

/** Shaped zero when procfs is unreadable — the UI shows this as degraded. */
function idleCpu(model: string, cores: number, load: readonly string[]): CpuMetrics {
  return {
    model,
    cores,
    load1m: load[0] ?? '0.00',
    load5m: load[1] ?? '0.00',
    load15m: load[2] ?? '0.00',
    usage: 0,
    perCore: [],
  };
}