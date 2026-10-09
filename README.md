# Pulse

A self-hosted dashboard for a single Linux VPS: live telemetry, service links, logs, service control and a browser terminal, all behind one login.

Built with React 19, TypeScript and Vite on the frontend, and an Express 5 API on Node 22.12+. History is stored in `node:sqlite`, so there is no database server to run.

## Features

- **Live telemetry.** CPU, memory, disk, inodes, filesystems, processes, Docker containers and probe latency, sampled every 5 seconds.
- **History.** Charts for the last 5 minutes up to 24 hours, kept in SQLite for 25 hours. History survives restarts.
- **Alerts.** Threshold rules for CPU, RAM, disk, inodes and latency, with debounce. Alerts appear in the bell, as toasts and as desktop notifications. Telegram delivery is optional.
- **Service links.** Cards for each app on the box. Links can point at the current host, localhost, a Tailscale IP, or HTTPS subdomains of your domain.
- **Logs and control.** Read journald logs per unit. Start, stop or restart systemd units and containers.
- **Browser terminal.** An xterm.js shell over WebSocket, with tabs, themes and find.
- **Reachability.** Checks from outside whether the box can actually be reached. Useful behind NAT, where a port bound to `0.0.0.0` can still be unreachable from the internet.
- **LLM spend.** Optional panel that reads usage from a local 9router database.
- **Keyboard first.** `Ctrl+K` opens the command palette. `G` then a letter opens a view. `[` toggles the sidebar. `` Ctrl+` `` opens the terminal.
- Light and dark themes, installable as a PWA, and works on phones.

## Requirements

- Linux with systemd
- Node.js **22.12 or newer**. The server needs `node:sqlite`.
- Optional:
  - Docker, for container stats and control
  - An OpenSSH server, for the terminal in its default `ssh` mode

## Quick start

```bash
git clone https://github.com/bahawww/pulse.git /opt/pulse
cd /opt/pulse
npm ci
cp .env.example .env      # then edit it, see Configuration
chmod 600 .env
npm run build
PORT=8080 node --env-file=.env dist/server/index.js
```

Open `http://127.0.0.1:8080` and log in as `ADMIN_USER` with `ADMIN_PASSWORD`.

For development, run `PORT=8081 npm run dev`. It starts the API on `:8081` and Vite on `:5173`. Vite proxies `/api` to the API.

## Configuration

All configuration is environment variables. [`.env.example`](.env.example) lists every variable. Keep your real values in `.env`, which is gitignored.

| Variable | Purpose |
|----------|---------|
| `ADMIN_USER`, `ADMIN_PASSWORD` | The single login. With no password set, nobody can log in. |
| `PORT`, `HOST` | Address the server listens on. |
| `DASHBOARD_DATA_DIR`, `DASHBOARD_DB` | Where sessions, history and the terminal's known_hosts are kept. Default: `./data`. |
| `PUBLIC_HOST`, `TAILSCALE_HOST`, `REACHABILITY_CHECKER_URL` | Reachability targets. Unset targets are skipped. |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Optional alert delivery. |
| `TERMINAL_MODE` | `ssh` (default) or `local`. See [Terminal](#terminal). |
| `NINEROUTER_DB` | Path to 9router's SQLite database, for the spend panel. |
| `VITE_BASE_DOMAIN`, `VITE_SUBDOMAINS`, `VITE_TAILSCALE_HOST` | Service link targets. These are read at **build** time, so run `npm run build` after changing them. |

The list of service cards is in `src/shared/contract.ts` (`SERVICES`). Edit it to match the apps on your box.

## Run as a service

[`deploy/vps-dashboard.service`](deploy/vps-dashboard.service) is a systemd unit template. To install it:

1. Set `User` and the node path in the template.
2. Install and start it:

```bash
sudo cp deploy/vps-dashboard.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now vps-dashboard
curl -s http://127.0.0.1/api/health
```

The unit binds port 80 through `CAP_NET_BIND_SERVICE` and runs with `NoNewPrivileges` and `ProtectSystem=full`. It loads `/opt/pulse/.env`.

[`deploy/health-ping.sh`](deploy/health-ping.sh) is a cron-friendly health check. It logs failures to journald (`journalctl -t vps-dashboard-health`) and never restarts anything.

## Terminal

In `ssh` mode, the server runs the OpenSSH client against the local sshd. This keeps the shell outside the service's systemd sandbox, so `sudo` works. One-time setup:

```bash
ssh-keygen -t ed25519 -N "" -f ~/.ssh/dashboard_terminal
cat ~/.ssh/dashboard_terminal.pub >> ~/.ssh/authorized_keys
```

`TERMINAL_MODE=local` spawns `$SHELL` directly. It is faster, but the shell inherits the sandbox.

## Security

- **Single login.** The password is compared by digest only. Sessions are stored as hashes, and login is rate limited. Only `/api/health` is public.
- **Service control is closed.**
  - No shell is used.
  - Only `start`, `stop` and `restart` are allowed.
  - A unit or container can only be targeted after the server has seen it on the system.
  - Every action needs a confirmation token.
- **System units need polkit.** Controlling system units as a non-root user needs a polkit rule that allows that user to manage those units.
- **Plain HTTP.** The dashboard has full control of the box. Don't expose it on the open internet without TLS in front of it. Prefer Tailscale or a tunnel.

## Scripts

| Command | What it does |
|---------|--------------|
| `npm run dev` | API and Vite with hot reload. |
| `npm run build` | Compile the server to `dist/server` and the client to `dist/client`. |
| `npm start` | Run the built server. |
| `npm run typecheck` | Type-check client and server. |
