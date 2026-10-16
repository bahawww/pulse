import type {
  CpuMetrics,
  DiskMetrics,
  HistorySample,
  MemoryMetrics,
  Permission,
  StatsPayload,
} from '../shared/contract.js';

/**
 * The server-side half of the per-view permissions (VIEW_NEEDS in
 * src/lib/views.ts). Hiding a view in the browser used to hide nothing from the
 * API: a login allowed only the overview could still read every process,
 * container, filesystem and latency from /api/stats, /api/stream and
 * /api/history. Now each part of the telemetry goes only to logins that hold a
 * permission for a view that shows it. Parts left out keep their shape (empty
 * lists, zeros), so the client needs no special cases; it never draws them.
 *
 * Alerts stay with every login: the bell is in the top bar, not in a view.
 */

/** Live parts (StatsPayload) and the permissions that may read each. */
const LIVE = {
  services: ['view:overview', 'view:applications', 'view:capacity', 'services:control'],
  hiddenServices: ['view:applications', 'services:control'],
  /** Hostname, platform, kernel and uptime: the overview's hero. */
  host: ['view:overview'],
  cpu: ['view:overview', 'view:hardware'],
  memory: ['view:overview', 'view:hardware'],
  disk: ['view:overview', 'view:capacity'],
  net: ['view:overview', 'view:hardware'],
  diskIo: ['view:hardware'],
  processes: ['view:workload'],
  /** Workload charts, and the container list of service control. */
  docker: ['view:workload', 'services:control'],
  filesystems: ['view:capacity'],
} as const satisfies Record<string, readonly Permission[]>;

/** History sample series and the permissions that may read each. */
const SERIES = {
  cpu: ['view:overview', 'view:trends', 'view:hardware'],
  ram: ['view:overview', 'view:trends'],
  disk: ['view:overview', 'view:trends'],
  net: ['view:overview', 'view:hardware'],
  latency: ['view:capacity'],
  containers: ['view:workload'],
  processes: ['view:workload'],
} as const satisfies Record<string, readonly Permission[]>;

type LivePart = keyof typeof LIVE;
type Series = keyof typeof SERIES;

const NO_CPU: CpuMetrics = { cores: 0, load1m: '0.00', load5m: '0.00', load15m: '0.00', model: '', perCore: [], usage: 0 };
const NO_MEMORY: MemoryMetrics = {
  free: '',
  percent: 0,
  total: '',
  used: '',
  usedBytes: 0,
  totalBytes: 0,
  availableBytes: 0,
  swapTotalBytes: 0,
  swapUsedBytes: 0,
};
const NO_DISK: DiskMetrics = {
  free: '',
  mount: '/',
  percent: 0,
  total: '',
  used: '',
  totalBytes: 0,
  usedBytes: 0,
  inodePercent: 0,
  inodeUsed: 0,
  inodeTotal: 0,
};

function reads<K extends string>(table: Readonly<Record<K, readonly Permission[]>>, perms: readonly Permission[]): (part: K) => boolean {
  return (part) => table[part].some((p) => perms.includes(p));
}

const LIVE_PARTS = Object.keys(LIVE) as LivePart[];
const SERIES_PARTS = Object.keys(SERIES) as Series[];

/** The stats payload as `perms` may see it. The same object when nothing is withheld. */
export function scopeStats(payload: StatsPayload, perms: readonly Permission[]): StatsPayload {
  const may = reads(LIVE, perms);
  if (LIVE_PARTS.every(may)) return payload;
  const s = payload.system;
  return {
    services: may('services') ? payload.services : [],
    hiddenServices: may('hiddenServices') ? payload.hiddenServices : [],
    system: {
      hostname: may('host') ? s.hostname : '',
      platform: may('host') ? s.platform : '',
      kernel: may('host') ? s.kernel : '',
      uptime: may('host') ? s.uptime : 0,
      serverTime: s.serverTime,
      degraded: s.degraded,
      cpu: may('cpu') ? s.cpu : NO_CPU,
      memory: may('memory') ? s.memory : NO_MEMORY,
      disk: may('disk') ? s.disk : NO_DISK,
      net: may('net') ? s.net : [],
      diskIo: may('diskIo') ? s.diskIo : [],
      processes: may('processes') ? s.processes : [],
      docker: may('docker') ? s.docker : [],
      filesystems: may('filesystems') ? s.filesystems : [],
    },
  };
}

/** Which history series `perms` may read, as a short cache key ("cpu,ram,disk,net,..."). */
export function seriesKey(perms: readonly Permission[]): string {
  return SERIES_PARTS.filter(reads(SERIES, perms)).join(',');
}

/** History samples cut to what `perms` may read. The same array when nothing is withheld. */
export function scopeSamples(samples: readonly HistorySample[], perms: readonly Permission[]): readonly HistorySample[] {
  const may = reads(SERIES, perms);
  if (SERIES_PARTS.every(may)) return samples;
  const cpu = may('cpu');
  const ram = may('ram');
  const disk = may('disk');
  const net = may('net');
  const latency = may('latency');
  const containers = may('containers');
  const processes = may('processes');
  return samples.map((s) => ({
    t: s.t,
    cpu: cpu ? s.cpu : 0,
    ram: ram ? s.ram : 0,
    disk: disk ? s.disk : 0,
    netRx: net ? s.netRx : 0,
    netTx: net ? s.netTx : 0,
    ...(latency && s.latency ? { latency: s.latency } : {}),
    ...(containers && s.containers ? { containers: s.containers } : {}),
    ...(processes && s.processes ? { processes: s.processes } : {}),
  }));
}
