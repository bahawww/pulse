/**
 * Shared API contract types. Imported by both the Express server and the React
 * client so a change to the payload is a compile error rather than a runtime
 * surprise.
 */

export interface ServiceStatus {
  /** null when the probe never got a status line (timeout, connection refused). */
  readonly statusCode: number | null;
  /** Round-trip milliseconds, or null when the probe failed outright. */
  readonly latency: number | null;
  readonly online: boolean;
}

export interface ServiceCategoryMeta {
  readonly badge: string;
  readonly category: string;
  /** Single key 1-9 mapped to a keyboard shortcut; '' when the digits ran out. */
  readonly keyNumber: string;
  readonly name: string;
  readonly description: string;
  readonly id: string;
  readonly port: number;
  readonly path: string;
  readonly icon: ServiceIcon;
  readonly themeClass: string;
}

export type ServiceIcon = 'bot' | 'network' | 'activity' | 'monitor' | 'terminal' | 'server' | 'boxes';

/** Where a service came from: the curated list below, or the auto scan. */
export type ServiceSource = 'curated' | 'docker' | 'host';

export interface ServiceMeta extends ServiceCategoryMeta {
  readonly source: ServiceSource;
}

export interface Service extends ServiceMeta {
  readonly status: ServiceStatus;
}

export interface CpuMetrics {
  readonly cores: number;
  readonly load1m: string;
  readonly load15m: string;
  readonly load5m: string;
  readonly model: string;
  /** True CPU-busy percentage per core, derived from /proc/stat deltas. */
  readonly perCore: readonly number[];
  /** Machine-wide busy percentage, same derivation. */
  readonly usage: number;
}

export interface MemoryMetrics {
  readonly free: string;
  readonly percent: number;
  readonly total: string;
  readonly used: string;
  /** Bytes, for the history chart (the human strings round too coarsely). */
  readonly usedBytes: number;
  readonly totalBytes: number;
  readonly availableBytes: number;
  /** Swap: total, used, and percent. */
  readonly swapTotalBytes: number;
  readonly swapUsedBytes: number;
}

export interface DiskMetrics {
  readonly free: string;
  readonly mount: string;
  readonly percent: number;
  readonly total: string;
  readonly used: string;
  readonly totalBytes: number;
  readonly usedBytes: number;
  /**
   * Inode usage. A filesystem can be at 0% bytes and still be unable to create
   * new files when inodes run out — which is silent, because nothing reports a
   * "disk full" error until a write fails. `0` means "not measured", since a real
   * 0% inode count is indistinguishable from a failed statfs.
   */
  readonly inodePercent: number;
  readonly inodeUsed: number;
  readonly inodeTotal: number;
}

/** One mounted filesystem. `mount` is the `target` column from /proc/mounts. */
export interface FilesystemInfo {
  readonly mount: string;
  readonly device: string;
  readonly fstype: string;
  readonly totalBytes: number;
  readonly usedBytes: number;
  readonly availableBytes: number;
  readonly percent: number;
  readonly inodePercent: number;
  readonly inodeUsed: number;
  readonly inodeTotal: number;
}

export interface NetInterface {
  readonly name: string;
  readonly rxBytes: number;
  readonly txBytes: number;
  /** Bytes/sec over the sample window; null before the first delta. */
  readonly rxPerSec: number | null;
  readonly txPerSec: number | null;
  readonly rxErrs: number;
  readonly txErrs: number;
}

export interface DiskIoDevice {
  readonly name: string;
  readonly readBytesPerSec: number;
  readonly writeBytesPerSec: number;
}

export interface ProcessInfo {
  readonly pid: number;
  readonly name: string;
  /** Resident set size in bytes. */
  readonly rssBytes: number;
  /** Fraction of one CPU, e.g. 0.5 = 50% of a core. */
  readonly cpuFraction: number;
  readonly user: string;
}

export interface DockerContainer {
  readonly id: string;
  readonly name: string;
  readonly image: string;
  readonly state: string;
  readonly status: string;
  readonly health: string;
  readonly restartCount: number;
  readonly cpuPercent: number;
  readonly memBytes: number;
}

export interface SystemMetrics {
  readonly cpu: CpuMetrics;
  readonly disk: DiskMetrics;
  readonly hostname: string;
  readonly memory: MemoryMetrics;
  readonly platform: string;
  readonly serverTime: string;
  readonly uptime: number;
  readonly kernel: string;
  readonly net: readonly NetInterface[];
  readonly diskIo: readonly DiskIoDevice[];
  readonly processes: readonly ProcessInfo[];
  readonly docker: readonly DockerContainer[];
  /** Every real mounted filesystem, not just `/`. */
  readonly filesystems: readonly FilesystemInfo[];
  /** Set when a collector failed, so the UI can say what is missing. */
  readonly degraded: readonly string[];
}

