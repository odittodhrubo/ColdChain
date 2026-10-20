import { KeyRound } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthProvider';
import type { SessionResponse } from '../auth/session';
import { api, ApiError } from '../lib/api';
import { passwordProblem } from '../lib/password';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';

/**
 * Change your own password (S2). The server ends every other session of the account and returns a fresh one
 * for this tab, so the user stays signed in here.
 */
export function PasswordForm({
  onDone,
  submitLabel = 'Change password',
}: {
  onDone?: () => void;
  submitLabel?: string;
}) {
  const { update } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<{ current?: string; next?: string; confirm?: string; form?: string }>(
    {},
  );
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const found = {
      current: current ? undefined : 'Enter the password you signed in with',
      next:
        passwordProblem(next) ?? (next === current ? 'Choose a password you have not used here' : undefined),
      confirm: confirm === next ? undefined : 'The two new passwords do not match',
    };
    setErrors(found);
    if (found.current || found.next || found.confirm) return;
    setBusy(true);
    try {
      const res = await api<SessionResponse>('/api/auth/password', {
        method: 'POST',
        body: { current, next },
      });
      update(res);
      setCurrent('');
      setNext('');
      setConfirm('');
      onDone?.();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'INVALID_CURRENT_PASSWORD')
        setErrors({ current: 'This is not your current password' });
      else if (err instanceof ApiError && err.status === 400) setErrors({ next: err.message });
      else
        setErrors({ form: err instanceof Error ? err.message : 'The password was not changed. Try again.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="flex max-w-sm flex-col gap-4" aria-label="Change password">
      {errors.form && (
        <p
          role="alert"
          className="rounded-md border border-breach/40 bg-breach-wash px-3 py-2.5 text-sm font-medium text-breach"
        >
          {errors.form}
        </p>
      )}
      <Field
        label="Current password"
        type="password"
        autoComplete="current-password"
        value={current}
        onChange={(e) => setCurrent(e.target.value)}
        error={errors.current}
      />
      <Field
        label="New password"
        type="password"
        autoComplete="new-password"
        value={next}
        onChange={(e) => setNext(e.target.value)}
        error={errors.next}
        hint="10 or more characters, mixing three of: lowercase, uppercase, digits, symbols"
      />
      <Field
        label="Repeat the new password"
        type="password"
        autoComplete="new-password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        error={errors.confirm}
      />
      <p className="text-sm text-ink-2">
        You stay signed in here. Every other device that uses this account is signed out.
      </p>
      <Button
        type="submit"
        loading={busy}
        icon={<KeyRound aria-hidden className="size-4" />}
        className="self-start"
      >
        {submitLabel}
      </Button>
    </form>
  );
}
