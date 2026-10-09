import { SUBDOMAIN_PATHS, type ServiceCategoryMeta } from '../shared/contract';
import { BASE_DOMAIN, TAILSCALE_HOST, subdomainFor } from './site';

/** 'auto', 'localhost', a direct host such as the Tailscale IP, or BASE_DOMAIN for subdomain mode. */
export type HostMode = string;

const HOST_STORAGE_KEY = 'vps_host_override';
const HOST_RESET_FLAG = 'vps_host_reset_v1';

/** Rows of the link-target menu. Rows whose address is not configured are left out. */
export const HOST_OPTIONS: readonly { value: HostMode; label: string; hint: string }[] = [
  { value: 'auto', label: 'Auto (current host)', hint: 'Resolve from the address bar' },
  ...(TAILSCALE_HOST ? [{ value: TAILSCALE_HOST, label: 'Tailscale', hint: `${TAILSCALE_HOST} — private overlay` }] : []),
  { value: 'localhost', label: 'Localhost', hint: '127.0.0.1 — this machine only' },
  ...(BASE_DOMAIN ? [{ value: BASE_DOMAIN, label: 'Cloudflare subdomains', hint: `*.${BASE_DOMAIN} over HTTPS` }] : []),
];

/**
 * Resolves the URL a service link should point at.
 *
 * Two modes:
 *  - Cloudflare subdomain mode: https://<subdomain>.<BASE_DOMAIN>/path
 *  - Direct port mode:        http://<host>:<port>/path
 *
 * This VPS is NAT'd, so direct port links only work from inside the LAN or over
 * Tailscale — the subdomain mode is the only path that resolves publicly.
 */
export function buildServiceUrl(service: ServiceCategoryMeta, hostMode: HostMode): string {
  if (isSubdomainMode(hostMode)) {
    const subdomain = subdomainFor(service.id);
    const path = service.id in SUBDOMAIN_PATHS ? SUBDOMAIN_PATHS[service.id] ?? '' : service.path;
    return `https://${subdomain}${path}`;
  }
  const host = hostMode === 'auto' ? window.location.hostname || '127.0.0.1' : hostMode;
  return `http://${host}:${service.port}${service.path}`;
}

export function isSubdomainMode(hostMode: HostMode): boolean {
  if (!BASE_DOMAIN) return false;
  if (hostMode === BASE_DOMAIN) return true;
  if (hostMode !== 'auto') return false;
  const hostname = window.location.hostname;
  return hostname === BASE_DOMAIN || hostname.endsWith(`.${BASE_DOMAIN}`);
}

export function readStoredHostMode(): HostMode {
  try {
    // One-time reset to auto. The link-target menu is hidden, so a stored
    // override could not be seen or changed from the UI.
    if (localStorage.getItem(HOST_RESET_FLAG) === null) {
      localStorage.removeItem(HOST_STORAGE_KEY);
      localStorage.setItem(HOST_RESET_FLAG, '1');
    }
    const stored = localStorage.getItem(HOST_STORAGE_KEY);
    if (stored === null) return 'auto';
    // Only restore a value that still has a row in the menu; anything else
    // (a retired public IP, a host from an older build) falls back to auto.
    if (HOST_OPTIONS.some((opt) => opt.value === stored)) return stored;
    localStorage.removeItem(HOST_STORAGE_KEY);
  } catch {
    /* private mode */
  }
  return 'auto';
}

export function storeHostMode(mode: HostMode): void {
  try {
    localStorage.setItem(HOST_STORAGE_KEY, mode);
  } catch {
    /* private mode */
  }
}

/** "16 Cores · Intel Xeon Gold 6230" — strips the marketing noise from lscpu. */
export function cleanCpuModel(model: string): string {
  return model
    .replace(/\(R\)|\(TM\)|Processor|CPU|@.*$/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function formatUptime(seconds: number): string {
  if (!seconds || seconds < 0) return '--';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * Copy with a document.execCommand fallback: this dashboard is served over plain
 * HTTP, where navigator.clipboard is undefined (it needs a secure context).
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* fall through to the legacy path */
    }
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.top = '-9999px';
    textarea.setAttribute('readonly', '');
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}