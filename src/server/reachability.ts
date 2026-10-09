import type { ReachabilityReport, ReachabilityResult, ReachabilityTarget } from '../shared/contract.js';

/**
 * External reachability.
 *
 * The failure this exists to catch: the dashboard shows every service green,
 * the port is bound to 0.0.0.0, and no client outside can actually connect —
 * because the box is behind NAT and the port was never forwarded. Everything
 * local says healthy. Nothing works. That gap is invisible without a check
 * that comes from the outside.
 *
 * What this module can honestly do, and what it cannot:
 *
 *  - It CAN establish whether an outside client could reach this host, by asking
 *    an external service to try. A single TCP connect from a third-party
 *    vantage point answers the only question that matters.
 *  - It CANNOT prove reachability by curling itself. A loopback request to
 *    127.0.0.1 succeeds behind NAT every single time and tells you nothing, so
 *    the local probe is explicitly labelled as local-only and never counted as
 *    proof.
 *
 * A local check is still useful, so it runs — but as a distinct status
 * ("local-only"), not folded in with the external result. When no external
 * checker is configured, the panel says the check did not run. It never
 * reports "ok" on the strength of a request that stayed on the machine.
 */

const PORT = Number(process.env.PORT ?? 80);

/** Public IP or hostname of this box, and its Tailscale address. Unset means that target is skipped. */
const PUBLIC_HOST = (process.env.PUBLIC_HOST ?? '').trim();
const TAILSCALE_HOST = (process.env.TAILSCALE_HOST ?? '').trim();

/** Services worth checking from outside, with the status codes that count as up. */
const TARGETS: readonly ReachabilityTarget[] = [
  ...(PUBLIC_HOST
    ? [{ id: 'dashboard', label: `Dashboard (port ${PORT})`, url: `http://${PUBLIC_HOST}:${PORT}/`, method: 'GET', expectStatus: [200] } as const]
    : []),
  ...(TAILSCALE_HOST
    ? [{ id: 'tailscale', label: 'Tailscale (port 22 via mesh)', url: `http://${TAILSCALE_HOST}:22/`, method: 'GET', expectStatus: [0] } as const]
    : []),
];

/**
 * Optional external checker. When set, its /api/check?url= endpoint is asked to
 * perform a real request from outside this network. An unset value means the
 * external leg of the check simply did not run.
 */
function externalChecker(): string | null {
  const raw = process.env.REACHABILITY_CHECKER_URL ?? '';
  if (!raw) return null;
  if (!/^https?:\/\/[a-zA-Z0-9.:-]+(?:\/[^\s]*)?$/.test(raw)) return null;
  return raw;
}

/**
 * A cache keeps this off the critical path: an outbound request per poll, per
 * target, forever, is a self-inflicted load problem and can look like a DDoS
 * from the outside.
 */
const TTL_MS = 60_000;
const cache = new Map<string, { at: number; result: ReachabilityResult }>();

/** Whether this host appears to be NAT'd, judged from its own addresses. */
async function detectNat(): Promise<{ behindNat: boolean; publicIp: string | null; tailscaleIp: string | null }> {
  let tailscaleIp: string | null = null;
  try {
    const os = await import('node:os');
    for (const list of Object.values(os.networkInterfaces())) {
      for (const net of list ?? []) {
        if (net.family === 'IPv4' && /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(net.address)) {
          tailscaleIp = net.address;
        }
      }
    }
  } catch {
    tailscaleIp = null;
  }

  // Ask an external service what it sees as this host's address, then compare.
  // If the address it reports is not one of ours, we are behind NAT.
  let publicIp: string | null = null;
  let behindNat = false;
  try {
    const res = await fetch('https://api.ipify.org?format=json', {
      signal: AbortSignal.timeout(5000),
      headers: { Accept: 'application/json' },
    });
    if (res.ok) {
      const body = (await res.json()) as { ip?: string };
      if (body.ip) publicIp = body.ip;
    }
  } catch {
    publicIp = null;
  }

  if (publicIp) {
    const os = await import('node:os');
    const mine = new Set<string>();
    for (const list of Object.values(os.networkInterfaces())) {
      for (const net of list ?? []) if (net.family === 'IPv4') mine.add(net.address);
    }
    behindNat = !mine.has(publicIp);
  }

  return { behindNat, publicIp, tailscaleIp };
}

async function checkOne(target: ReachabilityTarget): Promise<ReachabilityResult> {
  const checkedAt = Date.now();

  // Local leg. Establishes the server itself is serving, which is necessary but
  // not sufficient for external reachability.
  let localStatus: number | null = null;
  let localMs: number | null = null;
  try {
    const url = target.url.replace(/^https?:\/\/[^/]+/, 'http://127.0.0.1');
    const started = Date.now();
    const res = await fetch(url, { signal: AbortSignal.timeout(4000), method: target.method });
    localStatus = res.status;
    localMs = Date.now() - started;
    res.body?.cancel();
  } catch {
    localStatus = null;
  }

  const checker = externalChecker();
  if (!checker) {
    return {
      target,
      status: 'unknown',
      httpStatus: localStatus,
      latencyMs: localMs,
      checkedAt,
      detail:
        localStatus === null
          ? 'local service not answering, and no external checker configured'
          : `service answers locally (${localStatus}ms) but external reachability was NOT verified — set REACHABILITY_CHECKER_URL`,
    };
  }

  try {
    const started = Date.now();
    const res = await fetch(`${checker}?url=${encodeURIComponent(target.url)}`, {
      signal: AbortSignal.timeout(9000),
      headers: { Accept: 'application/json' },
    });
    const ms = Date.now() - started;
    if (!res.ok) {
      return {
        target,
        status: 'unknown',
        httpStatus: localStatus,
        latencyMs: localMs,
        checkedAt,
        detail: `external checker returned ${res.status}`,
      };
    }
    const body = (await res.json()) as { status?: number; reachable?: boolean; error?: string };
    const reachable = body.reachable ?? (body.status ? target.expectStatus.includes(body.status) : false);
    return {
      target,
      status: reachable ? 'ok' : 'blocked',
      httpStatus: body.status ?? null,
      latencyMs: ms,
      checkedAt,
      detail: reachable
        ? `reachable from outside (${body.status ?? 'connected'})`
        : `NOT reachable from outside${body.error ? `: ${body.error}` : ''}`,
    };
  } catch (err) {
    return {
      target,
      status: 'unknown',
      httpStatus: localStatus,
      latencyMs: localMs,
      checkedAt,
      detail: `external check failed: ${err instanceof Error ? err.message.slice(0, 80) : 'error'}`,
    };
  }
}

export async function checkReachability(): Promise<ReachabilityReport> {
  const nat = await detectNat();

  const results: ReachabilityResult[] = [];
  for (const target of TARGETS) {
    const cached = cache.get(target.id);
    if (cached && Date.now() - cached.at < TTL_MS) {
      results.push(cached.result);
      continue;
    }
    const result = await checkOne(target);
    cache.set(target.id, { at: Date.now(), result });
    results.push(result);
  }

  return { results, ...nat };
}

/** The ports this box advertises, for the panel's header. */
export function advertisedPorts(): { port: number; bound: boolean }[] {
  return [{ port: PORT, bound: true }];
}