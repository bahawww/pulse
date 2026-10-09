/**
 * Per-deployment addresses. Read from VITE_* variables at build time (Vite loads
 * them from `.env` in the project root), so no host, IP or domain lives in the
 * source. Anything left unset hides the option that needs it.
 *
 *   VITE_BASE_DOMAIN     example.com — services resolve as https://<sub>.example.com
 *   VITE_SUBDOMAINS      service id to subdomain label, e.g. "novnc=remote,hermes=hermes".
 *                        A service with no entry uses its id as the label.
 *   VITE_TAILSCALE_HOST  100.x.y.z — adds a "Tailscale" row to the link-target menu
 */

const env = import.meta.env;

export const BASE_DOMAIN: string = (env.VITE_BASE_DOMAIN ?? '').trim();
export const TAILSCALE_HOST: string = (env.VITE_TAILSCALE_HOST ?? '').trim();

const SUBDOMAIN_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  String(env.VITE_SUBDOMAINS ?? '')
    .split(',')
    .map((pair) => pair.split('=').map((part) => part.trim()))
    .filter((pair): pair is [string, string] => pair.length === 2 && pair[0] !== '' && pair[1] !== ''),
);

/** Full hostname a service gets in subdomain mode, or null when no base domain is set. */
export function subdomainFor(serviceId: string): string | null {
  if (!BASE_DOMAIN) return null;
  return `${SUBDOMAIN_LABELS[serviceId] ?? serviceId}.${BASE_DOMAIN}`;
}
