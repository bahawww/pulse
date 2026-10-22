# Agent Launcher and Agents Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One tap in Pulse starts an agy or Claude Code session in tmux with remote control on and shows its takeover link; a Home card shows which agents run.

**Architecture:** A new server module `src/server/agents.ts` drives tmux over the loopback SSH login (`runRemote`), with its tmux/sleep/clock calls injected so the whole start flow is unit-tested with a fake. Three routes behind `terminal`. On the client, one hook polls the session list; the round chat button becomes an agent menu, and a card on Overview reads the same data.

**Tech Stack:** Node 22+ / Express 5 / TypeScript, React 19, tmux, `node:test` via `tsx --test`.

**Spec:** `docs/superpowers/specs/2026-10-22-agent-launcher-design.md`

## Global Constraints

- Every `/api/agents/*` route: `requirePerm('terminal')`; reads use `apiLimiter`, writes `actionLimiter` (both in `src/server/index.ts`).
- Session names: `/^(agy|cc)-[A-Za-z0-9_-]{1,36}$/`, always passed to the shell through `shq` (`src/server/sshLocal.ts`).
- Folder: the SSH user's home (`~`). Binaries by full path: `~/.local/bin/agy`, `~/.local/bin/claude`.
- agy command: `~/.local/bin/agy --remote-control --log-file ~/.cache/pulse-agents/<name>.log`.
- Claude command: `~/.local/bin/claude --remote-control <name>`.
- Limit: 3 live sessions per kind; the 4th start answers 409 `{ error: '3 running: stop one first' }`.
- Start/stop write `recordAction` with target `'agent'`.
- Start waits for a link at most 18 s (`runRemote` kills commands at 20 s).
- `npm run typecheck` and `npm test` stay green after every task.

## Review Focus

1. A folder agy or Claude already trusts shows no trust prompt: nothing may be typed into the session. Test in Task 1 (`trustKeys` → `null`), Task 2 (no `send-keys` in the fake log).
2. Claude's trust screen preselects "No, exit": Enter alone would quit. Test in Task 1 (keys are `['Down', 'Enter']`).
3. agy reconnects and prints a new id: the newest link wins. Test in Task 1 (`findLink` returns the last of two).
4. A session killed outside Pulse: the list drops it and its log file is removed; stopping it answers 404. Test in Task 2.
5. tmux missing or the SSH key gone (`runRemote` code `-1`): start answers 503 with the stderr text, not a hang or 500. Test in Task 2.

---

### Task 1: Pure helpers and shared types

**Files:**
- Create: `src/server/agents.ts`
- Modify: `src/shared/contract.ts` (near `ActionLogEntry`, ~line 474)
- Test: `src/server/agents.test.ts`

**Interfaces:**
- Produces in `contract.ts`:
  - `export type AgentKind = 'agy' | 'claude';`
  - `export interface AgentSession { readonly kind: AgentKind; readonly name: string; readonly link: string | null; readonly created: number; readonly activity: number }` (epoch ms)
  - `export const AGENT_LIMIT = 3;`
  - `ActionLogEntry['target']` gains `'agent'`.
- Produces in `agents.ts`:
  - `export const AGENT_NAME = /^(agy|cc)-[A-Za-z0-9_-]{1,36}$/`
  - `export function agentKindOf(name: string): AgentKind | null` (by prefix `agy-` / `cc-`, regardless of the rest)
  - `export function nextName(kind: AgentKind, taken: readonly string[], now: Date): string`
  - `export function trustKeys(kind: AgentKind, pane: string): readonly string[] | null`
  - `export function findLink(kind: AgentKind, text: string): string | null`

- [ ] **Step 1: Write the failing tests** in `src/server/agents.test.ts`:

