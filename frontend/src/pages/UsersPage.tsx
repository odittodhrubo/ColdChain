import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, KeyRound, Monitor, ShieldCheck, ShieldOff, UserPlus, Users } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { ROLE_LABEL, ROLES, type Role } from '../auth/permissions';
import { fmt, useT, type StringKey } from '../i18n';
import { PageHeader } from '../layout/AppShell';
import { api, ApiError } from '../lib/api';
import { passwordProblem } from '../lib/password';
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
  totp_enabled: boolean;
  created_at: number;
}
type Patch = Partial<Pick<User, 'name' | 'role' | 'active'>> & { password?: string; totp_reset?: true };

export { passwordProblem } from '../lib/password';

const message = (e: unknown, t: (k: StringKey) => string) =>
  e instanceof ApiError && e.code === 'LAST_ADMIN'
    ? t('usr.lastAdmin')
    : e instanceof Error
      ? e.message
      : t('usr.somethingWrong');

function useUpdateUser() {
  const { t } = useT();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: Patch }) =>
      api<{ user: User }>(`/api/users/${id}`, { method: 'PATCH', body: patch }),
    onSuccess: ({ user }, { patch }) =>
      toast({
        tone: 'success',
        title: fmt(
          patch.password
            ? t('usr.pwResetToast')
            : patch.totp_reset
              ? t('usr.totpResetToast')
              : patch.active === false
                ? t('usr.disabledToast')
                : t('usr.updatedToast'),
          { n: user.name },
        ),
      }),
    onError: (e) => toast({ tone: 'error', title: t('usr.changeRefused'), body: message(e, t) }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['users'] }), // a refused role change snaps back
  });
}

function CreateUser({ onClose }: { onClose: () => void }) {
  const { t } = useT();
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
      toast({ tone: 'success', title: fmt(t('usr.canSignIn'), { n: user.name }) });
      void qc.invalidateQueries({ queryKey: ['users'] });
      onClose();
    },
  });
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) =>
    setV((x) => ({ ...x, [k]: e.target.value }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const found: typeof errors = {};
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email.trim())) found.email = t('usr.validEmail');
    if (!v.name.trim()) found.name = t('usr.enterName');
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
      title={t('usr.addUser')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={create.isPending}>
            {t('usr.cancel')}
          </Button>
          <Button type="submit" form="user-form" loading={create.isPending}>
            {t('usr.addUser')}
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
            {err.code === 'EMAIL_TAKEN' ? t('usr.emailTaken') : err.message}
          </p>
        )}
        <Field label={t('usr.name')} value={v.name} onChange={set('name')} error={errors.name} autoComplete="off" />
        <Field
          label={t('usr.email')}
          type="email"
          value={v.email}
          onChange={set('email')}
          error={errors.email}
          autoComplete="off"
        />
        <Select label={t('usr.role')} value={v.role} onChange={set('role')}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </Select>
        <Field
          label={t('usr.initialPw')}
          type="password"
          value={v.password}
          onChange={set('password')}
          error={errors.password}
          hint={t('usr.initialPwHint')}
          autoComplete="new-password"
        />
      </form>
    </Modal>
  );
}

function ResetPassword({ user, onClose }: { user: User; onClose: () => void }) {
  const { t } = useT();
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
      title={fmt(t('usr.resetPwTitle'), { n: user.name })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={update.isPending}>
            {t('usr.cancel')}
          </Button>
          <Button type="submit" form="pw-form" loading={update.isPending}>
            {t('usr.setPassword')}
          </Button>
        </>
      }
    >
      <form id="pw-form" onSubmit={submit} noValidate>
        <Field
          label={t('usr.newPassword')}
          type="password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          error={error}
          hint={t('usr.newPwHint')}
          autoComplete="new-password"
        />
      </form>
    </Modal>
  );
}

interface Display {
  id: number;
  label: string;
  active: boolean;
  created_at: number;
}

