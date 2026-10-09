import { useEffect, useRef, useState, type FormEvent } from 'react';

import { messageForProblem, type ConfirmLinkType } from '../auth/api.js';
import { useAuth } from '../auth/AuthProvider.js';

const linkTypes: readonly ConfirmLinkType[] = [
  'email',
  'signup',
  'invite',
  'magiclink',
  'recovery',
  'email_change',
];

type ConfirmState =
  | { readonly kind: 'working' }
  | { readonly kind: 'reset' }
  | { readonly kind: 'done'; readonly text: string }
  | { readonly kind: 'error'; readonly text: string };

export function readConfirmParams(
  search: string,
): { readonly tokenHash: string; readonly type: ConfirmLinkType } | null {
  const params = new URLSearchParams(search);
  const tokenHash = params.get('token_hash');
  const type = linkTypes.find((candidate) => candidate === params.get('type'));
  return tokenHash === null || tokenHash === '' || type === undefined ? null : { tokenHash, type };
}

export interface ConfirmPageProps {
  readonly search: string;
  /** Leave the confirm route (replaces history so the one-time link is not reusable). */
  readonly onNavigate: (path: string) => void;
}

export function ConfirmPage({ search, onNavigate }: ConfirmPageProps): React.ReactElement {
  const { confirm, resetPassword } = useAuth();
  const [state, setState] = useState<ConfirmState>({ kind: 'working' });
  const started = useRef(false);

  useEffect(() => {
    // The link token is single-use: never POST it twice (StrictMode re-runs effects).
    if (started.current) {
      return;
    }
    started.current = true;

    const params = readConfirmParams(search);
    if (params === null) {
      setState({ kind: 'error', text: 'This link is incomplete. Request a new email.' });
      return;
    }

    confirm(params).then(
      (result) => {
        if (result.status === 'signed_in') {
          onNavigate('/');
        } else if (result.status === 'reset_required') {
          setState({ kind: 'reset' });
        } else if (result.status === 'email_changed') {
          setState({ kind: 'done', text: 'Your email address has been updated.' });
        } else {
          setState({
            kind: 'done',
            text: 'One more step: confirm the change from the link sent to your other address.',
          });
        }
      },
      (caught: unknown) =>
        setState({
          kind: 'error',
          text: messageForProblem(caught, 'This link could not be verified. Request a new email.'),
        }),
    );
  }, [confirm, onNavigate, search]);

  return (
    <main className="auth-loading confirm-page">
      <section aria-live="polite" className="auth-card">
        {state.kind === 'working' ? (
          <p aria-busy="true" role="status">
            Verifying your link…
          </p>
        ) : null}
        {state.kind === 'reset' ? (
          <ResetPasswordForm onDone={() => onNavigate('/')} onSubmit={resetPassword} />
        ) : null}
        {state.kind === 'done' ? (
          <>
            <p role="status">{state.text}</p>
            <button className="auth-submit" onClick={() => onNavigate('/')} type="button">
              Continue
            </button>
          </>
        ) : null}
        {state.kind === 'error' ? (
          <>
            <p className="auth-error" role="alert">
              <span aria-hidden="true">!</span>
              {state.text}
            </p>
            <button className="link-button" onClick={() => onNavigate('/')} type="button">
              Back to sign in
            </button>
          </>
        ) : null}
      </section>
    </main>
  );
}

function ResetPasswordForm({
  onSubmit,
  onDone,
}: {
  readonly onSubmit: (password: string) => Promise<void>;
  readonly onDone: () => void;
}): React.ReactElement {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit(password);
      onDone();
    } catch (caught) {
      setError(messageForProblem(caught, 'The password could not be changed. Try again.'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={(event) => void submit(event)}>
      <h2>Choose a new password</h2>
      <label htmlFor="reset-password">New password</label>
      <input
        autoComplete="new-password"
        id="reset-password"
        onChange={(event) => setPassword(event.target.value)}
        required
        type="password"
        value={password}
      />
      <label htmlFor="reset-confirm-password">Confirm new password</label>
      <input
        autoComplete="new-password"
        id="reset-confirm-password"
        onChange={(event) => setConfirmPassword(event.target.value)}
        required
        type="password"
        value={confirmPassword}
      />
      {error === null ? null : (
        <p className="auth-error" role="alert">
          <span aria-hidden="true">!</span>
          {error}
        </p>
      )}
      <button className="auth-submit" disabled={submitting} type="submit">
        {submitting ? 'Saving…' : 'Set new password'}
      </button>
    </form>
  );
}
