import fs from 'node:fs';
import type { FilesystemInfo } from '../../shared/contract.js';
import { humanBytes } from './memory.js';

/**
 * Every mounted filesystem, with inode accounting.
 *
 * The previous collector reported only `/`. Two problems with that: a root
 * volume can be fine while `/boot` or a mounted data disk fills, and a
 * filesystem can be at 0% bytes and still refuse new files once inodes run out
 * — the classic silent failure where everything looks healthy and writes start
 * failing with ENOSPC.
 */

/**
 * Pseudo and network filesystems that are not real storage. Showing tmpfs RAM
 * as "disk" produces panels full of noise that looks like signal.
 */
const SKIP_FSTYPE = new Set([
  'proc',
  'sysfs',
  'devtmpfs',
  'devpts',
  'tmpfs',
  'cgroup',
  'cgroup2',
  'securityfs',
  'pstore',
  'bpf',
  'tracefs',
  'debugfs',
  'configfs',
  'fusectl',
  'hugetlbfs',
  'mqueue',
  'autofs',
  'binfmt_misc',
  'efivarfs',
  'rpc_pipefs',
  'nsfs',
  'squashfs',
  'ramfs',
  'overlay',
  'none',
]);

interface MountRow {
  readonly device: string;
  readonly mount: string;
  readonly fstype: string;
}

/**
 * Reads /proc/mounts. Overlay is skipped on purpose: on this host the root is
 * an overlay mount, and reporting the lower layers separately double-counts the
 * same bytes under different mount points.
 */
function readMounts(): MountRow[] {
  let raw: string;
  try {
    raw = fs.readFileSync('/proc/mounts', 'utf8');
  } catch {
    return [];
  }

  const out: MountRow[] = [];
  const seen = new Set<string>();
  for (const line of raw.split('\n')) {
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    const device = parts[0];
    const mount = parts[1];
    const fstype = parts[2];
    if (!device || !mount || !fstype) continue;
    if (SKIP_FSTYPE.has(fstype)) continue;
    // Octal escapes appear in mount points containing spaces (\040).
    const decoded = mount.replace(/\\0(40|11|12)/g, (_m, code) =>
      String.fromCharCode(parseInt(code, 8)),
    );
    if (seen.has(decoded)) continue;
    seen.add(decoded);
    out.push({ device, mount: decoded, fstype });
  }
  return out;
}

function measure(mount: string): FilesystemInfo | null {
  try {
    const stats = fs.statfsSync(mount);
    const blockSize = Number(stats.bsize);
    const totalBytes = Number(stats.blocks) * blockSize;
    // bavail, not bfree: bfree also counts blocks reserved for root, which
    // would overstate the space an ordinary process can use.
    const availableBytes = Number(stats.bavail) * blockSize;
    const usedBytes = Math.max(0, totalBytes - availableBytes);

    const inodeTotal = Number(stats.files);
    const inodeFree = Number(stats.ffree);
    const inodeUsed = Math.max(0, inodeTotal - inodeFree);
    const inodePercent =
      inodeTotal > 0 ? Math.round((inodeUsed / inodeTotal) * 100) : 0;

    if (!Number.isFinite(totalBytes) || totalBytes <= 0) return null;

    return {
      mount,
      device: '',
      fstype: '',
      totalBytes,
      usedBytes,
      availableBytes,
      percent: Math.round((usedBytes / totalBytes) * 100),
      inodePercent,
      inodeUsed,
      inodeTotal,
    };
  } catch {
    return null;
  }
}

/**
 * All real filesystems, largest first so the important one leads.
 *
 * A tiny tmpfs-backed path would otherwise outrank a 200GB data disk purely by
 * being measured at a moment when it happened to be fuller.
 */
export function collectFilesystems(): FilesystemInfo[] {
  const out: FilesystemInfo[] = [];
  for (const m of readMounts()) {
    const measured = measure(m.mount);
    if (!measured) continue;
    out.push({ ...measured, device: m.device, fstype: m.fstype });
  }
  out.sort((a, b) => b.totalBytes - a.totalBytes);

  // Only the largest few are worth rendering; the rest are 40MB boot partitions
  // that add scroll without adding information.
  return out.slice(0, 8);
}

/** Inode pressure on the primary filesystem, for alerting. */
export function worstInodePercent(): { percent: number; mount: string } {
  const all = collectFilesystems();
  let worst = { percent: 0, mount: '/' };
  for (const fs of all) {
    if (fs.inodePercent > worst.percent) worst = { percent: fs.inodePercent, mount: fs.mount };
  }
  return worst;
}

export { humanBytes };