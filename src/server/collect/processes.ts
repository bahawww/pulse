import fs from 'node:fs';
import type { ProcessInfo } from '../../shared/contract.js';
import { PAGE_SIZE } from './memory.js';

/**
 * Top processes by CPU, sampled from /proc/<pid>/stat.
 *
 * CPU time there is a monotonic counter in clock ticks, so a percentage needs a
 * delta against a prior sample — the same constraint as CPU utilisation. The
 * previous reading is cached and the caller supplies the elapsed wall time.
 */

/** USER_HZ is 100 on every mainstream Linux target. */
const CLK_TCK = 100;

interface ProcEntry {
  /** utime + stime in ticks. */
  readonly ticks: number;
  readonly rssBytes: number;
  readonly ppid: number;
  readonly uid: number;
  readonly name: string;
}

/**
 * One read of /proc/<pid>/stat.
 *
 * `comm` can contain spaces and parentheses, so everything is parsed from the
 * LAST ')' — the fields after it are positionally fixed:
 * state(0) ppid(1) pgrp(2) session(3) tty(4) tpgid(5) flags(6) minflt(7)
 * cminflt(8) majflt(9) cmajflt(10) utime(11) stime(12) ... rss(21)
 *
 * There is no uid in this file (it lives in `status`), so ownership comes from
 * the /proc/<pid> directory's own uid, which is the process's real uid.
 */
function readEntry(pid: number): ProcEntry | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    if (close < 0) return null;

    const comm = stat.slice(stat.indexOf('(') + 1, close);
    const f = stat.slice(close + 2).trim().split(/\s+/);

    const utime = Number(f[11]);
    const stime = Number(f[12]);
    if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;

    const rssPages = Number(f[21]);
    const ppid = Number(f[1]);
    const owner = fs.statSync(`/proc/${pid}`).uid;

    return {
      ticks: utime + stime,
      rssBytes: (Number.isFinite(rssPages) ? rssPages : 0) * PAGE_SIZE,
      // ppid 2 = kthreadd parent, i.e. a kernel thread.
      ppid: Number.isFinite(ppid) ? ppid : 0,
      uid: Number.isFinite(owner) ? owner : 0,
      name: comm.slice(0, 24) || `pid ${pid}`,
    };
  } catch {
    // Process exited between readdir and open.
    return null;
  }
}

function listPids(): number[] {
  try {
    return fs
      .readdirSync('/proc')
      .map((n) => Number.parseInt(n, 10))
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

function labelFor(uid: number, myUid: number): string {
  if (uid === myUid) return 'you';
  if (uid === 0) return 'root';
  if (uid === 102) return 'system';
  return `uid ${uid}`;
}

let previous: { readonly byPid: ReadonlyMap<number, ProcEntry> } | null = null;

/**
 * Busiest processes, ranked by CPU with RSS as the tiebreaker. An idle box
 * still returns rows (largest RSS wins), so the panel is never blank.
 */
export function collectProcesses(elapsedSeconds: number, limit = 8): ProcessInfo[] {
  const entries = new Map<number, ProcEntry>();
  for (const pid of listPids()) {
    const entry = readEntry(pid);
    if (!entry || entry.ppid === 2) continue; // skip kernel threads
    entries.set(pid, entry);
  }

  const prior = previous;
  previous = { byPid: entries };

  const myUid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const usable = prior && elapsedSeconds > 0.05;

  const rows = [...entries.entries()].map(([pid, e]) => {
    const before = prior?.byPid.get(pid);
    const ticksPerSec = before && usable ? (e.ticks - before.ticks) / elapsedSeconds : 0;
    const cpuFraction = Math.max(0, ticksPerSec / CLK_TCK);
    return {
      pid,
      name: e.name,
      rssBytes: e.rssBytes,
      cpuFraction: Math.round(cpuFraction * 100) / 100,
      user: labelFor(e.uid, myUid),
      score: cpuFraction * 1000 + e.rssBytes / (1024 * 1024),
    };
  });

  return rows
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ score: _score, ...rest }) => rest);
}

export { CLK_TCK };