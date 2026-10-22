# Agent launcher (agy, Claude Code) and agent status — design

Date: 2026-10-22. Status: draft, waiting for approval.

## Why

The owner (bahar) uses Pulse mostly from a phone. Antigravity CLI (`agy`) has
no mobile app, only a web takeover page. Claude Code reaches the phone through
the Claude app, but starting it still means a laptop: open tmux, start
`claude`, turn on remote control. Today both mean copying a long URL from a
terminal screen to a phone.

Goal: from the phone, one tap in Pulse starts an agy or a Claude Code session
with remote control on, and the takeover link is one big button. A card on
Home shows at a glance which agents are running.

## Goals

- Start an agy or a Claude Code session from Pulse with one tap, no typing.
- Show each session's remote link as a large "Open" button plus "Copy link".
- List live sessions so the owner can reopen a link later, or stop one.
- Sessions outlive the phone, the browser tab and a Pulse restart (tmux).
- Home shows one "Agents" card: what runs, what waits, one tap to each.

## Non-goals

- Chatting with agy or Claude Code inside Pulse (no stream-json adapter).
- Hermes or OpenCode in the launcher (OpenCode already has Pulse chat; Hermes
  has its messaging bridges). They appear on the status card only.
- Choosing a folder other than the home folder.
- The persistent daemons (`agy remote-control`, `claude remote-control`).
  Remote control is per session.
- Detecting "waiting for permission" inside agy or Claude Code. Their own
  remote pages show that; reading it off a TUI screen is fragile.

## Anti-goals

- A tap that silently fails: if no link appears, the owner must see why and
  have a way into the session.
- A link shown to a login that could not otherwise run commands as bahar.

## Decided by the owner

- Agents in the launcher: agy and Claude Code.
- Folder: `/home/bahar` (the SSH user's home).
- Placement: the floating round button (`src/components/ChatFab.tsx`) becomes
  an agent menu. Opening the chat now takes two taps; the owner accepted that.
- A status card for agents on Home.

## Facts verified on this box (2026-10-22)

agy 1.4.2:
- `agy --remote-control` prints, about 3 s after start-up:
  `Open https://antigravity.google.com/r/<uuid>-v2 on another device to take over.`
- The same id is in its log (`--log-file`): `[remote-control-<uuid>-v2]`.
- Unknown folder: asks "Do you trust the contents of this project?" with
  "Yes, I trust this folder" **preselected**; Enter accepts.

Claude Code 2.1.308:
- `claude --remote-control <name>` prints after start-up:
  `/remote-control is active · Continue here, on your phone, or at`
  followed by `https://claude.ai/code/session_<id>` (may wrap to the next
  line; read the pane with `-J`). The session also appears by `<name>` in the
  Claude app and at claude.ai/code.
- Unknown folder: a trust screen with **"No, exit" preselected**. Enter alone
  exits. Accept with Down, then Enter.

Both:
- Binaries at `~/.local/bin/agy` and `~/.local/bin/claude`. A non-interactive
  SSH command may not have that on PATH: use the full path.
- Killing the tmux session ends the agent and its remote link.

## How it works

One small server module handles both kinds; a kind is a record of
{prefix, command, trust-prompt pattern and keys, link pattern}.

| kind | tmux prefix | command | trust answer | link |
|------|-------------|---------|--------------|------|
| agy | `agy-` | `~/.local/bin/agy --remote-control --log-file ~/.cache/pulse-agents/<name>.log` | Enter | last `[remote-control-<id>]` in the log, else pane |
| claude | `cc-` | `~/.local/bin/claude --remote-control <name>` | Down, Enter | pane `https://claude.ai/code/session_\w+` |

1. **Start.** `POST /api/agents/sessions {kind}` creates tmux session
   `<prefix><HHMM>` (suffix `-2`, `-3` if taken; names match `TMUX_RE` in
   `src/server/tmux.ts`) in `~/`, running the kind's command. Run through the
   loopback SSH login (`runRemote` in `src/server/files.ts`), like the tmux
   manager, so it runs as bahar outside the sandbox.
2. **Trust prompt.** Poll `tmux capture-pane -p -J` for up to ~20 s. If the
   pane shows the kind's trust prompt, send its keys once.
3. **Link.** First hit wins during start; the latest link is cached on the
   session with `tmux set-option -t <name> @agent_link <url>`. For agy the log
   is the source of truth afterwards (the TUI redraws, and a reconnect may
   bring a new id). For Claude Code the cached link is the record; its
   session id does not change while the process lives.
4. **List.** `GET /api/agents/sessions`: tmux sessions with a known prefix,
   each with kind, name, link (agy: re-read from the log tail, falling back to
   `@agent_link`; Claude: `@agent_link`, else a fresh pane read), created and
   activity time. Log files of sessions that no longer exist are deleted.
5. **Stop.** `POST /api/agents/sessions/stop {name}`: `tmux kill-session -t =<name>`,
   only for names with a known prefix.
6. **No link in time.** The start call answers with the name and no link. The
   UI says "started, no link yet" and offers "Open terminal", which attaches
   that tmux session in Pulse's terminal. The list keeps looking on refresh.

## UI (phone first)

**Agent menu** (the round button; a bottom sheet on phones like other `.pop`
menus via `src/lib/sheets.ts`):
- "Chat OpenCode" (only with `chat`) opens the chat as today.
- "New agy session" and "New Claude Code session" (only with `terminal`).
  While starting: spinner, "Starting agy…".
- One card per live session: kind icon, name, age, a large "Open in agy web ↗"
  or "Open in Claude ↗" (new tab, `rel="noopener"`), "Copy link",
  "Open terminal", "Stop" (asks to confirm).
- The button shows when the login has `chat` or `terminal` (today: `chat` only).
  Its busy ring and "!" badge keep meaning the OpenCode chat state.

**Agents card on Home** (the overview view), one row per agent:
- OpenCode: idle / working / waiting for your answer (the chat state the
  round button already gets). Tap opens the chat.
- agy, Claude Code: "N running" or "none". Tap opens the agent menu. With
  exactly one session, the row has its "Open ↗" link directly.
- Hermes: online or offline, from the Hermes service card's status (no new
  server code). Tap does nothing new.
