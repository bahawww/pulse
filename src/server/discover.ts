import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import {
  DOCKER_CATEGORY,
  HOST_CATEGORY,
  SERVICES,
  type ServiceMeta,
  type ServiceSource,
} from '../shared/contract.js';
import { dockerGet, dockerSocketAvailable } from './collect/docker.js';

/**
 * Auto scan: finds the web apps on this box so nobody has to list them by hand.
 *
 * Two sources:
 *  - Docker containers that publish a TCP port on all interfaces. Named after
 *    the container.
 *  - Host processes listening on all interfaces (/proc/net/tcp*). Named after
 *    the page <title>: the dashboard runs as an unprivileged user and cannot
 *    see which root process owns a socket.
 *
 * A candidate counts only if it answers HTTP on `/` with anything but 404, so
 * ssh, DNS, VNC, TLS-only ports and bare reverse proxies drop out by themselves.
 * Ports bound to loopback only are skipped: no link could reach them.
 *
 * What was found is kept in data/services.json with the hidden ids, so a
 * service that stops shows as offline instead of vanishing: a Docker one for as
 * long as its container exists, a host one for RETAIN_MS.
 */

const DATA_DIR = process.env.DASHBOARD_DATA_DIR ?? path.join(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'services.json');

const SCAN_EVERY_MS = 60_000;
const PROBE_TIMEOUT_MS = 1500;
/** Enough to reach <title> on any sane page. */
const MAX_PROBE_BYTES = 64 * 1024;
const RETAIN_MS = 24 * 60 * 60_000;
const MAX_HIDDEN = 500;

/** Never probed: not web, and some log every stray connection. */
const SKIP_PORTS = new Set([22, 25, 53, 111, 631]);

interface SeenEntry {
  readonly id: string;
  readonly source: Exclude<ServiceSource, 'curated'>;
  readonly name: string;
  readonly description: string;
  readonly badge: string;
  readonly port: number;
  /** Container name, for Docker entries. */
  readonly container?: string;
  readonly lastSeen: number;
}

interface State {
  hidden: string[];
  seen: SeenEntry[];
}

let state: State = load();
let ownPort = 0;
let inFlight: Promise<void> | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();

function load(): State {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8')) as Partial<State>;
    return {
      hidden: Array.isArray(raw.hidden) ? raw.hidden.filter((id): id is string => typeof id === 'string') : [],
      seen: Array.isArray(raw.seen) ? raw.seen.filter(isSeenEntry) : [],
    };
  } catch {
    return { hidden: [], seen: [] };
  }
}

function isSeenEntry(e: unknown): e is SeenEntry {
  const o = e as Partial<SeenEntry> | null;
  return (
    !!o &&
    typeof o.id === 'string' &&
    (o.source === 'docker' || o.source === 'host') &&
    typeof o.name === 'string' &&
    typeof o.port === 'number' &&
    typeof o.lastSeen === 'number'
  );
}

