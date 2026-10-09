import { useState, type FormEvent } from 'react';

import { messageForProblem } from './api.js';
import { useAuth } from './AuthProvider.js';

type AuthMode = 'signin' | 'signup' | 'forgot';

const demoEmail = 'demo.student@example.test';
const demoPassword = 'Demo exam password 2026!';

export function LoginPage(): React.ReactElement {
  const { forgotPassword, loading, login, register, user } = useAuth();
  const [mode, setMode] = useState<AuthMode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

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
  const isForgot = mode === 'forgot';

  function changeMode(nextMode: AuthMode): void {
    setMode(nextMode);
    setError(null);
    setNotice(null);
    setConfirmPassword('');
  }

  function useDemoAccount(): void {
    setMode('signin');
    setEmail(demoEmail);
    setPassword(demoPassword);
    setConfirmPassword('');
    setError(null);
    setNotice(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setNotice(null);
    if (isSignUp && password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setSubmitting(true);
    try {
      if (isForgot) {
        await forgotPassword(email);
        setNotice('If an account exists for that email, a password reset link is on its way.');
      } else if (isSignUp) {
        const result = await register({ email, password });
        if ('status' in result) {
          setNotice(
            'Check your email to confirm your account. Open the link we sent, then sign in.',
          );
          setPassword('');
          setConfirmPassword('');
          setMode('signin');
        }
      } else {
        await login({ email, password });
      }
    } catch (caught) {
      setError(
        messageForProblem(
          caught,
          isForgot
            ? 'The reset email could not be requested. Try again.'
            : isSignUp
              ? 'Account creation was not completed. Check your details and try again.'
              : 'Sign-in was not completed. Check your details and try again.',
        ),
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
          <h2 id="auth-form-title">
            {isForgot ? 'Reset your password' : isSignUp ? 'Create your account' : 'Welcome back'}
          </h2>
          <p className="muted">
            {isForgot
              ? 'Enter your email and we will send you a reset link.'
              : isSignUp
                ? 'Create an account to access assigned exams.'
                : 'Sign in to continue to your exam workspace.'}
          </p>
        </div>

        {isForgot ? null : (
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
        )}

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

          {isForgot ? null : (
            <>
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
            </>
          )}

          {notice === null ? null : (
            <p aria-live="polite" className="auth-notice" role="status">
              {notice}
            </p>
          )}
          {error === null ? null : (
            <p aria-live="polite" className="auth-error" role="alert">
              <span aria-hidden="true">!</span>
              {error}
            </p>
          )}
          <button className="auth-submit" disabled={loading || submitting} type="submit">
            {submitting
              ? isForgot
                ? 'Sending…'
                : isSignUp
                  ? 'Creating account…'
                  : 'Signing in…'
              : isForgot
                ? 'Send reset link'
                : isSignUp
                  ? 'Create account'
                  : 'Sign in'}
            <span aria-hidden="true">→</span>
          </button>
        </form>

        {isForgot ? (
          <p className="auth-switch-copy">
            Remembered it?{' '}
            <button className="link-button" onClick={() => changeMode('signin')} type="button">
              Back to sign in
            </button>
          </p>
        ) : !isSignUp ? (
          <>
            <p className="auth-switch-copy auth-forgot">
              <button className="link-button" onClick={() => changeMode('forgot')} type="button">
                Forgot password?
              </button>
            </p>
            <div className="demo-callout">
              <div>
                <strong>Trying the local demo?</strong>
                <span>Use the seeded student account.</span>
              </div>
              <button className="link-button" onClick={useDemoAccount} type="button">
                Fill demo login
              </button>
            </div>
          </>
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