export interface StatsPayload {
  /** Visible services: curated plus discovered, minus the hidden ones. */
  readonly services: readonly Service[];
  /** Hidden from every list; offered back on the Applications view. */
  readonly hiddenServices: readonly ServiceMeta[];
  readonly system: SystemMetrics;
}

/** One point on the rolling trend chart. */
export interface HistorySample {
  /** Epoch ms when the sample was taken. */
  readonly t: number;
  readonly cpu: number;
  readonly ram: number;
  readonly disk: number;
  /** Aggregate host network throughput in bytes/sec across real interfaces. */
  readonly netRx: number;
  readonly netTx: number;
  /**
   * Per-service probe latency in ms, keyed by service id. Absent key = the
   * probe did not produce a latency for that sample (it was offline), which is
   * different from a latency of 0.
   */
  readonly latency?: Readonly<Record<string, number>>;
  /** Per-container CPU percent and RSS bytes, keyed by container id. */
  readonly containers?: Readonly<Record<string, ContainerSample>>;
  /** Top processes by CPU at that instant, keyed by pid. */
  readonly processes?: Readonly<Record<string, ProcessSample>>;
}

export interface ContainerSample {
  readonly cpuPercent: number;
  readonly memBytes: number;
  readonly name: string;
}

export interface ProcessSample {
  readonly name: string;
  readonly cpuFraction: number;
  readonly rssBytes: number;
}

/**
 * Downsampled history.
 *
 * One raw 5s series cannot serve a 12-hour view: 12h would need 8,640 samples,
 * which is a multi-megabyte response for a chart 1,100px wide. So the server
 * keeps raw samples for a short window and a longer, averaged copy behind it,
 * and the client picks a bucket size from the requested range.
 */
export interface HistoryPayload {
  readonly samples: readonly HistorySample[];
  /** True window in ms, so the chart can label its axis honestly. */
  readonly spanMs: number;
  /** True only once the ring buffer is full; the UI avoids a fake trend before then. */
  readonly complete: boolean;
  /** Seconds between adjacent samples in `samples` — 5 raw, 60 once downsampled. */
  readonly intervalSec: number;
  /** Longest window the server can serve, i.e. raw + archive. */
  readonly maxSpanMs: number;
  /** Set when the requested range predates the archive (e.g. after a restart). */
  readonly truncated?: boolean;
}

/** Ranges the UI offers. Each maps to a bucket size on the server. */
export const TIME_RANGES = [
  { id: '5m', label: '5M', ms: 5 * 60_000, bucketSec: 5 },
  { id: '15m', label: '15M', ms: 15 * 60_000, bucketSec: 5 },
  { id: '1h', label: '1H', ms: 60 * 60_000, bucketSec: 15 },
  { id: '6h', label: '6H', ms: 6 * 60 * 60_000, bucketSec: 60 },
  { id: '12h', label: '12H', ms: 12 * 60 * 60_000, bucketSec: 120 },
  { id: '24h', label: '24H', ms: 24 * 60 * 60_000, bucketSec: 180 },
] as const;

export type TimeRangeId = (typeof TIME_RANGES)[number]['id'];

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

export type AlertSeverity = 'info' | 'warning' | 'critical';

/** Thresholds a rule watches. A rule with all limits null only fires on state. */
export interface AlertThresholds {
  readonly cpuPercent: number | null;
  readonly ramPercent: number | null;
  readonly diskPercent: number | null;
  readonly inodePercent: number | null;
  readonly netRxPerSec: number | null;
  /** Latency in ms for any named service; empty = every service. */
  readonly latencyMs: readonly number[];
  /** Consecutive samples above the limit before firing. */
  readonly forSamples: number;
}

export interface AlertRule {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly thresholds: AlertThresholds;
  readonly severity: AlertSeverity;
}

export interface AlertEvent {
  readonly id: string;
  readonly ruleId: string;
  readonly severity: AlertSeverity;
  readonly metric: string;
  readonly message: string;
  readonly value: number | null;
  readonly threshold: number | null;
  /** Epoch ms the rule started breaching, not when the alert was delivered. */
  readonly since: number;
  readonly firedAt: number;
  /** null while the condition is still true. */
  readonly resolvedAt: number | null;
  /** How many times this condition has fired, including the current one. */
  readonly occurrences: number;
}

