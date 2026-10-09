import fs from 'node:fs';
import type { DiskMetrics, NetInterface, DiskIoDevice } from '../../shared/contract.js';
import { humanBytes } from './memory.js';

/**
 * Disk space, network counters and block-device I/O — all from procfs, no
 * subprocesses. A poll costs three small synchronous reads.
 */

export function collectDisk(mountPoint = '/'): DiskMetrics {
  try {
    const stats = fs.statfsSync(mountPoint);
    // `bavail` is what an unprivileged process may actually use; `bfree` also
    // counts blocks reserved for root, which would overstate free space.
    const blockSize = Number(stats.bsize);
    const totalBytes = Number(stats.blocks) * blockSize;
    const availableBytes = Number(stats.bavail) * blockSize;
    const usedBytes = Math.max(0, totalBytes - availableBytes);

    // Inode accounting. A volume at 0% bytes can still be unable to create new
    // files when inodes are exhausted, and nothing surfaces that until a write
    // fails — so it is measured here rather than left to `df -i` at the CLI.
    const inodeTotal = Number(stats.files);
    const inodeFree = Number(stats.ffree);
    const inodeUsed = Math.max(0, inodeTotal - inodeFree);
    const inodePercent = inodeTotal > 0 ? Math.round((inodeUsed / inodeTotal) * 100) : 0;

    if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
      return {
        total: 'unknown',
        used: 'unknown',
        free: 'unknown',
        percent: 0,
        mount: mountPoint,
        totalBytes: 0,
        usedBytes: 0,
        inodePercent: 0,
        inodeUsed: 0,
        inodeTotal: 0,
      };
    }

    return {
      total: humanBytes(totalBytes),
      used: humanBytes(usedBytes),
      free: humanBytes(availableBytes),
      percent: Math.round((usedBytes / totalBytes) * 100),
      mount: mountPoint,
      totalBytes,
      usedBytes,
      inodePercent,
      inodeUsed,
      inodeTotal,
    };
  } catch {
    return {
      total: 'unknown',
      used: 'unknown',
      free: 'unknown',
      percent: 0,
      mount: mountPoint,
      totalBytes: 0,
      usedBytes: 0,
      inodePercent: 0,
      inodeUsed: 0,
      inodeTotal: 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

interface NetCounters {
  readonly name: string;
  readonly rxBytes: number;
  readonly txBytes: number;
  readonly rxErrs: number;
  readonly txErrs: number;
}

/** Interfaces that are either loopback or carry no address are noise, not signal. */
function isInteresting(name: string): boolean {
  if (name === 'lo') return false;
  // veth/bridge/docker virtual pairs double-count host traffic; keep them out.
  if (/^(veth|docker|br-|virbr|tun|tap)/.test(name)) return false;
  return true;
}

function readNetCounters(): NetCounters[] {
  let raw: string;
  try {
    raw = fs.readFileSync('/proc/net/dev', 'utf8');
  } catch {
    return [];
  }

  const out: NetCounters[] = [];
  const lines = raw.split('\n').slice(2); // two header rows
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim();
    if (!isInteresting(name)) continue;

    const f = line.slice(colon + 1).trim().split(/\s+/).map((n) => Number.parseInt(n, 10) || 0);
    // rx: bytes packets errs drop fifo frame compressed multicast
    // tx: bytes packets errs drop fifo colls carrier compressed
    if (f.length < 9) continue;
    out.push({
      name,
      rxBytes: f[0] ?? 0,
      rxErrs: f[2] ?? 0,
      txBytes: f[8] ?? 0,
      txErrs: f[10] ?? 0,
    });
  }
  return out;
}

/**
 * Per-second rates need two samples. The previous read is cached at module
 * scope, so the first poll after boot reports null rather than a fake 0 B/s.
 */
let previousNet: { readonly at: number; readonly byName: ReadonlyMap<string, NetCounters> } | null = null;

export function collectNet(): NetInterface[] {
  const now = readNetCounters();
  const at = Date.now();
  const prior = previousNet;
  previousNet = { at, byName: new Map(now.map((n) => [n.name, n])) };

  return now.map((n) => {
    const before = prior?.byName.get(n.name);
    const seconds = prior ? (at - prior.at) / 1000 : 0;
    const usable = before && seconds > 0.05;
    return {
      name: n.name,
      rxBytes: n.rxBytes,
      txBytes: n.txBytes,
      rxPerSec: usable ? Math.max(0, Math.round((n.rxBytes - before.rxBytes) / seconds)) : null,
      txPerSec: usable ? Math.max(0, Math.round((n.txBytes - before.txBytes) / seconds)) : null,
      rxErrs: n.rxErrs,
      txErrs: n.txErrs,
    };
  });
}

// ---------------------------------------------------------------------------
// Block device I/O
// ---------------------------------------------------------------------------

interface DiskIoCounters {
  readonly name: string;
  readonly readBytes: number;
  readonly writeBytes: number;
}

/**
 * Whole block devices only.
 *
 * /proc/diskstats lists partitions (sda1) alongside their parent disk (sda),
 * and a partition's I/O is ALSO counted against the parent — summing them
 * reports every byte two or three times. Names are not reliably distinguishable
 * by regex (sda1 has no 'p'; only nvme and mmc use the pN convention), so
 * /sys/block is used as the authority: it contains whole devices only.
 */
const SECTOR_BYTES = 512;

function wholeDevices(): ReadonlySet<string> {
  try {
    return new Set(
      fs
        .readdirSync('/sys/block')
        // loop/ram/dm devices are virtual; their "throughput" is not storage load.
        .filter((n) => !/^(loop|ram|zram|dm-|sr|fd)/.test(n)),
    );
  } catch {
    return new Set();
  }
}

function readDiskIo(): DiskIoCounters[] {
  let raw: string;
  try {
    raw = fs.readFileSync('/proc/diskstats', 'utf8');
  } catch {
    return [];
  }

  const devices = wholeDevices();
  const out: DiskIoCounters[] = [];
  for (const line of raw.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    const name = f[2];
    if (!name || !devices.has(name)) continue;
    out.push({
      name,
      readBytes: (Number(f[3]) || 0) * SECTOR_BYTES,
      writeBytes: (Number(f[5]) || 0) * SECTOR_BYTES,
    });
  }
  return out;
}

let previousDiskIo: { readonly at: number; readonly byName: ReadonlyMap<string, DiskIoCounters> } | null = null;

export function collectDiskIo(): DiskIoDevice[] {
  const now = readDiskIo();
  const at = Date.now();
  const prior = previousDiskIo;
  previousDiskIo = { at, byName: new Map(now.map((d) => [d.name, d])) };

  return now.map((d) => {
    const before = prior?.byName.get(d.name);
    const seconds = prior ? (at - prior.at) / 1000 : 0;
    const usable = before && seconds > 0.05;
    return {
      name: d.name,
      readBytesPerSec: usable ? Math.max(0, Math.round((d.readBytes - before.readBytes) / seconds)) : 0,
      writeBytesPerSec: usable ? Math.max(0, Math.round((d.writeBytes - before.writeBytes) / seconds)) : 0,
    };
  });
}