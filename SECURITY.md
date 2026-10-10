# Security

Pulse can restart services and opens a full shell as a user with sudo. Treat
access to it as access to the machine. This file describes the defences, what
each one protects, and the results of the last audit.

## Reporting

Open a private security advisory on the GitHub repository. Please do not file
a public issue for a vulnerability.

## Threat model

| Threat | Defence |
| --- | --- |
| Password guessing | Digest comparison in constant time, 800 ms fixed delay on failure, 5 failures per client lock that client for 15 minutes, 30 attempts per 15 minutes per address overall. A startup warning flags passwords under 12 characters. |
| Stolen session file | Only SHA-256 hashes of session tokens are stored (`data/sessions.json`, mode 0600); a hash cannot be replayed as a cookie. |
| Session fixation | Every login destroys any session the request already had and issues a new one. |
| Cross-site request forgery | Three independent layers, see below. |
| Cross-site WebSocket hijacking | The terminal upgrade checks Origin against Host, requires a session, and requires the CSRF token as a subprotocol. |
| XSS | React escapes by default. The CSP allows scripts only from this origin plus the SHA-256 hash of the one inline bootstrap script; inline event handlers are blocked (`script-src-attr 'none'`). |
| Clickjacking | `frame-ancestors 'self'`. |
| Command injection | Every process is started with `execFile` or node-pty and an argv array, never a shell string. Units, containers, log units, remote hosts and users are checked against strict patterns, and actions against a live allowlist. |
| Spoofed client address | `CF-Connecting-IP` and `X-Forwarded-*` are believed only on connections from loopback, where cloudflared connects. A direct client cannot rotate a fake address past the login lockout. |
| Resource exhaustion | Body limit 16 KB, per-route rate limits, at most 24 terminals, 8 event streams per session and 64 overall, pty output paused when the socket or browser falls behind. |
| Information leaks | `/api/health` is the only open endpoint and answers `{"status":"ok"}` only. Every API answer is `Cache-Control: no-store`. |
| Compromise of the process | systemd sandbox, see below. |

## CSRF

State-changing requests (`POST`, `PUT`, `PATCH`, `DELETE` under `/api`) pass
three checks in `src/server/index.ts`:

1. **Same origin.** `Origin` must match `Host`, and `Sec-Fetch-Site`, when
   sent, must be `same-origin`. A request with neither header is refused.
2. **JSON only.** A body must be `application/json`, which an HTML form on
   another site cannot send without a CORS preflight that the server refuses.
3. **Token.** `X-CSRF-Token` must equal `HMAC-SHA256(key, session hash)`
   (`src/server/csrf.ts`). The key is 32 random bytes in `data/csrf.key`
   (0600). The token changes with every login, ends with the session, and
   needs no per-session storage. The login request itself has no session yet
   and relies on checks 1 and 2 plus the `SameSite=Strict` cookie.

The client receives the token from `/api/auth/me` and the login answer, keeps
it in memory only, and sends it with `postJson` (`src/lib/csrf.ts`). The
terminal sends it as the WebSocket subprotocol `pulse.csrf.<token>`; the server
answers with `pulse.v1` and never echoes the token.

The session cookie is `HttpOnly`, `SameSite=Strict`, and `Secure` whenever the
request arrived over HTTPS.

## Process sandbox

`deploy/pulse.service` plus `deploy/hardening.conf` (a drop-in) run the
service as an unprivileged user with `NoNewPrivileges`, a read-only `/usr`,
`/boot`, `/etc` and home, a private `/tmp`, only `CAP_NET_BIND_SERVICE`, no
kernel tunables, modules, logs or clock, no new namespaces, native syscalls
only, and `UMask=0077`. `systemd-analyze security pulse` scores it 3.7 ("OK"),
down from 8.5 before the drop-in.

Not enabled, on purpose: `ProtectProc` (the process list reads other users'
`/proc` entries), `PrivateDevices` (node-pty needs `/dev/ptmx`) and
`MemoryDenyWriteExecute` (V8's JIT).

The terminal reaches a real shell through the loopback sshd, so the shell
itself is outside this sandbox. The SSH key it uses is accepted only from
loopback (`from=` in `authorized_keys`) and the host key is pinned.

## Deployment rules

- Do not expose port 80 to the internet directly. Put TLS in front (a tunnel or
  reverse proxy), or reach it over a VPN such as Tailscale.
- Set `ADMIN_PASSWORD` to 12 characters or more. Without it nobody can log in.
- Keep `.env`, `terminal.secret`, `data/sessions.json` and `data/csrf.key` at
  mode 0600. Never commit them.
- Telnet sends passwords in clear text. Use the Telnet target only on a network
  you trust.

## Audit log

### 2026-10-10

Scope: server routes and middleware, session and login, terminal WebSocket,
service actions, log reads, headers and CSP, systemd unit, npm dependencies.

| # | Finding | Severity | Status |
| --- | --- | --- | --- |
| 1 | No CSRF token. `POST /api/action` had no origin check, and the login/logout check passed any request without an `Origin` header. Protection rested on `SameSite=Strict` alone. | Medium | Fixed: three-layer CSRF gate, token on the terminal upgrade. |
| 2 | `CF-Connecting-IP` was trusted from any client and `trust proxy` was `1`. A client reaching port 80 directly could send a new address with every login attempt and never hit the per-client lockout. | Medium | Fixed: forwarded headers believed only from loopback. |
| 3 | `script-src 'unsafe-inline'` let any injected inline script run. | Medium | Fixed: hash of the bootstrap script, `script-src-attr 'none'`. |
| 4 | systemd exposure 8.5 ("EXPOSED"). | Low | Fixed: hardening drop-in, now 3.7. |
| 5 | A login did not replace a session the browser already held. | Low | Fixed: login always issues a fresh session. |
| 6 | `/api/health` exposed pid and uptime without login. | Info | Fixed: status only. |
| 7 | Some API answers had no `Cache-Control`. | Info | Fixed: `no-store` on all of `/api`. |
| 8 | `npm audit --omit=dev`: 0 vulnerabilities. | — | No action. |

Open items, accepted for now:

- Sessions last 7 days with no idle timeout. Logging out, or the session
  expiring, closes its terminals and streams.
- An attacker with many real addresses can still try 5 passwords per address
  per 15 minutes. A long password is the control that matters.
- `style-src` keeps `'unsafe-inline'`, which React's `style` props need. Style
  injection cannot run script under this CSP.
- If Cloudflare is set to inject its own inline scripts (bot detection), the
  CSP blocks them. The app is unaffected.
