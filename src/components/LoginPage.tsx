import { type CSSProperties, type FormEvent, type JSX, type KeyboardEvent, useRef, useState } from 'react';

interface LoginPageProps {
  readonly login: (username: string, password: string) => Promise<string | null>;
  /** True for a moment after a successful sign in: the button says "Signed in". */
  readonly leaving?: boolean;
  /** Fade the page out (browsers without View Transitions; otherwise the swap morphs). */
  readonly fadeOut?: boolean;
}

/** At most this many typing beats run along the trace at once. */
const MAX_BEATS = 5;

/** Stagger index for the entrance animation (see .login-rise in styles.css). */
const rise = (i: number): CSSProperties => ({ '--i': i }) as CSSProperties;

/** Full-page sign in. Shown instead of the dashboard until a session exists. */
export function LoginPage({ login, leaving = false, fadeOut = false }: LoginPageProps): JSX.Element {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [shake, setShake] = useState(false);
  // Text and visibility are separate so a dismissed error can collapse smoothly
  // instead of vanishing with its box.
  const [errorText, setErrorText] = useState('');
  const [errorOpen, setErrorOpen] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);
  // Every keystroke sends a heartbeat along the background trace.
  const [beats, setBeats] = useState<readonly number[]>([]);
  const beatId = useRef(0);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || leaving || !username || !password) return;
    setBusy(true);
    setErrorOpen(false);
    const err = await login(username.trim(), password);
    // On success the page is replaced, so only the failure path updates state.
    if (err) {
      setBusy(false);
      setErrorText(err);
      setErrorOpen(true);
      setPassword('');
      setShake(true);
      passwordRef.current?.focus();
    }
  };

  const trackCaps = (e: KeyboardEvent<HTMLInputElement>) => setCapsLock(e.getModifierState('CapsLock'));

  // Typing again dismisses the last error.
  const edit = (set: (v: string) => void, value: string) => {
    set(value);
    if (errorOpen) setErrorOpen(false);
    beatId.current += 1;
    const id = beatId.current;
    setBeats((list) => [...list, id].slice(-MAX_BEATS));
  };

  return (
    <main className={`login${fadeOut ? ' is-leaving' : ''}${errorOpen ? ' has-error' : ''}`}>
      <div className="login-bg" aria-hidden="true">
        <div className="login-grid" />
        <div className="login-glow" />
        <svg className="login-trace" viewBox="0 0 1200 200" preserveAspectRatio="none">
          <path className="login-trace-base" d={TRACE} />
          <path className="login-trace-pulse" d={TRACE} pathLength={1} />
          {beats.map((id) => (
            <path
              key={id}
              className="login-trace-beat"
              d={TRACE}
              pathLength={1}
              onAnimationEnd={() => setBeats((list) => list.filter((b) => b !== id))}
            />
          ))}
        </svg>
      </div>

      <div className="login-wrap">
        <form
          className={`login-card${shake ? ' is-shaking' : ''}`}
          onSubmit={(e) => void submit(e)}
          onAnimationEnd={(e) => {
            if (e.animationName === 'login-shake') setShake(false);
          }}
          noValidate
        >
          <header className="login-head login-rise" style={rise(0)}>
            <svg className="login-mark" viewBox="0 0 40 40" aria-hidden="true">
              <rect width="40" height="40" rx="11" fill="var(--logo-bg)" />
              <path
                className="login-mark-line"
                d="M6 22h9l4-12 6 20 4-8h8"
                pathLength={1}
                fill="none"
                stroke="var(--logo-fg)"
                strokeWidth="3.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <h1 className="login-title">Welcome back</h1>
            <p className="login-sub">
              Sign in to <strong>Pulse</strong> to watch and run your server.
            </p>
          </header>

          <div className="login-field login-rise" style={rise(1)}>
            <label htmlFor="login-user">Username</label>
            <div className="login-input">
              <UserGlyph />
              <input
                id="login-user"
                type="text"
                name="username"
                autoComplete="username"
                autoCapitalize="none"
                autoFocus
                spellCheck={false}
                enterKeyHint="next"
                disabled={leaving}
                value={username}
                onChange={(e) => edit(setUsername, e.target.value)}
              />
            </div>
          </div>

          <div className="login-field login-rise" style={rise(2)}>
            <label htmlFor="login-pass">Password</label>
            <div className="login-input">
              <LockGlyph />
              <input
                ref={passwordRef}
                id="login-pass"
                type={reveal ? 'text' : 'password'}
                name="password"
                autoComplete="current-password"
                enterKeyHint="go"
                disabled={leaving}
                value={password}
                onChange={(e) => edit(setPassword, e.target.value)}
                onKeyDown={trackCaps}
                onKeyUp={trackCaps}
                onBlur={() => setCapsLock(false)}
              />
              <button
                type="button"
                className="login-reveal"
                onClick={() => setReveal((r) => !r)}
                aria-label={reveal ? 'Hide password' : 'Show password'}
                aria-pressed={reveal}
                title={reveal ? 'Hide password' : 'Show password'}
              >
                {reveal ? <EyeOffGlyph /> : <EyeGlyph />}
              </button>
            </div>
            <div className={`login-collapse${capsLock ? ' is-open' : ''}`} aria-hidden={!capsLock}>
              <div>
                <p className="login-caps">Caps Lock is on</p>
              </div>
            </div>
          </div>

          <div className={`login-collapse${errorOpen ? ' is-open' : ''}`} aria-hidden={!errorOpen}>
            <div>
              <p className="login-error" role="alert">
                {errorText}
              </p>
            </div>
          </div>

          <button
            type="submit"
            className={`login-submit login-rise${busy ? ' is-busy' : ''}${leaving ? ' is-done' : ''}`}
            style={rise(3)}
            disabled={busy || leaving || !username || !password}
          >
            <span>{leaving ? 'Signed in' : busy ? 'Signing in' : 'Sign in'}</span>
            {leaving ? <CheckGlyph /> : busy ? <span className="login-spinner" aria-hidden="true" /> : <ArrowGlyph />}
          </button>
        </form>

        <p className="login-foot login-rise" style={rise(4)}>
          <LockGlyph size={12} />
          Private dashboard · {window.location.hostname}
        </p>
      </div>
    </main>
  );
}

/** Heartbeat across the page, the logo's shape. Beats sit left and right of the card so they stay visible. */
const TRACE =
  'M0 100 H200 L225 100 L245 50 L270 160 L292 76 L310 100 H880 L905 100 L925 50 L950 160 L972 76 L990 100 H1200';

const glyph = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
});

function UserGlyph(): JSX.Element {
  return (
    <svg {...glyph(16)}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </svg>
  );
}

function LockGlyph({ size = 16 }: { readonly size?: number }): JSX.Element {
  return (
    <svg {...glyph(size)}>
      <rect x="4" y="11" width="16" height="10" rx="2.5" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

function EyeGlyph(): JSX.Element {
  return (
    <svg {...glyph(16)}>
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffGlyph(): JSX.Element {
  return (
    <svg {...glyph(16)}>
      <path d="M10.6 5.1A10.8 10.8 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.1" />
      <path d="M6.6 6.6C3.7 8.4 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
      <line x1="2" y1="2" x2="22" y2="22" />
    </svg>
  );
}

function ArrowGlyph(): JSX.Element {
  return (
    <svg {...glyph(16)} className="login-submit-icon">
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="13 6 19 12 13 18" />
    </svg>
  );
}

function CheckGlyph(): JSX.Element {
  return (
    <svg {...glyph(16)} className="login-submit-icon">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