```ts
test('agentKindOf reads the prefix', () => {
  assert.equal(agentKindOf('agy-1915'), 'agy');
  assert.equal(agentKindOf('cc-1915-2'), 'claude');
  assert.equal(agentKindOf('main'), null);
  assert.equal(AGENT_NAME.test('agy-1915'), true);
  assert.equal(AGENT_NAME.test("agy-x';rm"), false);
});
test('nextName uses HHMM, then -2, -3', () => {
  const at = new Date(2026, 9, 22, 19, 5);
  assert.equal(nextName('agy', [], at), 'agy-1905');
  assert.equal(nextName('claude', ['cc-1905'], at), 'cc-1905-2');
  assert.equal(nextName('claude', ['cc-1905', 'cc-1905-2'], at), 'cc-1905-3');
});
test('trustKeys: agy Enter, claude Down+Enter, nothing without a prompt', () => {
  assert.deepEqual(trustKeys('agy', 'Do you trust the contents of this project?\n> Yes, I trust this folder'), ['Enter']);
  assert.deepEqual(trustKeys('claude', '❯ No, exit\n  Yes, I trust this folder'), ['Down', 'Enter']);
  assert.equal(trustKeys('agy', '? for shortcuts'), null);
  assert.equal(trustKeys('claude', '❯ Try "write a test"'), null);
});
test('findLink: newest link from pane or log', () => {
  const pane = 'Open https://antigravity.google.com/r/64bac457-ac56-4b8c-9675-ef090a5f0704-v2 on another device';
  assert.equal(findLink('agy', pane), 'https://antigravity.google.com/r/64bac457-ac56-4b8c-9675-ef090a5f0704-v2');
  const log = '[remote-control-aaaa-v2] Starting\n[remote-control-bbbb-v2] Starting';
  assert.equal(findLink('agy', log), 'https://antigravity.google.com/r/bbbb-v2');
  assert.equal(findLink('claude', 'on your phone, or at\n  https://claude.ai/code/session_01Qgg7XvdzRkNvAGYm8AHLLL  '), 'https://claude.ai/code/session_01Qgg7XvdzRkNvAGYm8AHLLL');
  assert.equal(findLink('claude', 'nothing yet'), null);
});
```

- [ ] **Step 2: Run, expect FAIL** — `npm test` → "Cannot find module './agents.js'".
- [ ] **Step 3: Implement** the contract types and the four helpers. `findLink` for agy matches both `https://antigravity\.google\.com/r/[A-Za-z0-9-]+` and `\[remote-control-([A-Za-z0-9-]+)\]` and returns the one at the largest index; Claude matches `https://claude\.ai/code/session_[A-Za-z0-9]+`, last match.
- [ ] **Step 4: Run, expect PASS** — `npm test` (all files) and `npm run typecheck`.
- [ ] **Step 5: Commit** — `git add src/server/agents.ts src/server/agents.test.ts src/shared/contract.ts && git commit -m "feat(agents): name, trust and link helpers"`

### Task 2: Start, list, stop, routes, tmux rename guard

**Files:**
- Modify: `src/server/agents.ts`, `src/server/tmux.ts` (`renameSession`), `src/server/index.ts` (route block near `/api/tmux`)
- Test: `src/server/agents.test.ts`

**Interfaces:**
- Consumes: Task 1 helpers; `runRemote(cmd: string, maxBytes?: number): Promise<RunResult>` and `RunResult { code: number | null; stdout: Buffer; stderr: string }` from `files.ts`; `shq` from `sshLocal.ts`; `recordAction` from `store.ts`.
- Produces:
  - `export interface AgentDeps { run(cmd: string): Promise<RunResult>; sleep(ms: number): Promise<void>; now(): Date; timeoutMs: number }` and `const realDeps: AgentDeps` (`runRemote`, `setTimeout` promise, `new Date()`, `18_000`).
  - `export async function listAgents(deps?: AgentDeps): Promise<AgentSession[] | string>` (string = error text)
  - `export async function startAgent(kind: AgentKind, deps?: AgentDeps): Promise<{ status: number; body: { session?: AgentSession; error?: string } }>`
  - `export async function stopAgent(name: string, deps?: AgentDeps): Promise<{ status: number; body: { ok?: true; error?: string } }>`
  - Express handlers `getAgents`, `postAgent` (body `{ kind }`), `postStopAgent` (body `{ name }`), shaped like `tmux.ts` handlers.
  - Routes: `GET /api/agents/sessions`, `POST /api/agents/sessions`, `POST /api/agents/sessions/stop`.

Remote commands (each one `deps.run` call, names through `shq`):
- list: `tmux list-sessions -F '#{session_name}\t#{session_created}\t#{session_activity}\t#{@agent_link}' 2>/dev/null; true`, keep names matching `AGENT_NAME`; for agy rows also read `tail -c 65536 ~/.cache/pulse-agents/<name>.log` (one combined command is fine) and prefer its `findLink`. Afterwards delete `~/.cache/pulse-agents/*.log` whose name is not live.
- start: `mkdir -p ~/.cache/pulse-agents && tmux new-session -d -s <name> -c ~ <command>`; then loop until `deps.timeoutMs`: `tmux capture-pane -p -J -t =<name>` (agy: plus the log tail), send `trustKeys` once via `tmux send-keys -t =<name> <key>…`, stop at the first `findLink` hit and store it with `tmux set-option -t =<name> @agent_link <url>`; `deps.sleep(600)` between polls.
- stop: `tmux kill-session -t =<name>` plus `rm -f` of its log.

