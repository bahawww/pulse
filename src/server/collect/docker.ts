import fs from 'node:fs';
import http from 'node:http';
import type { DockerContainer } from '../../shared/contract.js';

/**
 * Docker container state, via the Engine HTTP API over the unix socket.
 *
 * Deliberately dependency-free: Node's http.request accepts a `socketPath`, so
 * a small JSON-over-HTTP helper avoids pulling in dockerode (~1 MB plus a
 * transitive tree) for four endpoints.
 *
 * Reachability: the socket is `srw-rw---- root:docker`, and the dashboard runs
 * as a user in the docker group. If that ever changes, the collector
 * returns [] and the caller reports it as degraded rather than failing the poll.
 */

const SOCKET_PATH = process.env.DOCKER_SOCKET ?? '/var/run/docker.sock';
const API_VERSION = 'v1.41';
const TIMEOUT_MS = 2500;

let socketUsable: boolean | null = null;

export function dockerSocketAvailable(): boolean {
  if (socketUsable !== null) return socketUsable;
  try {
    fs.accessSync(SOCKET_PATH, fs.constants.R_OK | fs.constants.W_OK);
    socketUsable = fs.statSync(SOCKET_PATH).isSocket();
  } catch {
    socketUsable = false;
  }
  return socketUsable;
}

/** Minimal JSON GET against the Docker unix socket. */
function dockerGet<T>(path: string): Promise<T | null> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        socketPath: SOCKET_PATH,
        path: `/${API_VERSION}${path}`,
        method: 'GET',
        timeout: TIMEOUT_MS,
        headers: { host: 'docker', accept: 'application/json' },
      },
      (res) => {
        if ((res.statusCode ?? 500) !== 200) {
          res.resume();
          resolve(null);
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          // The stats payload is large; cap it so one hung container cannot
          // balloon the dashboard's memory.
          if (size > 4 * 1024 * 1024) {
            req.destroy();
            resolve(null);
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

interface DockerListItem {
  Id: string;
  Names: string[];
  Image: string;
  State: string;
  Status: string;
  Names2?: string[];
}

interface DockerStats {
  cpu_stats?: {
    cpu_usage?: { total_usage?: number; percpu_usage?: number[] };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  precpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number };
  memory_stats?: { usage?: number; stats?: { cache?: number; inactive_file?: number } };
}

/** Docker reports v1 `usage` including page cache; subtract it for a host-parity number. */
function workingSet(stats: DockerStats): number {
  const usage = stats.memory_stats?.usage ?? 0;
  const cache = stats.memory_stats?.stats?.cache ?? 0;
  const inactive = stats.memory_stats?.stats?.inactive_file ?? 0;
  return Math.max(0, usage - Math.max(0, cache - inactive));
}

/** Same derivation as `docker stats`: cpu delta / system delta x online_cpus. */
function cpuPercent(stats: DockerStats): number {
  const cpu = stats.cpu_stats?.cpu_usage?.total_usage;
  const pre = stats.precpu_stats?.cpu_usage?.total_usage;
  const sys = stats.cpu_stats?.system_cpu_usage;
  const preSys = stats.precpu_stats?.system_cpu_usage;
  if (!cpu || !pre || !sys || !preSys) return 0;
  const cpuDelta = cpu - pre;
  const sysDelta = sys - preSys;
  const cpus = stats.cpu_stats?.online_cpus ?? stats.cpu_stats?.cpu_usage?.percpu_usage?.length ?? 1;
  if (sysDelta <= 0 || cpuDelta <= 0) return 0;
  return Math.round((cpuDelta / sysDelta) * cpus * 1000) / 10;
}

export async function collectDocker(limit = 24): Promise<DockerContainer[]> {
  if (!dockerSocketAvailable()) return [];

  const list = await dockerGet<DockerListItem[]>('/containers/json?all=1');
  if (!list) return [];

  // Running containers only need a stats call; stopped ones report zeros and
  // would otherwise cost one request each for nothing.
  const running = list.filter((c) => c.State === 'running');
  const statsFor = new Map<string, DockerStats>();
  await Promise.all(
    running.map(async (c) => {
      const s = await dockerGet<DockerStats>(
        `/containers/${c.Id}/stats?stream=false&once=1`,
      );
      if (s) statsFor.set(c.Id, s);
    }),
  );

  return list.slice(0, limit).map((c) => {
    const stats = statsFor.get(c.Id);
    const name = (c.Names?.[0] ?? c.Id).replace(/^\//, '').slice(0, 28);
    const health = /\(healthy\)/.test(c.Status ?? '')
      ? 'healthy'
      : /\(unhealthy\)/.test(c.Status ?? '')
        ? 'unhealthy'
        : 'none';
    return {
      id: c.Id.slice(0, 12),
      name,
      image: (c.Image ?? 'unknown').split(':')[0] ?? 'unknown',
      state: c.State ?? 'unknown',
      status: c.Status ?? '',
      health,
      // The list endpoint does not expose restart counts; inspect would cost
      // one request per container, so report 0 rather than a fabricated number.
      restartCount: 0,
      cpuPercent: stats ? cpuPercent(stats) : 0,
      memBytes: stats ? workingSet(stats) : 0,
    };
  });
}