- Rows the login may not use are hidden; the card is hidden when none remain.
- It refreshes on the existing sample tick or with the menu's list, not on a
  new fast timer.

## Constraints

- Permission: every `/api/agents/*` route needs `terminal` (both agents run
  commands as bahar, who has NOPASSWD sudo). Routes sit behind the existing
  session and CSRF gates; writes use the action rate limiter.
- Start and stop go to the action log (`recordAction`, target `agent`); the
  user column fills itself.
- No shell interpolation of user input: inputs are a kind (one of two literals)
  and a session name checked against `/^(agy|cc)-[A-Za-z0-9_-]{1,36}$/`,
  passed through `shq`.
- Match the codebase: Express routes like `src/server/tmux.ts`, plain CSS on
  tokens or `tw:` Tailwind for new components, phone layer in `mobile.css`.
- Keep `npm run typecheck` and `npm test` green; add tests for both link
  parsers, both trust detectors and the name check.

## Calls made during design (Claude's, the owner may overrule)

- **Shared, not per user.** Every login with `terminal` sees and may stop every
  session. All such logins are already root-equivalent; in practice one owner.
- **Tmux manager.** Agent sessions stay visible there (attach is useful), but
  its rename refuses names with an agent prefix, both from and to, so the
  launcher never loses one. Small change in `src/server/tmux.ts` plus a test.
- **Limit: 3 live sessions per kind.** A fourth answers 409; the menu disables
  that "New …" item with "3 running: stop one first".
- **Claude Code session name** is the tmux name (`cc-1915`), so the Claude app
  list and Pulse agree.
- **Hermes on the card** reads the existing service status only.

## Left to the builder

- Exact poll interval and timeout (around 500 ms / 20 s).
- How "Open terminal" reaches the terminal view from the menu (the terminal
  attaches tmux via `attachTmux` in `TerminalWorkspace.tsx`; there is no
  cross-view hook yet).
- Where on Home the card sits, copy, icons, motion and styling, within the
  existing design system.
- Whether `ChatFab.tsx` grows the menu or a new component wraps it.
