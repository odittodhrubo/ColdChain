import { Lock } from 'lucide-react';
import { Link } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { ROLE_LABEL } from '../auth/permissions';

export function NoPermissionPage() {
  const { user } = useAuth();
  return (
    <div className="mx-auto flex max-w-md flex-col items-start gap-3 py-16">
      <Lock aria-hidden className="size-7 text-ink-3" />
      <h1 className="text-xl font-bold text-ink">This page isn't available to your role</h1>
      <p className="text-ink-2">
        You're signed in as {user ? ROLE_LABEL[user.role] : 'a user'}, which can't open it. Ask an
        administrator if you need access.
      </p>
      <Link to="/" className="font-semibold text-teal-strong underline">
        Back to the dashboard
      </Link>
    </div>
  );
}

export function NotFoundPage() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-start gap-3 py-16">
      <h1 className="text-xl font-bold text-ink">Page not found</h1>
      <p className="text-ink-2">The address doesn't match any ColdChain page.</p>
      <Link to="/" className="font-semibold text-teal-strong underline">
        Back to the dashboard
      </Link>
    </div>
  );
}
