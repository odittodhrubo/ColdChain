import { LogOut } from 'lucide-react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { PasswordForm } from '../account/PasswordForm';
import { TwoFactor } from '../account/TwoFactor';
import { useAuth } from '../auth/AuthProvider';
import { Logo } from '../layout/Logo';
import { Button } from '../ui/Button';

/**
 * Before anything else works (the server answers 403 to every other call): choose your own password when
 * someone else set it (S2), or set up two-factor sign-in where Admins must have it (S3).
 */
export function AccountGatePage() {
  const { user, mustChangePassword, mfaSetupRequired, logout } = useAuth();
  const navigate = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from ?? '/';
  if (!user) return <Navigate to="/login" replace />;
  if (!mustChangePassword && !mfaSetupRequired) return <Navigate to={from} replace />;

  const step = mustChangePassword ? 'password' : 'mfa';
  return (
    <div className="flex min-h-dvh items-start justify-center bg-ground px-4 pt-12 pb-10 lg:pt-[16vh]">
      <section
        aria-labelledby="gate-title"
        className="w-full max-w-lg rounded-[var(--radius-label)] border border-rule bg-panel p-6 shadow-[0_1px_2px_rgb(15_27_42/0.05)] sm:p-8"
      >
        <div className="mb-6 flex items-center justify-between gap-3">
          <Logo />
          <Button
            variant="ghost"
            icon={<LogOut aria-hidden className="size-4" />}
            onClick={() => logout('manual')}
          >
            Sign out
          </Button>
        </div>
        <h1 id="gate-title" className="text-xl font-bold text-ink">
          {step === 'password' ? 'Choose your own password' : 'Set up two-factor sign-in'}
        </h1>
        <p className="mt-1 mb-6 text-sm text-ink-2">
          {step === 'password'
            ? `Signed in as ${user.email}. This password was set for you by someone else, so pick one only you know before you continue.`
            : `Signed in as ${user.email}. Admins on this system sign in with a password and a code from their phone.`}
        </p>
        {step === 'password' ? (
          <PasswordForm submitLabel="Save and continue" />
        ) : (
          <TwoFactor required onEnabled={() => navigate(from, { replace: true })} />
        )}
      </section>
    </div>
  );
}