export interface AlertState {
  readonly rules: readonly AlertRule[];
  readonly events: readonly AlertEvent[];
  /** Delivery channel status, so the UI can say alerts are not actually sending. */
  readonly channel: {
    readonly configured: boolean;
    readonly kind: string;
    readonly lastError: string | null;
    readonly lastSentAt: number | null;
    readonly sentCount: number;
  };
  readonly activeCount: number;
}

// ---------------------------------------------------------------------------
// Logs (journalctl)
// ---------------------------------------------------------------------------

export interface LogEntry {
  readonly ts: number;
  readonly unit: string;
  readonly priority: string;
  readonly message: string;
}

export interface LogQuery {
  readonly unit: string;
  readonly lines: number;
  readonly since: string | null;
  readonly priority: string | null;
}

// ---------------------------------------------------------------------------
// External reachability (feature 10)
// ---------------------------------------------------------------------------

export interface ReachabilityTarget {
  readonly id: string;
  readonly label: string;
  /** The URL an outside client would hit, as advertised. */
  readonly url: string;
  readonly method: string;
  readonly expectStatus: readonly number[];
}

export interface ReachabilityResult {
  readonly target: ReachabilityTarget;
  readonly status: 'ok' | 'blocked' | 'unknown';
  readonly httpStatus: number | null;
  readonly latencyMs: number | null;
  readonly checkedAt: number;
  readonly detail: string;
}

export interface ReachabilityReport {
  readonly results: readonly ReachabilityResult[];
  /**
   * True when this box is behind NAT: the port is bound but no external client
   * can reach it. A green dashboard that nothing can connect to is the failure
   * mode this whole panel exists to make visible.
   */
  readonly behindNat: boolean;
  readonly publicIp: string | null;
  readonly tailscaleIp: string | null;
}

// ---------------------------------------------------------------------------
// Users (src/server/users.ts, MySQL)
// ---------------------------------------------------------------------------

/**
 * A role is a ceiling: it decides which permissions a user may be given, and
 * what a new user starts with. What a user can actually do is their own
 * permission list (UserRow.permissions), set per user in the Users view.
 *  - viewer: views only. operator: also service control.
 *  - admin: everything, including terminal, files and managing users below admin.
 *  - superadmin: exactly one, always every permission; can rename and set the
 *    password of anyone. Never assignable.
 */
export type Role = 'viewer' | 'operator' | 'admin' | 'superadmin';

/** Roles that can be given through the API, the Users view or the CLI. */
export type AssignableRole = Exclude<Role, 'superadmin'>;

export const ROLE_RANK: Readonly<Record<Role, number>> = { viewer: 0, operator: 1, admin: 2, superadmin: 3 };

/**
 * Shortest password a person may pick for themselves, or an admin for a new
 * account. The superadmin setting someone else's password is free of it
 * (owner's choice). Enforced in src/server/users.ts, shown in the forms.
 */
export const PASSWORD_MIN = 8;

