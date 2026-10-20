import { type JSX, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { can, isHiddenContainer, UNIT_SERVICES, type HistorySample, type Service } from './shared/contract';
import { useNow } from './hooks/useNow';
import { useStats } from './hooks/useStats';
import { useHistory } from './hooks/useHistory';
import { useTheme } from './hooks/useTheme';
import { useAlerts } from './hooks/useAlerts';
import { useSidebar } from './hooks/useSidebar';
import { useView } from './hooks/useView';
import type { AuthUser } from './hooks/useAuth';
import type { InstallHandle } from './hooks/useInstall';
import { buildServiceUrl, readStoredHostMode, storeHostMode, type HostMode } from './lib/urls';
import { CommandPalette, Toast } from './components/CommandPalette';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Freshness, isStale, StaleBanner } from './components/Freshness';
import { FilesPanel } from './components/FilesPanel';
import { UsersPanel } from './components/UsersPanel';
import { FilesystemPanel } from './components/FilesystemPanel';
import { LogPanel } from './components/LogPanel';
import { Navbar } from './components/Navbar';
import { PulseHero } from './components/PulseHero';
import { ServiceLamps } from './components/ServiceLamps';
import { ReachabilityPanel } from './components/ReachabilityPanel';
import { ServicesGrid } from './components/ServicesGrid';
import { ConfirmDialog } from './components/ConfirmDialog';
import { GoHint } from './components/GoHint';
import { Loading, SkeletonCard } from './components/Skeleton';
import { Rail, Sidebar } from './components/Sidebar';
import { TabBar } from './components/TabBar';
import { ChatFab, type ChatSignal } from './components/ChatFab';
import { VIEWS } from './lib/views';
import { SpendPanel } from './components/SpendPanel';
import { TelemetryGrid } from './components/TelemetryGrid';
import { ActionsPanel } from './components/ActionsPanel';
import { PerformancePanel } from './components/PerformancePanel';

type TerminalModule = typeof import('./components/TerminalWorkspace');
const loadTerminal = (): Promise<TerminalModule> => import('./components/TerminalWorkspace');
type ChartsModule = typeof import('./components/ChartViews');
const loadCharts = (): Promise<ChartsModule> => import('./components/ChartViews');
type ChatModule = typeof import('./components/chat/ChatView');
const loadChat = (): Promise<ChatModule> => import('./components/chat/ChatView');
/** Views drawn with TimeChart; they wait on the chart chunk. */
const CHART_VIEWS: ReadonlySet<string> = new Set(['trends', 'hardware', 'workload', 'capacity']);

interface ToastState {
  readonly text: string;
  /** Changes on every message, so the same text can show again. */
  readonly id: number;
}

const NO_SAMPLES: readonly HistorySample[] = [];

/** How long G waits for the view letter. */
const GO_WINDOW_MS = 1500;

interface AppProps {
  readonly user: AuthUser;
  readonly onLogout: () => void;
  readonly install: InstallHandle;
}