/** P1: a one-time link to open a read-only wall screen. The token is shown once, only here. */
function NewDisplay({ onClose }: { onClose: () => void }) {
  const { t } = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const [label, setLabel] = useState('');
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const create = useMutation({
    mutationFn: () => api<{ url: string }>('/api/displays', { method: 'POST', body: { label: label.trim() } }),
    onSuccess: ({ url }) => {
      setLink(url);
      void qc.invalidateQueries({ queryKey: ['displays'] });
    },
  });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link!);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast({ tone: 'error', title: t('usr.couldNotCopy'), body: t('usr.couldNotCopyBody') });
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={link ? t('usr.displayLinkReady') : t('usr.addDisplayTitle')}
      footer={
        link ? (
          <Button onClick={onClose}>{t('usr.done')}</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose} disabled={create.isPending}>
              {t('usr.cancel')}
            </Button>
            <Button type="submit" form="display-form" loading={create.isPending} disabled={!label.trim()}>
              {t('usr.createLink')}
            </Button>
          </>
        )
      }
    >
      {link ? (
        <div className="grid gap-3">
          <p className="text-sm text-ink">{t('usr.displayLinkBody')}</p>
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={link}
              aria-label={t('usr.displayLinkAria')}
              onFocus={(e) => e.target.select()}
              className="figures min-h-10 w-full rounded-[var(--radius-label)] border border-rule bg-panel-2 px-3 text-xs text-ink"
            />
            <Button
              variant="secondary"
              icon={copied ? <Check aria-hidden className="size-4" /> : <Copy aria-hidden className="size-4" />}
              onClick={() => void copy()}
            >
              {copied ? t('usr.copied') : t('usr.copy')}
            </Button>
          </div>
        </div>
      ) : (
        <form
          id="display-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (label.trim()) create.mutate();
          }}
          noValidate
        >
          <Field
            label={t('usr.screenName')}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            hint={t('usr.screenNameHint')}
            autoComplete="off"
          />
        </form>
      )}
    </Modal>
  );
}

