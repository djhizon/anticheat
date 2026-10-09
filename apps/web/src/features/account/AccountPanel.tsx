import { useState, type FormEvent } from 'react';

import { messageForProblem } from '../auth/api.js';
import { useAuth } from '../auth/AuthProvider.js';

type Notice = { readonly kind: 'ok' | 'error'; readonly text: string } | null;

function NoticeLine({ notice }: { readonly notice: Notice }): React.ReactElement | null {
  if (notice === null) {
    return null;
  }
  return notice.kind === 'error' ? (
    <p aria-live="polite" className="auth-error" role="alert">
      <span aria-hidden="true">!</span>
      {notice.text}
    </p>
  ) : (
    <p aria-live="polite" className="auth-notice" role="status">
      {notice.text}
    </p>
  );
}

function ChangePasswordForm(): React.ReactElement {
  const { changePassword } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [notice, setNotice] = useState<Notice>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setNotice(null);
    if (newPassword !== confirmPassword) {
      setNotice({ kind: 'error', text: 'New passwords do not match.' });
      return;
    }
    setSubmitting(true);
    try {
      await changePassword({ currentPassword, newPassword });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setNotice({ kind: 'ok', text: 'Password updated.' });
    } catch (caught) {
      setNotice({
        kind: 'error',
        text: messageForProblem(caught, 'The password could not be changed. Try again.'),
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="auth-form account-form" onSubmit={(event) => void submit(event)}>
      <h3>Change password</h3>
      <label htmlFor="account-current-password">Current password</label>
      <input
        autoComplete="current-password"
        id="account-current-password"
        onChange={(event) => setCurrentPassword(event.target.value)}
        required
        type="password"
        value={currentPassword}
      />
      <label htmlFor="account-new-password">New password</label>
      <input
        autoComplete="new-password"
        id="account-new-password"
        onChange={(event) => setNewPassword(event.target.value)}
        required
        type="password"
        value={newPassword}
      />
      <label htmlFor="account-confirm-password">Confirm new password</label>
      <input
        autoComplete="new-password"
        id="account-confirm-password"
        onChange={(event) => setConfirmPassword(event.target.value)}
        required
        type="password"
        value={confirmPassword}
      />
      <NoticeLine notice={notice} />
      <button className="auth-submit" disabled={submitting} type="submit">
        {submitting ? 'Saving…' : 'Update password'}
      </button>
    </form>
  );
}

function ChangeEmailForm(): React.ReactElement {
  const { changeEmail } = useAuth();
  const [newEmail, setNewEmail] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [notice, setNotice] = useState<Notice>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setNotice(null);
    setSubmitting(true);
    try {
      await changeEmail({ newEmail, currentPassword });
      setCurrentPassword('');
      setNotice({
        kind: 'ok',
        text: 'Check your email to confirm the change. Your address updates after you open the link.',
      });
    } catch (caught) {
      setNotice({
        kind: 'error',
        text: messageForProblem(caught, 'The email could not be changed. Try again.'),
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="auth-form account-form" onSubmit={(event) => void submit(event)}>
      <h3>Change email</h3>
      <label htmlFor="account-new-email">New email address</label>
      <input
        autoComplete="email"
        id="account-new-email"
        onChange={(event) => setNewEmail(event.target.value)}
        required
        type="email"
        value={newEmail}
      />
      <label htmlFor="account-email-password">Current password</label>
      <input
        autoComplete="current-password"
        id="account-email-password"
        onChange={(event) => setCurrentPassword(event.target.value)}
        required
        type="password"
        value={currentPassword}
      />
      <NoticeLine notice={notice} />
      <button className="auth-submit" disabled={submitting} type="submit">
        {submitting ? 'Sending…' : 'Send confirmation'}
      </button>
    </form>
  );
}

export function AccountPanel({ onClose }: { readonly onClose: () => void }): React.ReactElement {
  const { user } = useAuth();
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        aria-labelledby="account-title"
        aria-modal="true"
        className="modal-card account-panel"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <h2 className="modal-title" id="account-title">
          Account
        </h2>
        <p className="modal-subtitle">{user?.email}</p>
        <ChangePasswordForm />
        {user?.authProvider === 'supabase' ? <ChangeEmailForm /> : null}
        <div className="modal-actions">
          <button className="secondary-button" onClick={onClose} type="button">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/** Top-bar button that opens the account panel. */
export function AccountButton(): React.ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="secondary-button" onClick={() => setOpen(true)} type="button">
        Account
      </button>
      {open ? <AccountPanel onClose={() => setOpen(false)} /> : null}
    </>
  );
}