export default function App({ user, onLogout, install }: AppProps): JSX.Element {
  const { theme, toggleTheme } = useTheme();
  const { data, error, refresh, lastOkAt } = useStats();
  // The number-key handler reads the latest list without re-binding on every poll.
  const servicesRef = useRef<readonly Service[]>([]);
  servicesRef.current = data?.services ?? [];
  // Re-read every poll interval so a hung request (no error, no data) still turns stale.
  const now = useNow(5000);
  const stale = isStale(data !== null, error, lastOkAt, now);
  const { history, range, setRange, maxSpanMs, loading: historyLoading, pendingRange } = useHistory();

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [hostMode, setHostMode] = useState<HostMode>(readStoredHostMode);
  // The workspace mounts on first open and is then only hidden, so shells survive.
  const [terminal, setTerminal] = useState<'never' | 'open' | 'hidden'>('never');
  const [toast, setToast] = useState<ToastState>({ text: '', id: 0 });
  // Logging out asks first. The profile menu (top right) is the only way in.
  const [askLogout, setAskLogout] = useState(false);
  const requestLogout = useCallback(() => setAskLogout(true), []);

  const notify = useCallback((text: string) => setToast((t) => ({ text, id: t.id + 1 })), []);
  // The server enforces these too; hiding the controls only saves a 403.
  const canAct = can(user, 'services:control');
  const canShell = can(user, 'terminal');
  const canLogs = can(user, 'view:logs');
  const canChat = can(user, 'chat');

  // Like the terminal, the chat mounts on first open and is then only hidden:
  // its stream keeps following the agent, and the floating button shows when
  // it works or waits for an answer.
  const [chatState, setChatState] = useState<'never' | 'open' | 'hidden'>('never');
  const [chatSignal, setChatSignal] = useState<ChatSignal>({ busy: false, asking: false });
  const chatOpenRef = useRef(false);
  chatOpenRef.current = chatState === 'open';

  // "G then letter" jumps to a view (letters in lib/views.ts). G arms it for
  // GO_WINDOW_MS; the ref drives the key handler, the state shows the hint, and
  // html[data-go] lights up the letters in the sidebar.
  const [goArmed, setGoArmed] = useState(false);
  const goRef = useRef(false);
  const goTimer = useRef(0);
  const disarmGo = useCallback(() => {
    window.clearTimeout(goTimer.current);
    goRef.current = false;
    setGoArmed(false);
    delete document.documentElement.dataset.go;
  }, []);
  const armGo = useCallback(() => {
    window.clearTimeout(goTimer.current);
    goRef.current = true;
    setGoArmed(true);
    document.documentElement.dataset.go = '1';
    goTimer.current = window.setTimeout(disarmGo, GO_WINDOW_MS);
  }, [disarmGo]);
  const alerts = useAlerts(notify);
  const view = useView();
  // A view this login may not open (an old bookmark, or none allowed) renders nothing but a notice.
  const shownView = VIEWS.some((v) => v.id === view) ? view : null;
  const { sidebarOpen, toggleSidebar } = useSidebar();

  // The terminal is its own chunk, fetched while idle and then held as a plain
  // component. Not React.lazy: Suspense can hold a reveal back ~300ms, and the
  // first keys typed after opening would land on the dashboard instead.
  const [Workspace, setWorkspace] = useState<TerminalModule['TerminalWorkspace'] | null>(null);
  const fetchTerminal = useCallback(() => {
    void loadTerminal()
      .then((m) => setWorkspace(() => m.TerminalWorkspace))
      .catch(() => undefined);
  }, []);
  // Same for the chart views (uPlot): the overview never needs them.
  const [Charts, setCharts] = useState<ChartsModule | null>(null);
  const fetchCharts = useCallback(() => {
    void loadCharts()
      .then((m) => setCharts(m))
      .catch(() => undefined);
  }, []);
  // The chat is its own chunk too: fetched on intent (hover or a finger on its button) or when opened.
  const [Chat, setChat] = useState<ChatModule['ChatView'] | null>(null);
  const fetchChat = useCallback(() => {
    void loadChat()
      .then((m) => setChat(() => m.ChatView))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    if (chatState !== 'never' && !Chat) fetchChat();
  }, [chatState, Chat, fetchChat]);

  // Opening the chat adds a history entry, so the phone's back button minimizes
  // it instead of leaving Pulse. Minimize goes back through that entry.
  const openChat = useCallback(() => {
    setPaletteOpen(false);
    setChatState('open');
    if (!(window.history.state as { pulseChat?: boolean } | null)?.pulseChat) window.history.pushState({ pulseChat: true }, '');
  }, []);
  const minimizeChat = useCallback(() => {
    if ((window.history.state as { pulseChat?: boolean } | null)?.pulseChat) window.history.back();
    else setChatState((st) => (st === 'open' ? 'hidden' : st));
  }, []);
  useEffect(() => {
    // A reload keeps the entry's flag but not the open chat.
    if ((window.history.state as { pulseChat?: boolean } | null)?.pulseChat) window.history.replaceState(null, '');
    const onPop = () => {
      const inChat = !!(window.history.state as { pulseChat?: boolean } | null)?.pulseChat;
      setChatState((st) => (inChat ? (st === 'never' ? st : 'open') : st === 'open' ? 'hidden' : st));
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  // #chat (the chat used to be a view) opens it over the first view: on load and when typed in.
  useEffect(() => {
    if (!canChat) return undefined;
    const check = () => {
      if (window.location.hash !== '#chat') return;
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${VIEWS[0]?.id ?? 'overview'}`);
      openChat();
    };
    check();
    window.addEventListener('hashchange', check);
    return () => window.removeEventListener('hashchange', check);
  }, [canChat, openChat]);
  const onChatSignal = useCallback((next: ChatSignal) => {
    setChatSignal((prev) => (prev.busy === next.busy && prev.asking === next.asking ? prev : next));
  }, []);
  // The agent stops to ask while the chat is minimized: say so once.
  const askedRef = useRef(false);
  useEffect(() => {
    if (chatSignal.asking && !askedRef.current && chatState === 'hidden') notify('OpenCode is waiting for your answer in Chat');
    askedRef.current = chatSignal.asking;
  }, [chatSignal.asking, chatState, notify]);
  useEffect(() => {
    // The terminal chunk is the biggest one (xterm, ~170 KB gzipped). Touch
    // devices and Save-Data connections fetch it on intent instead: a finger
    // on the Terminal tab (TabBar onWarmTerminal) or opening it.
    const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
    const eager = !window.matchMedia('(pointer: coarse)').matches && !conn?.saveData;
    const fetchIdle = () => {
      fetchCharts();
      if (eager) fetchTerminal();
    };
    const w = window as Window & { requestIdleCallback?: (cb: () => void) => number };
    if (w.requestIdleCallback) w.requestIdleCallback(fetchIdle);
    else window.setTimeout(fetchIdle, 1500);
  }, [fetchCharts, fetchTerminal]);
  // Landed on (or jumped to) a chart view before the idle fetch finished: fetch now.
  useEffect(() => {
    if (CHART_VIEWS.has(view) && !Charts) fetchCharts();
  }, [view, Charts, fetchCharts]);
  // Opened before the idle fetch finished: fetch now.
  useEffect(() => {
    if (terminal !== 'never' && !Workspace) fetchTerminal();
  }, [terminal, Workspace, fetchTerminal]);

  const handleHostModeChange = useCallback(
    (mode: HostMode) => {
      setHostMode(mode);
      storeHostMode(mode);
      notify(`Links now point at ${mode === 'auto' ? window.location.hostname : mode}`);
    },
    [notify],
  );

  // Keyboard: Ctrl/Cmd+K toggles the palette, "/" opens it, "[" hides or shows
  // the sidebar, G then a letter opens a view, 1-5 open a service. Typing in a
  // field or an open menu never triggers a shortcut.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // Keystrokes inside the terminal belong to the shell (Ctrl+K, "/", "[" ...).
      if (target instanceof Element && target.closest('.tw')) return;
      // The open chat covers the dashboard: its shortcuts would act unseen.
      if (chatOpenRef.current) return;
      // An open confirmation owns the keyboard.
      if (target instanceof Element && target.closest('.confirm-root')) return;
      const typing = Boolean(target && (['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName) || target.closest('.pop')));

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      // Ctrl+` (the VS Code terminal key) brings the terminal back, or opens it.
      // By key position, so it works on any layout. Not Cmd: on macOS Cmd+`
      // switches windows.
      if (canShell && e.ctrlKey && !e.altKey && !e.metaKey && e.code === 'Backquote') {
        e.preventDefault();
        setPaletteOpen(false);
        setTerminal('open');
        return;
      }
      if (typing || paletteOpen) return;

      const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
      if (goRef.current && plain) {
        const next = VIEWS.find((v) => v.key === e.key.toLowerCase());
        disarmGo();
        if (next) {
          e.preventDefault();
          window.location.hash = next.id;
        }
        // G then I opens the chat (not a view any more, but the letter stays).
        if (!next && canChat && e.key.toLowerCase() === 'i') {
          e.preventDefault();
          openChat();
          return;
        }
        // Escape just cancels; any other key goes on to its usual meaning.
        if (next || e.key === 'Escape') return;
      }
      if (plain && !e.shiftKey && e.key.toLowerCase() === 'g') {
        e.preventDefault();
        armGo();
        return;
      }

      if (e.key === '/') {
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }

      if (e.key === '[' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        toggleSidebar();
        return;
      }

      const hit = servicesRef.current.find((s) => s.keyNumber !== '' && s.keyNumber === e.key);
      if (hit) {
        e.preventDefault();
        window.open(buildServiceUrl(hit, hostMode), '_blank', 'noopener,noreferrer');
        notify(`Opening ${hit.name}`);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [hostMode, notify, paletteOpen, toggleSidebar, armGo, disarmGo, canShell, canChat, openChat]);

  const samples = history?.samples ?? NO_SAMPLES;
  const system = data?.system ?? null;
  const offline = data?.services.filter((s) => !s.status.online).length ?? 0;
  const degraded = system?.degraded ?? [];

  const status = useMemo(() => {
    if (error && !data) return { tone: 'is-crit', text: 'Backend unreachable' };
    if (!data) return { tone: '', text: 'Connecting…' };
    if (stale) return { tone: 'is-crit', text: 'Connection lost' };
    if (offline > 0) return { tone: 'is-warn', text: `${offline} service${offline === 1 ? '' : 's'} offline` };
    // A firing alert outranks "operational": the services answer, but the host
    // is in a state a rule says needs attention.
    const firing = alerts.firing;
    if (firing.length > 0) {
      const critical = firing.some((e) => e.severity === 'critical');
      const first = firing[0];
      const text = firing.length === 1 && first ? first.message : `${firing.length} alerts firing`;
      return { tone: critical ? 'is-crit' : 'is-warn', text };
    }
    if (degraded.length > 0) return { tone: 'is-warn', text: `Partial data: ${degraded.join(', ')}` };
    return { tone: 'is-ok', text: 'All systems operational' };
  }, [data, error, stale, offline, degraded, alerts.firing]);

  // Keyed on the id/name list, so a poll with the same services keeps the chart's input stable.
  const serviceKey = (data?.services ?? []).map((s) => `${s.id}\u0000${s.name}`).join('\u0001');
  const latencyServices = useMemo(
    () => (data?.services ?? []).map((s) => ({ id: s.id, label: s.name })),
    [serviceKey],
  );

  return (
    <>
      <Navbar
        theme={theme}
        onToggleTheme={toggleTheme}
        onOpenPalette={() => setPaletteOpen(true)}
        hostMode={hostMode}
        onHostModeChange={handleHostModeChange}
        onNotify={notify}
        alerts={alerts}
        user={user}
        onLogout={requestLogout}
        onOpenTerminal={canShell ? () => setTerminal('open') : undefined}
        onWarmTerminal={canShell && !Workspace ? fetchTerminal : undefined}
        terminalRunning={terminal === 'hidden'}
        active={view}
      />

      <div className={`shell${sidebarOpen ? '' : ' is-collapsed'}`}>
        {sidebarOpen ? (
          <Sidebar active={view} onToggle={toggleSidebar} />
        ) : (
          <Rail active={view} onExpand={toggleSidebar} />
        )}

        <main className={`page${stale ? ' is-stale' : ''}`}>
          {stale && <StaleBanner lastOkAt={lastOkAt} error={error} onRetry={refresh} />}

          {/* data-view picks this view's entrance choreography in motion.css. */}
          <div key={view} className="view" data-view={view}>
            {shownView === null && (
              <Section title="No access" hint="ask an admin">
                <p className="empty">Your account cannot open {VIEWS.length === 0 ? 'any page yet' : 'this page'}. An admin can grant it in Users.</p>
              </Section>
            )}
            {shownView === 'overview' && (
              <>
                <ErrorBoundary label="the status hero">
                  <PulseHero
                    tone={status.tone === 'is-crit' ? 'is-crit' : status.tone === 'is-warn' ? 'is-warn' : ''}
                    statusText={status.text}
                    system={system}
                    samples={samples}
                  />
                </ErrorBoundary>

                <ErrorBoundary label="telemetry">
                  <TelemetryGrid system={system} samples={samples} />
                </ErrorBoundary>

                <Section title="Services" hint="click to open">
                  <ServiceLamps data={data} hostMode={hostMode} onNotify={notify} />
                </Section>
              </>
            )}

            {shownView === 'applications' && (
              <Section title="Applications" hint="launch, status and latency">
                <ServicesGrid data={data} hostMode={hostMode} onNotify={notify} onRefresh={refresh} canEdit={canAct} />
              </Section>
            )}

            {shownView === 'trends' && Charts && (
              <Section title="Trends" hint="CPU, memory and disk over time">
                <Charts.ResourceTrends
                  samples={samples}
                  range={range}
                  onRangeChange={setRange}
                  maxSpanMs={maxSpanMs}
                  ready={!historyLoading}
                  persisted={history?.storage?.persisted}
                  persistError={history?.storage?.error}
                  pending={pendingRange}
                />
              </Section>
            )}

            {/* Trends needs only the chart chunk; the rest also wait for the first stats. */}
            {((!Charts && CHART_VIEWS.has(view)) || (!system && view !== 'trends')) && view in VIEW_SKELETONS && (
              <Section title={VIEW_SKELETONS[view]!.title} hint={VIEW_SKELETONS[view]!.hint}>
                <Loading what={VIEW_SKELETONS[view]!.title}>
                  <div className="grid">
                    {VIEW_SKELETONS[view]!.cards.map((c, i) => (
                      <div key={i} className={c.span}>
                        <SkeletonCard {...(c.rows ? { rows: c.rows } : { chart: c.chart ?? 160 })} />
                      </div>
                    ))}
                  </div>
                </Loading>
              </Section>
            )}

            {shownView === 'hardware' && system && Charts && (
              <Section title="Hardware" hint="cores, memory, network and disks">
                <Charts.DeepTelemetry system={system} samples={samples} />
              </Section>
            )}

            {shownView === 'workload' && system && Charts && (
              <Section title="Workload" hint="what is running and how much it uses">
                <div className="grid">
                  <div className="span-7">
                    <Charts.ProcessHistory processes={system.processes} samples={samples} canAct={canAct} onNotify={notify} onRefresh={refresh} />
                  </div>
                  <div className="span-5">
                    <Charts.ContainerHistory containers={system.docker.filter((c) => !isHiddenContainer(c.name))} samples={samples} />
                  </div>
                </div>
              </Section>
            )}

            {shownView === 'capacity' && system && Charts && (
              <Section title="Capacity" hint="what could run out">
                <div className="grid">
                  <div className="span-5">
                    <FilesystemPanel
                      filesystems={system.filesystems}
                      rootMount={system.disk.mount}
                      rootInodePercent={system.disk.inodePercent}
                    />
                  </div>
                  <div className="span-7">
                    <Charts.LatencyHistory samples={samples} services={latencyServices} />
                  </div>
                </div>
              </Section>
            )}

            {shownView === 'reach-and-spend' && (
              <Section title="Reach and spend" hint="is this box reachable, and what does it cost">
                <div className="grid">
                  <div className="span-6">
                    <ReachabilityPanel />
                  </div>
                  <div className="span-6">
                    <SpendPanel />
                  </div>
                </div>
              </Section>
            )}

            {shownView === 'logs-and-control' && (
              <Section title={canLogs ? (canAct ? 'Logs and control' : 'Logs') : 'Service control'} hint={canAct ? 'actions ask for confirmation first' : 'read-only for your account'}>
                <div className="grid">
                  {canLogs && (
                    <div className={canAct ? 'span-7' : 'span-12'}>
                      <LogPanel />
                    </div>
                  )}
                  {canAct && (
                  <div className={canLogs ? 'span-5' : 'span-12'}>
                    <ActionsPanel
                      systemdTargets={(data?.services ?? [])
                        .filter((svc) => UNIT_SERVICES.has(svc.id))
                        .map((svc) => ({ id: svc.id, running: svc.status.online }))}
                      dockerTargets={(system?.docker ?? [])
                        .filter((c) => !isHiddenContainer(c.name))
                        .map((c) => ({ id: c.id, name: c.name, running: c.state === 'running' }))}
                    />
                  </div>
                  )}
                </div>
                {canAct && <PerformancePanel onNotify={notify} />}
              </Section>
            )}

            {shownView === 'files' && (
              <Section title="Files" hint="browse, preview, upload and download">
                <FilesPanel onNotify={notify} canWrite={can(user, 'files:write')} />
              </Section>
            )}

            {shownView === 'users' && (
              <Section title="Users" hint="accounts, roles and what each may access">
                <UsersPanel me={user} onNotify={notify} />
              </Section>
            )}
          </div>

          <footer className="footer">
            <Freshness lastOkAt={lastOkAt} stale={stale} />
            <div className="footer-keys">
              {(data?.services ?? []).filter((s) => s.keyNumber).map((s) => (
                <span key={s.id}>
                  <kbd>{s.keyNumber}</kbd> {s.name.split(' ')[0]}
                </span>
              ))}
              <span>
                <kbd>[</kbd> sidebar
              </span>
              <span>
                <kbd>G</kbd> + letter: go to view
              </span>
              <span>
                <kbd>Ctrl K</kbd> commands
              </span>
              {canShell && (
                <span>
                  <kbd>Ctrl `</kbd> terminal
                </span>
              )}
            </div>
          </footer>
        </main>
      </div>

      {/* Phones and tablets: bottom navigation (hidden at desktop sizes). */}
      <TabBar active={view} terminalRunning={terminal === 'hidden'} />

      {/* Hidden only once the chat is really there, so a tap never shows nothing. */}
      {canChat && <ChatFab signal={chatSignal} hidden={chatState === 'open' && !!Chat} onOpen={openChat} onWarm={Chat ? undefined : fetchChat} />}

      {canChat && chatState !== 'never' && Chat && (
        <ErrorBoundary label="the chat">
          <Chat open={chatState === 'open'} onMinimize={minimizeChat} onNotify={notify} onSignal={onChatSignal} />
        </ErrorBoundary>
      )}

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        data={data}
        hostMode={hostMode}
        theme={theme}
        onToggleTheme={toggleTheme}
        onRefresh={refresh}
        onNotify={notify}
        onOpenTerminal={canShell ? () => setTerminal('open') : undefined}
        onOpenChat={canChat ? openChat : undefined}
        onInstall={install.canInstall ? install.install : undefined}
      />

      {terminal !== 'never' && Workspace && (
        <ErrorBoundary label="the terminal">
          <Workspace
            open={terminal === 'open'}
            onHide={() => setTerminal('hidden')}
            onEmpty={() => setTerminal('never')}
          />
        </ErrorBoundary>
      )}

      {terminal === 'hidden' && (
        <button
          type="button"
          className="tw-resume"
          onClick={() => setTerminal('open')}
          aria-keyshortcuts="Control+`"
          title="Continue session (Ctrl+`)"
        >
          <span className="tw-resume-dot" aria-hidden="true" />
          Continue session
          <kbd className="tw-resume-kbd">Ctrl `</kbd>
        </button>
      )}

      {goArmed && <GoHint />}

      <ConfirmDialog
        open={askLogout}
        icon="logout"
        title="Log out of Pulse?"
        message="You will need your username and password to sign in again."
        confirmLabel="Log out"
        onCancel={() => setAskLogout(false)}
        onConfirm={() => {
          setAskLogout(false);
          onLogout();
        }}
      />

      <Toast key={toast.id} message={toast.text} />
    </>
  );
}

/** Placeholder layouts for the views that need the first stats reading before they can render. */
const VIEW_SKELETONS: Partial<
  Record<string, { title: string; hint: string; cards: { span: string; rows?: number; chart?: number }[] }>
> = {
  trends: {
    title: 'Trends',
    hint: 'CPU, memory and disk over time',
    cards: [{ span: 'span-12', chart: 330 }],
  },
  hardware: {
    title: 'Hardware',
    hint: 'cores, memory, network and disks',
    cards: [
      { span: 'span-6', chart: 180 },
      { span: 'span-6', chart: 180 },
      { span: 'span-6', rows: 4 },
      { span: 'span-6', rows: 4 },
    ],
  },
  workload: {
    title: 'Workload',
    hint: 'what is running and how much it uses',
    cards: [
      { span: 'span-7', rows: 7 },
      { span: 'span-5', rows: 5 },
    ],
  },
  capacity: {
    title: 'Capacity',
    hint: 'what could run out',
    cards: [
      { span: 'span-5', rows: 5 },
      { span: 'span-7', chart: 220 },
    ],
  },
};

function Section({ title, hint, children }: { readonly title: string; readonly hint: string; readonly children: ReactNode }): JSX.Element {
  return (
    <section className="section" aria-label={title}>
      <div className="section-head">
        <h2 className="section-title">{title}</h2>
        <span className="section-hint">{hint}</span>
      </div>
      <ErrorBoundary label={title}>{children}</ErrorBoundary>
    </section>
  );
}