function save(): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, FILE);
  } catch (err) {
    console.warn(`[discover] could not save ${FILE}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function changed(): void {
  for (const fn of listeners) fn();
}

/** Called after every scan or hide, so the stats cache can drop its copy. */
export function onServicesChange(fn: () => void): void {
  listeners.add(fn);
}

// ---------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------

/** Ports listening on 0.0.0.0 or ::, from the kernel's socket tables. */
async function wildcardListeners(): Promise<Set<number>> {
  const ports = new Set<number>();
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text: string;
    try {
      text = await fs.promises.readFile(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      // cols[1] is "ADDR:PORT" in hex, cols[3] the state; 0A is LISTEN.
      if (cols[3] !== '0A') continue;
      const [addr, portHex] = (cols[1] ?? '').split(':');
      if (!addr || !portHex || !/^0+$/.test(addr)) continue;
      ports.add(parseInt(portHex, 16));
    }
  }
  return ports;
}

interface WebAnswer {
  readonly status: number;
  readonly title: string | null;
}

function decodeTitle(raw: string): string | null {
  const text = raw
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, 60) : null;
}

/** GET / on a local port. null when it does not speak HTTP (or not in time). */
function probeWeb(port: number): Promise<WebAnswer | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (answer: WebAnswer | null) => {
      if (done) return;
      done = true;
      resolve(answer);
    };
    const req = http.get(
      {
        host: '127.0.0.1',
        port,
        path: '/',
        timeout: PROBE_TIMEOUT_MS,
        headers: { accept: 'text/html', 'user-agent': 'pulse-discover' },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (!/text\/html/i.test(String(res.headers['content-type'] ?? ''))) {
          res.destroy();
          finish({ status, title: null });
          return;
        }
        let body = '';
        const settle = () => {
          const match = /<title[^>]*>([^<]*)<\/title>/i.exec(body);
          finish({ status, title: match?.[1] ? decodeTitle(match[1]) : null });
        };
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
          if (body.length > MAX_PROBE_BYTES || /<\/title>/i.test(body)) {
            settle();
            res.destroy();
          }
        });
        res.on('end', settle);
        res.on('close', settle);
        res.on('error', settle);
      },
    );
    req.on('timeout', () => {
      req.destroy();
      finish(null);
    });
    req.on('error', () => finish(null));
  });
}

/** An app worth a card: any HTTP answer except "nothing here". */
function isApp(answer: WebAnswer | null): answer is WebAnswer {
  return answer !== null && answer.status >= 100 && answer.status !== 404;
}

/** Lower is better: a page, then a login wall, then anything else. */
function rank(status: number): number {
  if (status < 400) return 0;
  if (status === 401 || status === 403) return 1;
  return 2;
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

interface DockerPort {
  IP?: string;
  PrivatePort: number;
  PublicPort?: number;
  Type: string;
}

interface DockerListItem {
  Names?: string[];
  Image?: string;
  Ports?: DockerPort[];
}

const isWildcard = (ip: string | undefined) => !ip || ip === '0.0.0.0' || ip === '::';

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** "campus-netmap_beta" -> "Campus Netmap Beta". */
function prettify(name: string): string {
  return name
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

async function scan(): Promise<void> {
  const now = Date.now();
  const curatedPorts = new Set(SERVICES.map((s) => s.port));
  const found = new Map<string, SeenEntry>();
  const containers = new Set<string>();
  const dockerPorts = new Set<number>();

  const list = dockerSocketAvailable() ? await dockerGet<DockerListItem[]>('/containers/json?all=1') : null;
  const dockerOk = list !== null;

  await Promise.all(
    (list ?? []).map(async (c) => {
      const name = (c.Names?.[0] ?? '').replace(/^\//, '');
      if (!name) return;
      containers.add(name);
      const ports = [
        ...new Set(
          (c.Ports ?? [])
            .filter((p) => p.Type === 'tcp' && p.PublicPort && isWildcard(p.IP))
            .map((p) => p.PublicPort as number),
        ),
      ];
      for (const p of ports) dockerPorts.add(p);
      // A container behind a curated service (Coolify) is already on the page.
      if (ports.length === 0 || ports.some((p) => curatedPorts.has(p))) return;

      const answers = await Promise.all(ports.map(async (port) => ({ port, answer: await probeWeb(port) })));
      const best = answers
        .filter((a): a is { port: number; answer: WebAnswer } => isApp(a.answer))
        .sort((a, b) => rank(a.answer.status) - rank(b.answer.status) || a.port - b.port)[0];
      if (!best) return;

      const image = (c.Image ?? '').split('@')[0]?.split(':')[0]?.split('/').pop() || 'container';
      const id = `docker-${slug(name)}`;
      found.set(id, {
        id,
        source: 'docker',
        name: prettify(name),
        description: best.answer.title
          ? `${best.answer.title}. Docker container ${name} (${image}).`
          : `Docker container ${name} (${image}).`,
        badge: image,
        port: best.port,
        container: name,
        lastSeen: now,
      });
    }),
  );

  const hostPorts = [...(await wildcardListeners())].filter(
    (p) => p !== ownPort && !SKIP_PORTS.has(p) && !curatedPorts.has(p) && !dockerPorts.has(p),
  );
  await Promise.all(
    hostPorts.map(async (port) => {
      const answer = await probeWeb(port);
      if (!isApp(answer)) return;
      const id = `port-${port}`;
      found.set(id, {
        id,
        source: 'host',
        name: answer.title ?? `Port ${port}`,
        description: `Web app found listening on port ${port}.`,
        badge: `:${port}`,
        port,
        lastSeen: now,
      });
    }),
  );

  // Keep what went quiet, as offline: a Docker entry while its container
  // exists, a host one for RETAIN_MS. A port taken by something new frees it.
  const takenPorts = new Set([...found.values()].map((e) => e.port));
  const kept = state.seen.filter((old) => {
    if (found.has(old.id) || takenPorts.has(old.port)) return false;
    if (old.source === 'docker' && dockerOk) return old.container !== undefined && containers.has(old.container);
    return now - old.lastSeen < RETAIN_MS;
  });

  state = { hidden: state.hidden, seen: [...found.values(), ...kept] };
  save();
  changed();
}

/** Runs a scan now, or joins the one already running. */
export function rescan(): Promise<void> {
  inFlight ??= scan()
    .catch((err: unknown) => {
      console.warn(`[discover] scan failed: ${err instanceof Error ? err.message : String(err)}`);
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** First scan now, then every SCAN_EVERY_MS. `port` is the dashboard's own. */
export function startDiscovery(port: number): void {
  ownPort = port;
  void rescan();
  timer ??= setInterval(() => void rescan(), SCAN_EVERY_MS);
  timer.unref();
}

// ---------------------------------------------------------------------------
// The list the dashboard shows
// ---------------------------------------------------------------------------

function toMeta(e: SeenEntry): ServiceMeta {
  return {
    id: e.id,
    source: e.source,
    name: e.name,
    description: e.description,
    badge: e.badge,
    port: e.port,
    path: '/',
    category: e.source === 'docker' ? DOCKER_CATEGORY : HOST_CATEGORY,
    icon: e.source === 'docker' ? 'boxes' : 'activity',
    themeClass: '',
    keyNumber: '',
  };
}

/**
 * Curated services first, then containers by name, then host ports. Visible
 * discovered services take the digits 1-9 the curated ones left free.
 */
export function serviceList(): { visible: ServiceMeta[]; hidden: ServiceMeta[] } {
  const hidden = new Set(state.hidden);
  const discovered = [...state.seen]
    .sort((a, b) => (a.source === b.source ? (a.source === 'docker' ? a.name.localeCompare(b.name) : a.port - b.port) : a.source === 'docker' ? -1 : 1))
    .map(toMeta);
  const all: ServiceMeta[] = [...SERVICES.map((s): ServiceMeta => ({ ...s, source: 'curated' })), ...discovered];

  const visible = all.filter((s) => !hidden.has(s.id));
  const used = new Set(visible.filter((s) => s.source === 'curated').map((s) => s.keyNumber));
  const free = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].filter((k) => !used.has(k));
  return {
    visible: visible.map((s) => (s.source === 'curated' ? s : { ...s, keyNumber: free.shift() ?? '' })),
    hidden: all.filter((s) => hidden.has(s.id)),
  };
}

/** Hides or shows a service. False for an id the dashboard does not know. */
export function setHidden(id: string, hide: boolean): boolean {
  const known = SERVICES.some((s) => s.id === id) || state.seen.some((s) => s.id === id);
  if (!known) return false;
  const rest = state.hidden.filter((h) => h !== id);
  state = { ...state, hidden: hide ? [...rest, id].slice(-MAX_HIDDEN) : rest };
  save();
  changed();
  return true;
}