- [ ] **Step 1: Write the failing tests** using a fake `AgentDeps` that records every command and answers from a script (helper `fakeDeps(replies: Array<(cmd: string) => RunResult | undefined>)` in the test file; `sleep` resolves at once and advances a fake clock by its argument):
  - `startAgent('claude')` with a pane that shows the Claude trust screen once, then the session URL: returns 200 with `session.link === 'https://claude.ai/code/session_X1'`; the recorded commands contain exactly one `send-keys` with `Down` and `Enter`, and one `set-option` with `@agent_link`.
  - `startAgent('agy')` where the pane never shows a trust prompt: no recorded command contains `send-keys` (Review Focus 1).
  - `startAgent('agy')` that never finds a link: returns 200 with `session.link === null` after the fake clock passes 18 000 ms.
  - `startAgent('agy')` when list already has `agy-1`, `agy-2`, `agy-3`: status 409, body `{ error: '3 running: stop one first' }`, and no `new-session` command.
  - `startAgent('agy')` when `run` answers `{ code: -1, stderr: 'tmux is not installed' }`: status 503, body.error contains `tmux is not installed` (Review Focus 5).
  - `stopAgent('main')`: status 400, no command run. `stopAgent('agy-1905')` when `kill-session` exits 1: status 404 (Review Focus 4).
  - `listAgents` with tmux rows `agy-1905` and `main`, and one stale log `agy-1000.log`: returns only `agy-1905`; a recorded command removes `agy-1000.log` (Review Focus 4).
  - In `tmux.ts`: renaming `agy-1905` to `x`, or `main` to `cc-1`, answers 400 `{ error: 'agent sessions keep their name' }` (call `renameSession` with stub `req`/`res`, or test through a small exported `renameRefused(from: string, to: string): boolean` that the handler uses).
- [ ] **Step 2: Run, expect FAIL** — `npm test` → `startAgent is not a function`.
- [ ] **Step 3: Implement** the three functions, the handlers, the rename guard, and the routes in `index.ts` (`app.get('/api/agents/sessions', apiLimiter, requirePerm('terminal'), wrapAsync(getAgents))`, the two posts with `actionLimiter`). Start and stop call `recordAction({ target: 'agent', name, action: 'start' | 'stop', ok, message, durationMs, ts })`.
- [ ] **Step 4: Run, expect PASS** — `npm test`, `npm run typecheck`.
- [ ] **Step 5: Commit** — `git commit -m "feat(agents): start, list and stop agy and Claude Code sessions"`

### Task 3: Open an agent session in the terminal from outside it

**Files:**
- Modify: `src/components/terminal/TerminalWorkspace.tsx` (`WorkspaceProps` ~line 86, near `attachTmux` ~line 406), `src/App.tsx` (`Workspace` mount ~line 580)

**Interfaces:**
- Produces: `WorkspaceProps.attach?: { readonly tmux: string; readonly n: number }`. When `n` changes, the workspace calls its existing `attachTmux(tmux)` once.
- Produces in `App.tsx`: `const openTmux = (tmux: string) => { setAttach((a) => ({ tmux, n: (a?.n ?? 0) + 1 })); fetchTerminal(); setTerminal('open'); }`, passed to later tasks as `onOpenTerminal(name: string)`.

- [ ] **Step 1: Implement** the prop with a `useEffect` on `attach?.n`, and the `openTmux` callback.
- [ ] **Step 2: Verify** — `npm run typecheck`. The behaviour is checked in Task 4's manual run: "Open terminal" attaches the named session, and a second tap goes to the same window instead of opening a new one.
- [ ] **Step 3: Commit** — `git commit -m "feat(terminal): attach a tmux session from another view"`

### Task 4: Agent menu on the round button

**Files:**
- Create: `src/hooks/useAgents.ts`, `src/components/AgentMenu.tsx`
- Modify: `src/components/ChatFab.tsx` (its `onClick` opens the menu instead of the chat), `src/App.tsx` (~line 556: show when `canChat || canShell`), `src/styles.css` + `src/mobile.css` (menu card styles, or `tw:` utilities)

