import { type JSX, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { SERVICES, isHiddenContainer, type HistorySample } from './shared/contract';
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
import { ContainerHistory } from './components/ContainerHistory';
import { DeepTelemetry } from './components/DeepTelemetry';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Freshness, isStale, StaleBanner } from './components/Freshness';
import { FilesystemPanel } from './components/FilesystemPanel';
import { LatencyHistory } from './components/LatencyHistory';
import { LogPanel } from './components/LogPanel';
import { Navbar } from './components/Navbar';
import { PulseHero } from './components/PulseHero';
import { ServiceLamps } from './components/ServiceLamps';
import { ProcessHistory } from './components/ProcessHistory';
import { ReachabilityPanel } from './components/ReachabilityPanel';
import { ResourceTrends } from './components/ResourceTrends';
import { ServicesGrid } from './components/ServicesGrid';
import { ConfirmDialog } from './components/ConfirmDialog';
import { GoHint } from './components/GoHint';
import { Loading, SkeletonCard } from './components/Skeleton';
import { Rail, Sidebar } from './components/Sidebar';
import { VIEWS } from './lib/views';
import { SpendPanel } from './components/SpendPanel';
import { TelemetryGrid } from './components/TelemetryGrid';
import { ActionsPanel } from './components/ActionsPanel';

type TerminalModule = typeof import('./components/TerminalWorkspace');
const loadTerminal = (): Promise<TerminalModule> => import('./components/TerminalWorkspace');

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
  // Re-read every poll interval so a hung request (no error, no data) still turns stale.
  const now = useNow(5000);
  const stale = isStale(data !== null, error, lastOkAt, now);
  const { history, range, setRange, maxSpanMs, loading: historyLoading, pendingRange } = useHistory();

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [hostMode, setHostMode] = useState<HostMode>(readStoredHostMode);
  // The workspace mounts on first open and is then only hidden, so shells survive.
  const [terminal, setTerminal] = useState<'never' | 'open' | 'hidden'>('never');
  const [toast, setToast] = useState<ToastState>({ text: '', id: 0 });
  // Logging out asks first (top-bar button and the palette command).
  const [askLogout, setAskLogout] = useState(false);
  const requestLogout = useCallback(() => setAskLogout(true), []);

  const notify = useCallback((text: string) => setToast((t) => ({ text, id: t.id + 1 })), []);

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
  useEffect(() => {
    const w = window as Window & { requestIdleCallback?: (cb: () => void) => number };
    if (w.requestIdleCallback) w.requestIdleCallback(fetchTerminal);
    else window.setTimeout(fetchTerminal, 1500);
  }, [fetchTerminal]);
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
      if (e.ctrlKey && !e.altKey && !e.metaKey && e.code === 'Backquote') {
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

      const hit = SERVICES.find((s) => s.keyNumber === e.key);
      if (hit) {
        e.preventDefault();
        window.open(buildServiceUrl(hit, hostMode), '_blank', 'noopener,noreferrer');
        notify(`Opening ${hit.name}`);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [hostMode, notify, paletteOpen, toggleSidebar, armGo, disarmGo]);

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

  const latencyServices = useMemo(() => SERVICES.map((s) => ({ id: s.id, label: s.name })), []);

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
            {view === 'overview' && (
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

            {view === 'applications' && (
              <Section title="Applications" hint="launch, status and latency">
                <ServicesGrid data={data} hostMode={hostMode} onNotify={notify} />
              </Section>
            )}

            {view === 'trends' && (
              <Section title="Trends" hint="last window, drag to pan and zoom">
                <ResourceTrends
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

            {!system && view in VIEW_SKELETONS && (
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

            {view === 'hardware' && system && (
              <Section title="Hardware" hint="cores, memory, network and disks">
                <DeepTelemetry system={system} samples={samples} />
              </Section>
            )}

            {view === 'workload' && system && (
              <Section title="Workload" hint="what is running and how much it uses">
                <div className="grid">
                  <div className="span-7">
                    <ProcessHistory processes={system.processes} samples={samples} />
                  </div>
                  <div className="span-5">
                    <ContainerHistory containers={system.docker.filter((c) => !isHiddenContainer(c.name))} samples={samples} />
                  </div>
                </div>
              </Section>
            )}

            {view === 'capacity' && system && (
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
                    <LatencyHistory samples={samples} services={latencyServices} />
                  </div>
                </div>
              </Section>
            )}

            {view === 'reach-and-spend' && (
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

            {view === 'logs-and-control' && (
              <Section title="Logs and control" hint="actions ask for confirmation first">
                <div className="grid">
                  <div className="span-7">
                    <LogPanel />
                  </div>
                  <div className="span-5">
                    <ActionsPanel
                      systemdTargets={(data?.services ?? []).map((svc) => ({ id: svc.id, running: svc.status.online }))}
                      dockerTargets={(system?.docker ?? [])
                        .filter((c) => !isHiddenContainer(c.name))
                        .map((c) => ({ id: c.id, name: c.name, running: c.state === 'running' }))}
                    />
                  </div>
                </div>
              </Section>
            )}

          </div>

          <footer className="footer">
            <Freshness lastOkAt={lastOkAt} stale={stale} />
            <div className="footer-keys">
              {SERVICES.map((s) => (
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
              <span>
                <kbd>Ctrl `</kbd> terminal
              </span>
            </div>
          </footer>
        </main>
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        data={data}
        hostMode={hostMode}
        theme={theme}
        onToggleTheme={toggleTheme}
        onRefresh={refresh}
        onNotify={notify}
        onOpenTerminal={() => setTerminal('open')}
        onLogout={requestLogout}
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
