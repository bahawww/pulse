import http from 'node:http';
import net from 'node:net';
import { SERVICES, type ServiceCategoryMeta, type ServiceStatus } from '../shared/contract.js';

const PROBE_TIMEOUT_MS = 1500;

/** Refuse to buffer an unbounded body from a service that never ends its response. */
const MAX_PROBE_BYTES = 64 * 1024;

export interface ProbeResult extends ServiceStatus {
  readonly id: string;
}

/**
 * TCP-connect probe. Cheaper and more honest than the legacy HTTP GET: we care
 * whether the port answers, and a HEAD request to some dashboards hangs on a
 * full page render. A connect + immediate destroy is ~1 syscall.
 */
function probeTcp(host: string, port: number, timeoutMs: number): Promise<{ latency: number }> {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const socket = new net.Socket();

    const finish = (fn: () => void) => {
      socket.removeAllListeners();
      socket.destroy();
      fn();
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      const latency = Number(process.hrtime.bigint() - started) / 1e6;
      finish(() => resolve({ latency: Math.round(latency * 100) / 100 }));
    });
    socket.once('timeout', () => finish(() => reject(new Error('timeout'))));
    socket.once('error', (err) => finish(() => reject(err)));
    socket.connect(port, host);
  });
}

/**
 * Kept for services that answer on TCP but not on the probed path — currently
 * unused, but a documented HTTP fallback if a probe needs a status code.
 */
export function probeHttp(
  host: string,
  service: ServiceCategoryMeta,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<{ latency: number; statusCode: number }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = http.get(
      {
        hostname: host,
        port: service.port,
        path: service.path.split('?')[0] ?? '/',
        timeout: timeoutMs,
      },
      (res) => {
        const latency = Date.now() - started;
        let received = 0;
        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > MAX_PROBE_BYTES) {
            res.destroy();
          }
        });
        res.on('end', () => {
          resolve({ latency, statusCode: res.statusCode ?? 0 });
        });
      },
    );
    req.on('error', () => resolve({ latency: -1, statusCode: 0 }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ latency: -1, statusCode: 408 });
    });
  });
}

export async function checkServiceStatus(
  service: ServiceCategoryMeta,
  host = '127.0.0.1',
): Promise<ProbeResult> {
  try {
    const { latency } = await probeTcp(host, service.port, PROBE_TIMEOUT_MS);
    return { id: service.id, online: true, statusCode: null, latency };
  } catch {
    return { id: service.id, online: false, statusCode: null, latency: null };
  }
}

export async function checkAllServices(host = '127.0.0.1'): Promise<Map<string, ServiceStatus>> {
  const results = await Promise.all(SERVICES.map((s) => checkServiceStatus(s, host)));
  return new Map(results.map((r) => [r.id, { online: r.online, statusCode: r.statusCode, latency: r.latency }]));
}