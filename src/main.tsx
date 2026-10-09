import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { LoginPage } from './components/LoginPage';
import { type AuthState, useAuth } from './hooks/useAuth';
import { useInstall } from './hooks/useInstall';
import { canTransition, prefersReducedMotion, transition } from './lib/motion';
import { installPointerEffects } from './lib/pointer';
// Self-hosted fonts, latin subset only: no third-party request, and they work offline.
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-400-italic.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import '@fontsource/jetbrains-mono/latin-700.css';
import './styles.css';
import './motion.css';

/** Matches the .login.is-leaving fade in styles.css (browsers without View Transitions). */
const LEAVE_MS = 420;
/** How long "Signed in" shows before the logo flies to the top bar (View Transitions). */
const SIGNED_IN_MS = 380;

/**
 * True for a moment after a sign in, so the login page can say "Signed in"
 * and animate out before the dashboard mounts. Derived during render: an
 * effect would let the dashboard flash for one frame first.
 *
 * With View Transitions the swap itself is the animation: the login logo
 * morphs into the top-bar logo. Without them the login page fades out.
 */
function useLeaving(status: AuthState['status']): { leaving: boolean; morph: boolean } {
  const [leaving, setLeaving] = useState(false);
  const [morph] = useState(canTransition);
  const [prev, setPrev] = useState(status);
  if (status !== prev) {
    setPrev(status);
    if (prev === 'anon' && status === 'authed' && !prefersReducedMotion()) setLeaving(true);
  }

  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(
      () => (morph ? transition('login', () => setLeaving(false)) : setLeaving(false)),
      morph ? SIGNED_IN_MS : LEAVE_MS,
    );
    return () => clearTimeout(t);
  }, [leaving, morph]);

  return { leaving, morph };
}

/** The dashboard only mounts once logged in, so nothing polls the API while signed out. */
function Root() {
  const { state, login, logout } = useAuth();
  const install = useInstall();
  const { leaving, morph } = useLeaving(state.status);
  if (state.status === 'loading') return null;
  if (state.status === 'anon' || leaving) return <LoginPage login={login} leaving={leaving} fadeOut={leaving && !morph} />;
  return <App user={state.user} onLogout={() => void logout()} install={install} />;
}

installPointerEffects();

const container = document.getElementById('root');
if (!container) throw new Error('#root missing from index.html');

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary label="the dashboard" page>
      <Root />
    </ErrorBoundary>
  </StrictMode>,
);

// Installable app: the service worker only exists in secure contexts (HTTPS or localhost).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}
