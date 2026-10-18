import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, UserPlus, Users } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { ROLE_LABEL, ROLES, type Role } from '../auth/permissions';
import { PageHeader } from '../layout/AppShell';
import { api, ApiError } from '../lib/api';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { Modal } from '../ui/Modal';
import { Panel } from '../ui/Panel';
import { Select } from '../ui/Select';
import { EmptyState, ErrorState, Skeleton } from '../ui/States';
import { useToast } from '../ui/Toast';

interface User {
  id: number;
  email: string;
  name: string;
  role: Role;
  active: boolean;
  created_at: number;
}
type Patch = Partial<Pick<User, 'name' | 'role' | 'active'>> & { password?: string };

/** Same rule as the server (backend/src/auth/password.ts): 10–72 characters, three of four classes. */
export function passwordProblem(pw: string): string | null {
  if (pw.length < 10) return 'At least 10 characters';
  if (pw.length > 72) return 'At most 72 characters';
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z\d]/].filter((r) => r.test(pw)).length;
  return classes >= 3 ? null : 'Mix at least three of: lowercase, uppercase, digits, symbols';
}

const message = (e: unknown) =>
  e instanceof ApiError && e.code === 'LAST_ADMIN'
    ? 'This is the last active admin. Make someone else an admin first.'
    : e instanceof Error
      ? e.message
      : 'Something went wrong';

function useUpdateUser() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: Patch }) =>
      api<{ user: User }>(`/api/users/${id}`, { method: 'PATCH', body: patch }),
    onSuccess: ({ user }, { patch }) =>
      toast({
        tone: 'success',
        title: patch.password
          ? `Password reset for ${user.name}`
          : patch.active === false
            ? `${user.name} disabled`
            : `${user.name} updated`,
      }),
    onError: (e) => toast({ tone: 'error', title: 'Change refused', body: message(e) }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['users'] }), // a refused role change snaps back
  });
}

function CreateUser({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [v, setV] = useState({ email: '', name: '', role: 'PHARMACIST' as Role, password: '' });
  const [errors, setErrors] = useState<Partial<Record<keyof typeof v, string>>>({});
  const create = useMutation({
    mutationFn: () =>
      api<{ user: User }>('/api/users', {
        method: 'POST',
        body: { ...v, email: v.email.trim(), name: v.name.trim() },
      }),
    onSuccess: ({ user }) => {
      toast({ tone: 'success', title: `${user.name} can now sign in` });
      void qc.invalidateQueries({ queryKey: ['users'] });
      onClose();
    },
  });
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) =>
    setV((x) => ({ ...x, [k]: e.target.value }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const found: typeof errors = {};
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email.trim())) found.email = 'Enter a valid email address';
    if (!v.name.trim()) found.name = 'Enter the person’s name';
    const pw = passwordProblem(v.password);
    if (pw) found.password = pw;
    setErrors(found);
    if (Object.keys(found).length === 0) create.mutate();
  };
  const err = create.error instanceof ApiError ? create.error : null;
  return (
    <Modal
      open
      onClose={onClose}
      title="Add user"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="user-form" loading={create.isPending}>
            Add user
          </Button>
        </>
      }
    >
      <form id="user-form" onSubmit={submit} noValidate className="grid gap-4">
        {err && (
          <p
            role="alert"
            className="rounded-md border border-breach/40 bg-breach-wash px-3 py-2 text-sm font-medium text-breach"
          >
            {err.code === 'EMAIL_TAKEN' ? 'A user with this email already exists.' : err.message}
          </p>
        )}
        <Field label="Name" value={v.name} onChange={set('name')} error={errors.name} autoComplete="off" />
        <Field
          label="Email"
          type="email"
          value={v.email}
          onChange={set('email')}
          error={errors.email}
          autoComplete="off"
        />
        <Select label="Role" value={v.role} onChange={set('role')}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </Select>
        <Field
          label="Initial password"
          type="password"
          value={v.password}
          onChange={set('password')}
          error={errors.password}
          hint="10+ characters, mixing three of: lowercase, uppercase, digits, symbols"
          autoComplete="new-password"
        />
      </form>
    </Modal>
  );
}

