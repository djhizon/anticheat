import { useState, type FormEvent } from 'react';

import { useAuth } from './AuthProvider.js';

type AuthMode = 'signin' | 'signup';

const demoEmail = 'demo.student@example.test';
const demoPassword = 'Demo exam password 2026!';

export function LoginPage(): React.ReactElement {
  const { loading, login, register, user } = useAuth();
  const [mode, setMode] = useState<AuthMode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (loading) {
    return (
      <main className="auth-loading" aria-busy="true">
        <div className="loading-orb" aria-hidden="true" />
        <p role="status">Checking your session…</p>
      </main>
    );
  }

  if (user !== null) {
    return (
      <main className="auth-loading">
        <p role="status">Signed in as {user.email}.</p>
      </main>
    );
  }

  const isSignUp = mode === 'signup';

  function changeMode(nextMode: AuthMode): void {
    setMode(nextMode);
    setError(null);
    setConfirmPassword('');
  }

  function useDemoAccount(): void {
    setMode('signin');
    setEmail(demoEmail);
    setPassword(demoPassword);
    setConfirmPassword('');
    setError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    if (isSignUp && password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setSubmitting(true);
    try {
      if (isSignUp) {
        await register({ email, password });
      } else {
        await login({ email, password });
      }
    } catch {
      setError(
        isSignUp
          ? 'Account creation was not completed. Check your details and try again.'
          : 'Sign-in was not completed. Check your details and try again.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-intro" aria-labelledby="auth-intro-title">
        <div className="brand-mark" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <p className="auth-kicker">Pack 8 Active</p>
        <h1 id="auth-intro-title">Fair, Transparent Exams</h1>
        <p className="auth-intro-copy">
          On-device AI checks your camera, audio and typing during the exam. You see every monitor
          before you start and everything recorded after you finish.
        </p>
        <div className="auth-promise" role="note">
          <span className="promise-icon" aria-hidden="true">
            🛡️
          </span>
          <span>
            <strong>Consent first.</strong>
            <small>Every signal is a lead for a human to review, never an automatic verdict.</small>
          </span>
        </div>
      </section>

      <section className="auth-card" aria-labelledby="auth-form-title">
        <div className="auth-card-header">
          <p className="eyebrow">Student portal</p>
          <h2 id="auth-form-title">{isSignUp ? 'Create your account' : 'Welcome back'}</h2>
          <p className="muted">
            {isSignUp
              ? 'Create an account to access assigned exams.'
              : 'Sign in to continue to your exam workspace.'}
          </p>
        </div>

        <div className="auth-tabs" role="tablist" aria-label="Account access">
          <button
            aria-selected={!isSignUp}
            className={!isSignUp ? 'auth-tab active' : 'auth-tab'}
            onClick={() => changeMode('signin')}
            role="tab"
            type="button"
          >
            Sign in
          </button>
          <button
            aria-selected={isSignUp}
            className={isSignUp ? 'auth-tab active' : 'auth-tab'}
            onClick={() => changeMode('signup')}
            role="tab"
            type="button"
          >
            Sign up
          </button>
        </div>

        <form className="auth-form" onSubmit={(event) => void handleSubmit(event)}>
          <label htmlFor="auth-email">Email address</label>
          <input
            autoComplete="email"
            id="auth-email"
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
            required
            type="email"
            value={email}
          />

          <div className="form-label-row">
            <label htmlFor="auth-password">Password</label>
            {isSignUp ? <span>8+ characters recommended</span> : null}
          </div>
          <input
            aria-describedby={isSignUp ? 'password-hint' : undefined}
            autoComplete={isSignUp ? 'new-password' : 'current-password'}
            id="auth-password"
            onChange={(event) => setPassword(event.target.value)}
            required
            type="password"
            value={password}
          />
          {isSignUp ? (
            <p className="field-hint" id="password-hint">
              Use a password you do not reuse for another service.
            </p>
          ) : null}

          {isSignUp ? (
            <>
              <label htmlFor="auth-confirm-password">Confirm password</label>
              <input
                autoComplete="new-password"
                id="auth-confirm-password"
                onChange={(event) => setConfirmPassword(event.target.value)}
                required
                type="password"
                value={confirmPassword}
              />
            </>
          ) : null}

          {error === null ? null : (
            <p aria-live="polite" className="auth-error" role="alert">
              <span aria-hidden="true">!</span>
              {error}
            </p>
          )}
          <button className="auth-submit" disabled={loading || submitting} type="submit">
            {submitting
              ? isSignUp
                ? 'Creating account…'
                : 'Signing in…'
              : isSignUp
                ? 'Create account'
                : 'Sign in'}
            <span aria-hidden="true">→</span>
          </button>
        </form>

        {!isSignUp ? (
          <div className="demo-callout">
            <div>
              <strong>Trying the local demo?</strong>
              <span>Use the seeded student account.</span>
            </div>
            <button className="link-button" onClick={useDemoAccount} type="button">
              Fill demo login
            </button>
          </div>
        ) : (
          <p className="auth-switch-copy">
            Already have an account?{' '}
            <button className="link-button" onClick={() => changeMode('signin')} type="button">
              Sign in instead
            </button>
          </p>
        )}
      </section>
    </main>
  );
}
