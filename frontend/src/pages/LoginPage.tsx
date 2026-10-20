import { ArrowLeft, Eye, EyeOff, LogIn, ShieldCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { CodeField } from '../account/TwoFactor';
import { useAuth } from '../auth/AuthProvider';
import { Logo } from '../layout/Logo';
import { ApiError } from '../lib/api';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { StatusChip } from '../ui/StatusChip';
import { VvmMark } from '../ui/VvmMark';
import type { Status } from '../ui/status';

const LEGEND: { status: Status; text: string }[] = [
  { status: 'SAFE', text: 'Fridge in 2–8 °C, batch budget intact' },
  { status: 'WARNING', text: 'Near the edge, door open or on battery' },
  { status: 'BREACH', text: 'Fridge outside 2–8 °C' },
  { status: 'AT_RISK', text: 'Batch has under 20 % heat budget left' },
  { status: 'DISCARD', text: 'Budget spent or expired: never use' },
  { status: 'OFFLINE', text: 'No data from the fridge node' },
];

// The vial monitor read at label size: the inner square darkens from fresh to spent.
const SPECIMEN: { status: Status; used: number; caption: string }[] = [
  { status: 'SAFE', used: 0, caption: 'Fresh' },
  { status: 'WARNING', used: 0.45, caption: 'In use' },
  { status: 'AT_RISK', used: 0.82, caption: 'At risk' },
  { status: 'DISCARD', used: 1, caption: 'Discard' },
];

function message(err: unknown): string {
  if (!(err instanceof ApiError)) return 'Sign-in failed. Try again.';
  if (err.status === 0) return "Can't reach the ColdChain server. Check that the backend is running.";
  if (err.code === 'INVALID_CREDENTIALS') return 'Email or password is not correct.';
  if (err.code === 'INVALID_CODE')
    return 'That code is not right or was already used. Wait for the next one.';
  return err.message; // locked / rate limited: the server says when to retry
}

export function LoginPage() {
  const { user, login, mfaPending, verifyMfa, cancelMfa } = useAuth();
  const navigate = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from ?? '/';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState<string | null>(null); // null: use the app's code

  if (user) return <Navigate to={from} replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if ((await login(email.trim(), password)) === 'signed-in') navigate(from, { replace: true });
      else {
        setPassword(''); // the second step holds only a short-lived MFA token, never the password
        setBusy(false);
      }
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  }

  async function submitCode(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await verifyMfa(recovery !== null ? { recoveryCode: recovery.trim() } : { code });
      navigate(from, { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'TOKEN_EXPIRED') {
        cancelMfa();
        setError('Sign-in timed out after 5 minutes. Enter your password again.');
      } else setError(message(err));
      setCode('');
      setBusy(false);
    }
  }

  const back = () => {
    cancelMfa();
    setError(null);
    setCode('');
    setRecovery(null);
  };

  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,0.82fr)_minmax(0,1fr)]">
      <section className="hidden flex-col justify-between border-r border-rule bg-panel-2 px-10 py-10 lg:flex">
        <Logo />
        <div className="max-w-md">
          <p className="text-[1.9rem] leading-tight font-bold tracking-[-0.02em] text-ink text-balance">
            Every vial's heat budget, every second, for every fridge.
          </p>
          <p className="mt-3 text-ink-2">
            ColdChain reads each fridge every 5 seconds and keeps a 60-minute heat budget per batch. Status
            reads like a vial monitor label: the square darkens as the budget is used.
          </p>
          <figure className="mt-8" aria-label="A vial monitor mark darkening as the heat budget is used">
            <ol className="flex items-end gap-6">
              {SPECIMEN.map((m) => (
                <li key={m.caption} className="flex flex-col items-center gap-2">
                  <VvmMark status={m.status} used={m.used} size={56} />
                  <span className="text-xs font-semibold text-ink-2">{m.caption}</span>
                </li>
              ))}
            </ol>
          </figure>
          <ul className="mt-8 flex flex-col gap-3" aria-label="How to read status">
            {LEGEND.map((l) => (
              <li key={l.status} className="flex items-center gap-3">
                <StatusChip status={l.status} size="sm" className="w-24 justify-center" />
                <span className="text-sm text-ink-2">{l.text}</span>
              </li>
            ))}
          </ul>
        </div>
        <p className="text-xs text-ink-3">Vaccines and insulin stay effective only between 2 and 8 °C.</p>
      </section>

      {/* top-anchored, so an error message grows the card downward instead of moving it */}
      <section className="flex items-start justify-center px-4 pt-12 pb-10 lg:pt-[22vh]">
        {mfaPending ? (
          <form
            onSubmit={submitCode}
            noValidate
            aria-labelledby="login-title"
            className="w-full max-w-md rounded-[var(--radius-label)] border border-rule bg-panel p-7 shadow-[0_1px_2px_rgb(15_27_42/0.05)] sm:p-10"
          >
            <div className="mb-6 lg:hidden">
              <Logo />
            </div>
            <h1 id="login-title" className="text-xl font-bold text-ink">
              Two-factor sign-in
            </h1>
            <p className="mt-1 text-sm text-ink-2">
              {recovery !== null
                ? 'Enter one of the recovery codes you saved. Each works once.'
                : `Enter the 6-digit code from the authenticator app for ${email.trim()}.`}
            </p>
            {error && (
              <p
                role="alert"
                className="mt-5 rounded-md border border-breach/40 bg-breach-wash px-3 py-2.5 text-sm font-medium text-breach"
              >
                {error}
              </p>
            )}
            <div className="mt-5">
              {recovery !== null ? (
                <Field
                  label="Recovery code"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="abcd-efgh-jkmn"
                  value={recovery}
                  onChange={(e) => setRecovery(e.target.value)}
                />
              ) : (
                <CodeField label="Code" value={code} onChange={setCode} />
              )}
            </div>
            <Button
              type="submit"
              loading={busy}
              disabled={recovery !== null ? !recovery.trim() : code.length !== 6}
              icon={<ShieldCheck aria-hidden className="size-4" />}
              className="mt-6 w-full"
            >
              {busy ? 'Checking' : 'Verify and sign in'}
            </Button>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
              <Button variant="ghost" icon={<ArrowLeft aria-hidden className="size-4" />} onClick={back}>
                Back
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setRecovery((r) => (r === null ? '' : null));
                  setError(null);
                }}
              >
                {recovery !== null ? 'Use the app code' : 'Use a recovery code'}
              </Button>
            </div>
          </form>
        ) : (
          <form
            onSubmit={submit}
            noValidate
            aria-labelledby="login-title"
            className="w-full max-w-md rounded-[var(--radius-label)] border border-rule bg-panel p-7 shadow-[0_1px_2px_rgb(15_27_42/0.05)] sm:p-10"
          >
            <div className="mb-6 lg:hidden">
              <Logo />
            </div>
            <h1 id="login-title" className="text-xl font-bold text-ink">
              Sign in
            </h1>
            <p className="mt-1 text-sm text-ink-2">Use your ColdChain staff account.</p>

            {error && (
              <p
                role="alert"
                className="mt-5 rounded-md border border-breach/40 bg-breach-wash px-3 py-2.5 text-sm font-medium text-breach"
              >
                {error}
              </p>
            )}

            <div className="mt-5 flex flex-col gap-4">
              <Field
                label="Email"
                type="email"
                name="email"
                autoComplete="username"
                inputMode="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <Field
                label="Password"
                type={show ? 'text' : 'password'}
                name="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                trailing={
                  <button
                    type="button"
                    onClick={() => setShow((s) => !s)}
                    aria-label={show ? 'Hide password' : 'Show password'}
                    aria-pressed={show}
                    className="mr-1 grid size-9 cursor-pointer place-items-center rounded-md text-ink-2 hover:bg-panel-2 hover:text-ink"
                  >
                    {show ? (
                      <EyeOff aria-hidden className="size-4" />
                    ) : (
                      <Eye aria-hidden className="size-4" />
                    )}
                  </button>
                }
              />
            </div>
            <Button
              type="submit"
              loading={busy}
              disabled={!email || !password}
              icon={<LogIn aria-hidden className="size-4" />}
              className="mt-6 w-full"
            >
              {busy ? 'Signing in' : 'Sign in'}
            </Button>
          </form>
        )}
      </section>
    </div>
  );
}