function ResetPassword({ user, onClose }: { user: User; onClose: () => void }) {
  const update = useUpdateUser();
  const [pw, setPw] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const problem = passwordProblem(pw);
    setError(problem);
    if (!problem) update.mutate({ id: user.id, patch: { password: pw } }, { onSuccess: onClose });
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={`Reset password for ${user.name}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={update.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="pw-form" loading={update.isPending}>
            Set password
          </Button>
        </>
      }
    >
      <form id="pw-form" onSubmit={submit} noValidate>
        <Field
          label="New password"
          type="password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          error={error}
          hint="Tell them in person; they keep it until it is reset again."
          autoComplete="new-password"
        />
      </form>
    </Modal>
  );
}

export function UsersPage() {
  const { user: me } = useAuth();
  const users = useQuery({
    queryKey: ['users'],
    queryFn: ({ signal }) => api<{ users: User[] }>('/api/users', { signal }),
  });
  const update = useUpdateUser();
  const [dialog, setDialog] = useState<
    { kind: 'create' } | { kind: 'password' | 'disable'; user: User } | null
  >(null);
  const close = () => setDialog(null);

  return (
    <>
      <PageHeader
        title="Users"
        subtitle="Who can sign in, and what their role allows"
        actions={
          <Button
            icon={<UserPlus aria-hidden className="size-4" />}
            onClick={() => setDialog({ kind: 'create' })}
          >
            Add user
          </Button>
        }
      />
      <Panel bodyClassName="">
        {users.isPending ? (
          <div className="flex flex-col gap-2 p-4">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : users.error ? (
          <div className="px-4">
            <ErrorState error={users.error} onRetry={() => void users.refetch()} />
          </div>
        ) : users.data.users.length === 0 ? (
          <EmptyState icon={<Users aria-hidden className="size-6" />} title="No users" />
        ) : (
          <div className="relative overflow-x-auto">
            <table className="figures w-full min-w-[48rem] border-collapse text-left text-sm">
              <caption className="sr-only">User accounts</caption>
              <thead className="bg-panel-2">
                <tr>
                  {['User', 'Role', 'Status', 'Added'].map((h) => (
                    <th
                      key={h}
                      scope="col"
                      className="border-b border-rule px-4 py-2.5 text-xs font-semibold tracking-wide text-ink-2 uppercase"
                    >
                      {h}
                    </th>
                  ))}
                  <th scope="col" className="border-b border-rule px-4 py-2.5">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {users.data.users.map((u) => (
                  <tr
                    key={u.id}
                    className={`border-b border-rule last:border-b-0 ${u.active ? '' : 'text-ink-3'}`}
                  >
                    <td className="px-4 py-2.5">
                      <span className={`block font-semibold ${u.active ? 'text-ink' : 'text-ink-3'}`}>
                        {u.name}
                        {u.id === me?.id && (
                          <span className="ml-2 text-xs font-medium text-ink-3">(you)</span>
                        )}
                      </span>
                      <span className="block text-xs text-ink-2">{u.email}</span>
                    </td>
                    <td className="px-4 py-2.5">
                      <Select
                        label={`Role of ${u.name}`}
                        hideLabel
                        value={u.role}
                        disabled={!u.active || update.isPending}
                        onChange={(e) => update.mutate({ id: u.id, patch: { role: e.target.value as Role } })}
                        className="w-40"
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABEL[r]}
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td
                      className="px-4 py-2.5 text-xs font-bold tracking-wide"
                      style={{ color: u.active ? 'var(--safe)' : 'var(--offline)' }}
                    >
                      {u.active ? 'ACTIVE' : 'DISABLED'}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap text-ink-2">
                      {new Date(u.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          className="min-h-9 px-2.5"
                          icon={<KeyRound aria-hidden className="size-4" />}
                          disabled={!u.active}
                          onClick={() => setDialog({ kind: 'password', user: u })}
                          aria-label={`Reset password for ${u.name}`}
                        >
                          Reset password
                        </Button>
                        {u.active ? (
                          <Button
                            variant="secondary"
                            className="min-h-9 px-2.5"
                            onClick={() => setDialog({ kind: 'disable', user: u })}
                            aria-label={`Disable ${u.name}`}
                          >
                            Disable
                          </Button>
                        ) : (
                          <Button
                            variant="secondary"
                            className="min-h-9 px-2.5"
                            loading={update.isPending && update.variables?.id === u.id}
                            onClick={() => update.mutate({ id: u.id, patch: { active: true } })}
                            aria-label={`Enable ${u.name}`}
                          >
                            Enable
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      {dialog?.kind === 'create' && <CreateUser onClose={close} />}
      {dialog?.kind === 'password' && <ResetPassword user={dialog.user} onClose={close} />}
      {dialog?.kind === 'disable' && (
        <Modal
          open
          onClose={close}
          title={`Disable ${dialog.user.name}?`}
          footer={
            <>
              <Button variant="secondary" onClick={close} disabled={update.isPending}>
                Cancel
              </Button>
              <Button
                variant="danger"
                loading={update.isPending}
                onClick={() =>
                  update.mutate({ id: dialog.user.id, patch: { active: false } }, { onSettled: close })
                }
              >
                Disable user
              </Button>
            </>
          }
        >
          <p className="text-sm text-ink">
            {dialog.user.email} can no longer sign in, and any session they have open ends. Their past actions
            stay in the audit log. You can enable the account again later.
          </p>
        </Modal>
      )}
    </>
  );
}