**Interfaces:**
- Consumes: `AgentSession`, `AgentKind`, `AGENT_LIMIT` (Task 1); routes (Task 2); `onOpenTerminal(name)` (Task 3); `postJson` from `src/lib/csrf.ts`; `usePolled` from `src/hooks/usePolled.ts`.
- Produces:
  - `export function useAgents(enabled: boolean): { sessions: readonly AgentSession[]; refresh(): void; start(kind: AgentKind): Promise<AgentSession | string>; stop(name: string): Promise<string | null> }` — `usePolled('/api/agents/sessions', 30_000, enabled)`; `start`/`stop` refresh after. Called once in `App.tsx`; its result goes to both the menu and the card (Task 5).
  - `AgentMenu` props: `{ open: boolean; onClose(): void; canChat: boolean; canShell: boolean; agents: ReturnType<typeof useAgents>; onOpenChat(): void; onOpenTerminal(name: string): void; onNotify(msg: string): void }`.

- [ ] **Step 1: Implement** the hook and the menu, using the `.pop` / `.pop-backdrop` markup of `src/components/MoreMenu.tsx` so phones get the bottom sheet from `src/lib/sheets.ts`. Copy fixed by the spec: "Chat OpenCode", "New agy session", "New Claude Code session", "Starting agy…" / "Starting Claude Code…", "Open in agy web ↗", "Open in Claude ↗", "Copy link", "Open terminal", "Stop", "started, no link yet", "3 running: stop one first" (disabled item when that kind has `AGENT_LIMIT` sessions). Links open with `target="_blank" rel="noopener"`. The button's busy ring and "!" badge keep showing the OpenCode chat state (`ChatSignal`), unchanged. Stop asks to confirm inline, like the tmux manager's kill.
- [ ] **Step 2: Verify** — `npm run typecheck`; `npm run build`; `sudo systemctl restart pulse`. On a phone-width browser (375 px): tap the button, start agy, see the link button within ~20 s, open it, copy it, Open terminal attaches `agy-HHMM`, Stop removes the card. Repeat for Claude Code (the session appears by its `cc-HHMM` name in the Claude app). A login without `terminal` sees only "Chat OpenCode".
- [ ] **Step 3: Commit** — `git commit -m "feat(ui): agent menu on the round button"`

### Task 5: Agents card on Overview

**Files:**
- Create: `src/components/AgentsCard.tsx`
- Modify: `src/App.tsx` (inside `shownView === 'overview'`, after `TelemetryGrid`, wrapped in `ErrorBoundary label="agents"`)

**Interfaces:**
- Consumes: `useAgents` result (Task 4), `chatSignal: ChatSignal` (`App.tsx` ~line 96), `data.services` (Hermes is the service with `id === 'hermes'`, `status.online`), `openChat`, a callback that opens the agent menu.
- Produces: `AgentsCard` props `{ canChat: boolean; canShell: boolean; chat: ChatSignal; agents: readonly AgentSession[]; hermesOnline: boolean | null; onOpenChat(): void; onOpenMenu(): void }`.

- [ ] **Step 1: Implement** rows per the spec: OpenCode "idle" / "working" / "waiting for your answer" (tap: chat; only with `canChat`); agy and Claude Code "N running" / "none" (tap: menu; with exactly one session its "Open ↗" link inline; only with `canShell`); Hermes "online" / "offline" (`hermesOnline === null` hides the row). Hide the card when no row remains.
- [ ] **Step 2: Verify** — `npm run typecheck`, `npm run build`, restart; on Overview at 375 px and desktop: counts match the menu, one-session row links directly, a viewer login sees no card.
- [ ] **Step 3: Commit** — `git commit -m "feat(ui): agents card on overview"`

### Task 6: Ship and record

**Files:**
- Modify: `~/vault/chat.md` (one "Agent launcher" bullet: routes, tmux prefixes `agy-`/`cc-`, limit 3, `@agent_link`, logs in `~/.cache/pulse-agents/`), `~/vault/INDEX.md` (`~tok` of chat.md), `~/vault/CHANGELOG.md` (row with date/time WIB and model name)

- [ ] **Step 1:** `npm test && npm run typecheck && npm run build && sudo systemctl restart pulse && curl -s http://127.0.0.1/api/health` → `{"status":"ok"}`.
- [ ] **Step 2:** Update the vault notes; keep chat.md under 3 KB.
- [ ] **Step 3:** `git push origin main` (only when the owner asks).