export function roleAtLeast(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

/** Every permission, in display order, with the lowest role allowed to hold it. */
export const PERMISSIONS = [
  { key: 'view:overview', group: 'Views', label: 'Overview', min: 'viewer' },
  { key: 'view:applications', group: 'Views', label: 'Applications', min: 'viewer' },
  { key: 'view:trends', group: 'Views', label: 'Trends', min: 'viewer' },
  { key: 'view:hardware', group: 'Views', label: 'Hardware', min: 'viewer' },
  { key: 'view:workload', group: 'Views', label: 'Workload', min: 'viewer' },
  { key: 'view:capacity', group: 'Views', label: 'Capacity', min: 'viewer' },
  { key: 'view:logs', group: 'Views', label: 'Logs and action history', min: 'viewer' },
  { key: 'services:control', group: 'Actions', label: 'Start, stop, restart services; rescan or hide cards', min: 'operator' },
  { key: 'files:read', group: 'Actions', label: 'Files: browse, preview, download', min: 'admin' },
  { key: 'files:write', group: 'Actions', label: 'Files: upload, rename, delete', min: 'admin' },
  { key: 'terminal', group: 'Actions', label: 'Terminal and tmux (full shell with sudo)', min: 'admin' },
  { key: 'users:manage', group: 'Actions', label: 'Manage viewers and operators', min: 'admin' },
] as const satisfies readonly { key: string; group: string; label: string; min: Role }[];

export type Permission = (typeof PERMISSIONS)[number]['key'];

const PERMISSION_KEYS: ReadonlySet<string> = new Set(PERMISSIONS.map((p) => p.key));

export function isPermission(v: unknown): v is Permission {
  return typeof v === 'string' && PERMISSION_KEYS.has(v);
}

/** What `role` may hold. Also what a new user with that role starts with. */
export function roleCeiling(role: Role): Permission[] {
  return PERMISSIONS.filter((p) => roleAtLeast(role, p.min)).map((p) => p.key);
}

/** `wanted` cut down to what `role` may hold; null (never set) means the role's default. */
export function effectivePermissions(role: Role, wanted: readonly string[] | null): Permission[] {
  const ceiling = roleCeiling(role);
  if (role === 'superadmin' || wanted === null) return ceiling;
  const keep = new Set(wanted);
  return ceiling.filter((p) => keep.has(p));
}

export function can(user: { readonly permissions: readonly string[] } | null | undefined, perm: Permission): boolean {
  return !!user && user.permissions.includes(perm);
}

export interface UserRow {
  readonly id: number;
  readonly username: string;
  readonly role: Role;
  readonly disabled: boolean;
  /** Effective permissions: the user's own list within their role's ceiling. */
  readonly permissions: readonly Permission[];
  /** False while the user still has their role's defaults. */
  readonly customized: boolean;
  /** Epoch ms. */
  readonly createdAt: number;
  readonly lastLoginAt: number | null;
}

// ---------------------------------------------------------------------------
// Write actions (feature 9)
// ---------------------------------------------------------------------------

export type ActionTarget = 'systemd' | 'docker';

export interface ActionRequest {
  readonly target: ActionTarget;
  /** systemd unit name, or container id / name prefix. */
  readonly name: string;
  /** Only these verbs are accepted; anything else is rejected before exec. */
  readonly action: 'restart' | 'stop' | 'start';
}

export interface ActionResult {
  readonly ok: boolean;
  readonly target: ActionTarget;
  readonly name: string;
  readonly action: string;
  readonly message: string;
  readonly stdout: string;
  readonly durationMs: number;
}

/** One row of the write-action audit log. Only executed actions are recorded. */
export interface ActionLogEntry {
  readonly id: number;
  /** Epoch ms when the action finished. */
  readonly ts: number;
  /** 'files': an upload, rename, new folder or delete from the file explorer. 'users': an account change. */
  readonly target: ActionTarget | 'files' | 'users' | 'tmux';
  readonly name: string;
  readonly action: string;
  readonly ok: boolean;
  readonly message: string;
  readonly durationMs: number;
}

// ---------------------------------------------------------------------------
// LLM spend (feature 11)
// ---------------------------------------------------------------------------

export interface SpendPoint {
  /** Bucket start, epoch ms. */
  readonly t: number;
  requests: number;
  costUsd: number;
  tokens: number;
}

export interface SpendByModel {
  readonly model: string;
  readonly provider: string;
  requests: number;
  costUsd: number;
  tokens: number;
}

export interface SpendReport {
  readonly available: boolean;
  /** Why it is unavailable, when available is false. */
  readonly reason: string | null;
  readonly totalRequests: number;
  readonly totalCostUsd: number;
  readonly totalTokens: number;
  readonly todayCostUsd: number;
  readonly todayRequests: number;
  readonly avgCostPerRequest: number;
  /** Daily buckets, oldest first. */
  readonly daily: readonly SpendPoint[];
  /** Hourly buckets for the last 24h, oldest first. */
  readonly hourly: readonly SpendPoint[];
  readonly byModel: readonly SpendByModel[];
  readonly source: string;
  readonly fetchedAt: number;
}

// ---------------------------------------------------------------------------
// File explorer
// ---------------------------------------------------------------------------

export type FileKind = 'file' | 'dir' | 'link' | 'other';

export interface FileEntry {
  readonly name: string;
  readonly kind: FileKind;
  /** For a symlink, what it points at ('dir' means it can be opened as a folder). */
  readonly target: FileKind | null;
  readonly size: number;
  /** Epoch ms. */
  readonly mtime: number;
  /** Octal permission bits, e.g. "755". */
  readonly mode: string;
  readonly owner: string;
}

export interface FileListing {
  /** Absolute path that was listed, as the shell resolved it. */
  readonly path: string;
  /** The SSH user's home, for the Home button. */
  readonly home: string;
  readonly entries: readonly FileEntry[];
  /** More entries existed than the listing cap. */
  readonly truncated: boolean;
}

export interface FilePreview {
  readonly path: string;
  readonly size: number;
  /** Null for a binary file. */
  readonly text: string | null;
  readonly truncated: boolean;
}

/** Shape returned on a 5xx from /api/stats, or when a probe layer throws. */
export interface ApiErrorPayload {
  readonly error: string;
}

/**
 * Curated services: hand-written names, descriptions and keys. Always listed,
 * online or not. The auto scan (src/server/discover.ts) adds everything else;
 * a scanned port that matches one of these is shown as this entry instead.
 */
export const SERVICES: readonly ServiceCategoryMeta[] = [
  {
    id: 'hermes',
    name: 'Hermes Agent',
    keyNumber: '1',
    description:
      'Autonomous AI agent gateway with tools, terminal execution, multi-step workflows, and chat interface.',
    port: 9119,
    path: '/',
    category: 'AI Agents',
    badge: 'AI Core',
    icon: 'bot',
    themeClass: 'icon-theme-hermes',
  },
  {
    id: '9router',
    name: '9router Gateway',
    keyNumber: '2',
    description:
      'Unified high-throughput LLM model router, multi-provider load balancing, and traffic control dashboard.',
    port: 20128,
    path: '/dashboard',
    category: 'AI Infrastructure',
    badge: 'Gateway',
    icon: 'network',
    themeClass: 'icon-theme-9router',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    keyNumber: '3',
    description:
      'Open-source AI coding agent with a web UI. Reads and edits files and runs commands on this server. Password protected.',
    port: 4096,
    path: '/',
    category: 'AI Agents',
    badge: 'Coding Agent',
    icon: 'terminal',
    themeClass: 'icon-theme-opencode',
  },
  {
    id: 'novnc',
    name: 'noVNC Desktop',
    keyNumber: '4',
    description:
      'High-performance graphical XFCE / TigerVNC desktop workspace accessible directly in your web browser.',
    port: 6080,
    path: '/vnc.html?autoconnect=true&resize=remote',
    category: 'Remote Access',
    badge: 'GUI Session',
    icon: 'monitor',
    themeClass: 'icon-theme-novnc',
  },
  {
    id: 'coolify',
    name: 'Coolify',
    keyNumber: '5',
    description:
      'Self-hosted PaaS that deploys apps, databases and services from Git or Docker images. Runs as containers; admin login required.',
    port: 8000,
    path: '/',
    category: 'Deployment',
    badge: 'PaaS',
    icon: 'server',
    themeClass: 'icon-theme-coolify',
  },
] as const;

/**
 * Curated services that run as systemd units, so service control can start,
 * stop and restart them (src/server/actions.ts maps each id to its unit).
 * Coolify and the scanned services run in Docker and are controlled as
 * containers; offered as units they only failed with "unit not found".
 */
export const UNIT_SERVICES: ReadonlySet<string> = new Set(['hermes', '9router', 'opencode', 'novnc']);

/** Services whose Cloudflare path differs from the local port path. */
export const SUBDOMAIN_PATHS: Readonly<Record<string, string>> = {
  novnc: '',
};

/** Containers left out of every list in the UI. Matched by name prefix. */
const HIDDEN_CONTAINER_PREFIXES = ['beszel'] as const;

export function isHiddenContainer(name: string): boolean {
  return HIDDEN_CONTAINER_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** Categories the auto scan files services under. */
export const DOCKER_CATEGORY = 'Containers';
export const HOST_CATEGORY = 'Discovered';

/** Short tab labels; a category without one shows its own name. Tabs follow this order. */
const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  'AI Agents': 'AI Agents',
  'AI Infrastructure': 'AI Gateway',
  'Remote Access': 'Remote GUI',
  Deployment: 'Deploy',
  [DOCKER_CATEGORY]: 'Containers',
  [HOST_CATEGORY]: 'Discovered',
};

/** "all" first, then every category present, known ones in CATEGORY_LABELS order. */
export function categoryFilters(services: readonly { readonly category: string }[]): { id: string; label: string }[] {
  const present = new Set(services.map((s) => s.category));
  const known = Object.keys(CATEGORY_LABELS).filter((c) => present.has(c));
  const rest = [...present].filter((c) => !(c in CATEGORY_LABELS)).sort();
  return [
    { id: 'all', label: 'All Services' },
    ...[...known, ...rest].map((id) => ({ id, label: CATEGORY_LABELS[id] ?? id })),
  ];
}