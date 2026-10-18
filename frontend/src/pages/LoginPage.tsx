import { Eye, EyeOff, LogIn } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
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
  return err.message; // locked / rate limited: the server says when to retry
}

export function LoginPage() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from ?? '/';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (user) return <Navigate to={from} replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(email.trim(), password);
      navigate(from, { replace: true });
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <section className="hidden flex-col justify-between border-r border-rule bg-panel-2 px-12 py-10 lg:flex">
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
        <form
          onSubmit={submit}
          noValidate
          aria-labelledby="login-title"
          className="w-full max-w-sm rounded-[var(--radius-label)] border border-rule bg-panel p-6 shadow-[0_1px_2px_rgb(15_27_42/0.05)] sm:p-8"
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
                  {show ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}
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
      </section>
    </div>
  );
}