function DisplaysPanel() {
  const { t } = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const displays = useQuery({
    queryKey: ['displays'],
    queryFn: ({ signal }) => api<{ displays: Display[] }>('/api/displays', { signal }),
  });
  const revoke = useMutation({
    mutationFn: (id: number) => api(`/api/displays/${id}/revoke`, { method: 'POST' }),
    onSuccess: () => {
      toast({ tone: 'success', title: t('usr.linkRevoked') });
      void qc.invalidateQueries({ queryKey: ['displays'] });
    },
    onError: (e) => toast({ tone: 'error', title: t('usr.couldNotRevoke'), body: message(e, t) }),
  });
  const active = displays.data?.displays.filter((d) => d.active) ?? [];

  return (
    <section className="mt-6">
      <PageHeader
        title={t('page.displays.title')}
        subtitle={t('page.displays.subtitle')}
        actions={
          <Button icon={<Monitor aria-hidden className="size-4" />} onClick={() => setAdding(true)}>
            {t('usr.addDisplay')}
          </Button>
        }
      />
      <Panel bodyClassName="">
        {displays.isPending ? (
          <div className="p-4">
            <Skeleton className="h-12" />
          </div>
        ) : displays.error ? (
          <div className="px-4">
            <ErrorState error={displays.error} onRetry={() => void displays.refetch()} />
          </div>
        ) : active.length === 0 ? (
          <EmptyState icon={<Monitor aria-hidden className="size-6" />} title={t('usr.noDisplays')}>
            {t('usr.noDisplaysBody')}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-rule">
            {active.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink">{d.label}</p>
                  <p className="text-xs text-ink-3">
                    {fmt(t('usr.added'), { d: new Date(d.created_at).toLocaleDateString() })}
                  </p>
                </div>
                <Button
                  variant="secondary"
                  className="min-h-9 px-2.5"
                  loading={revoke.isPending && revoke.variables === d.id}
                  onClick={() => revoke.mutate(d.id)}
                  aria-label={fmt(t('usr.revokeAria'), { n: d.label })}
                >
                  {t('usr.revoke')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      {adding && <NewDisplay onClose={() => setAdding(false)} />}
    </section>
  );
}

export function UsersPage() {
  const { t } = useT();
  const { user: me } = useAuth();
  const users = useQuery({
    queryKey: ['users'],
    queryFn: ({ signal }) => api<{ users: User[] }>('/api/users', { signal }),
  });
  const update = useUpdateUser();
  const [dialog, setDialog] = useState<
    { kind: 'create' } | { kind: 'password' | 'disable' | 'totp'; user: User } | null
  >(null);
  const close = () => setDialog(null);

  return (
    <>
      <PageHeader
        title={t('page.users.title')}
        subtitle={t('page.users.subtitle')}
        actions={
          <Button
            icon={<UserPlus aria-hidden className="size-4" />}
            onClick={() => setDialog({ kind: 'create' })}
          >
            {t('usr.addUser')}
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
          <EmptyState icon={<Users aria-hidden className="size-6" />} title={t('usr.noUsers')} />
        ) : (
          <div className="relative overflow-x-auto">
            <table className="figures w-full min-w-[48rem] border-collapse text-left text-sm">
              <caption className="sr-only">{t('page.users.title')}</caption>
              <thead className="bg-panel-2">
                <tr>
                  {[t('usr.colUser'), t('usr.colRole'), t('usr.colStatus'), t('usr.colTwoFactor'), t('usr.colAdded')].map((h) => (
                    <th
                      key={h}
                      scope="col"
                      className="border-b border-rule px-4 py-2.5 text-xs font-semibold tracking-wide text-ink-2 uppercase"
                    >
                      {h}
                    </th>
                  ))}
                  <th scope="col" className="border-b border-rule px-4 py-2.5">
                    <span className="sr-only">{t('usr.colActions')}</span>
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
                          <span className="ml-2 text-xs font-medium text-ink-3">{t('usr.you')}</span>
                        )}
                      </span>
                      <span className="block text-xs text-ink-2">{u.email}</span>
                    </td>
                    <td className="px-4 py-2.5">
                      <Select
                        label={fmt(t('usr.roleOf'), { n: u.name })}
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
                      {u.active ? t('usr.active') : t('usr.disabled')}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      {u.totp_enabled ? (
                        <span className="inline-flex items-center gap-1.5 font-medium text-ink">
                          <ShieldCheck aria-hidden className="size-4 text-teal" />
                          {t('usr.on')}
                        </span>
                      ) : (
                        <span className="text-ink-3">{t('usr.off')}</span>
                      )}
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
                          aria-label={fmt(t('usr.resetPasswordAria'), { n: u.name })}
                        >
                          {t('usr.resetPassword')}
                        </Button>
                        {u.totp_enabled && (
                          <Button
                            variant="ghost"
                            className="min-h-9 px-2.5"
                            icon={<ShieldOff aria-hidden className="size-4" />}
                            disabled={!u.active}
                            onClick={() => setDialog({ kind: 'totp', user: u })}
                            aria-label={fmt(t('usr.resetTwoFactorAria'), { n: u.name })}
                          >
                            {t('usr.resetTwoFactor')}
                          </Button>
                        )}
                        {u.active ? (
                          <Button
                            variant="secondary"
                            className="min-h-9 px-2.5"
                            onClick={() => setDialog({ kind: 'disable', user: u })}
                            aria-label={fmt(t('usr.disableAria'), { n: u.name })}
                          >
                            {t('usr.disable')}
                          </Button>
                        ) : (
                          <Button
                            variant="secondary"
                            className="min-h-9 px-2.5"
                            loading={update.isPending && update.variables?.id === u.id}
                            onClick={() => update.mutate({ id: u.id, patch: { active: true } })}
                            aria-label={fmt(t('usr.enableAria'), { n: u.name })}
                          >
                            {t('usr.enable')}
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
      <DisplaysPanel />
      {dialog?.kind === 'create' && <CreateUser onClose={close} />}
      {dialog?.kind === 'password' && <ResetPassword user={dialog.user} onClose={close} />}
      {dialog?.kind === 'disable' && (
        <Modal
          open
          onClose={close}
          title={fmt(t('usr.disableTitle'), { n: dialog.user.name })}
          footer={
            <>
              <Button variant="secondary" onClick={close} disabled={update.isPending}>
                {t('usr.cancel')}
              </Button>
              <Button
                variant="danger"
                loading={update.isPending}
                onClick={() =>
                  update.mutate({ id: dialog.user.id, patch: { active: false } }, { onSettled: close })
                }
              >
                {t('usr.disableConfirm')}
              </Button>
            </>
          }
        >
          <p className="text-sm text-ink">{fmt(t('usr.disableBody'), { email: dialog.user.email })}</p>
        </Modal>
      )}
      {dialog?.kind === 'totp' && (
        <Modal
          open
          onClose={close}
          title={fmt(t('usr.totpTitle'), { n: dialog.user.name })}
          footer={
            <>
              <Button variant="secondary" onClick={close} disabled={update.isPending}>
                {t('usr.cancel')}
              </Button>
              <Button
                variant="danger"
                loading={update.isPending}
                onClick={() =>
                  update.mutate({ id: dialog.user.id, patch: { totp_reset: true } }, { onSettled: close })
                }
              >
                {t('usr.totpConfirm')}
              </Button>
            </>
          }
        >
          <p className="text-sm text-ink">{fmt(t('usr.totpBody'), { email: dialog.user.email })}</p>
        </Modal>
      )}
    </>
  );
}
