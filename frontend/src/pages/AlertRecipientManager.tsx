import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Check, CheckCircle2, Mail, Plus, Send, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { can } from '../auth/permissions';
import { api } from '../lib/api';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { Modal } from '../ui/Modal';
import { Panel } from '../ui/Panel';
import { Select } from '../ui/Select';
import { useToast } from '../ui/Toast';

export interface AlertRecipient {
  id: number;
  email: string;
  is_active: number;
  created_at: number;
  created_by: string | null;
}

export interface RecipientsResponse {
  recipients: AlertRecipient[];
  active_email: string | null;
  smtp_configured: boolean;
  smtp_host: string | null;
}

export function AlertRecipientManager() {
  const { user } = useAuth();
  const canManage = can(user?.role, 'user:manage');
  const qc = useQueryClient();
  const toast = useToast();

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [setActiveNow, setSetActiveNow] = useState(true);
  const [emailError, setEmailError] = useState<string | null>(null);

  // Stateful modal confirmation for delete (replaces window.confirm which browsers block)
  const [recipientToDelete, setRecipientToDelete] = useState<AlertRecipient | null>(null);

  const { data, isPending } = useQuery<RecipientsResponse>({
    queryKey: ['alert-recipients'],
    queryFn: () => api<RecipientsResponse>('/api/alerts/recipients'),
  });

  const addMutation = useMutation({
    mutationFn: (variables: { email: string; set_active: boolean }) =>
      api<{ recipient: AlertRecipient; active_email: string | null }>('/api/alerts/recipients', {
        method: 'POST',
        body: variables,
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['alert-recipients'] });
      toast({
        tone: 'success',
        title: 'Recipient Added',
        body: `Added ${res.recipient.email} to alert recipients`,
      });
      setIsModalOpen(false);
      setNewEmail('');
      setEmailError(null);
    },
    onError: (err: Error) => {
      setEmailError(err.message);
    },
  });

  const activateMutation = useMutation({
    mutationFn: (id: number) =>
      api<{ success: boolean; active_email: string | null }>(`/api/alerts/recipients/${id}/activate`, {
        method: 'POST',
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['alert-recipients'] });
      toast({
        tone: 'success',
        title: 'Active Recipient Updated',
        body: `Active alert notifications will now be sent to ${res.active_email}`,
      });
    },
    onError: (err: Error) => {
      toast({ tone: 'error', title: 'Update Failed', body: err.message });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      api<{ success: boolean; active_email: string | null }>(`/api/alerts/recipients/${id}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alert-recipients'] });
      toast({
        tone: 'success',
        title: 'Recipient Removed',
        body: 'Alert recipient was successfully deleted',
      });
      setRecipientToDelete(null);
    },
    onError: (err: Error) => {
      toast({ tone: 'error', title: 'Delete Failed', body: err.message });
    },
  });

  const testMutation = useMutation({
    mutationFn: (email?: string) =>
      api<{ result: { ok: boolean; recipient: string; error?: string } }>('/api/alerts/recipients/test', {
        method: 'POST',
        body: email ? { email } : {},
      }),
    onSuccess: (data) => {
      if (data.result.ok) {
        toast({
          tone: 'success',
          title: 'Test Email Sent',
          body: `Verification email delivered to ${data.result.recipient}!`,
        });
      } else {
        toast({
          tone: 'error',
          title: 'Delivery Failed',
          body: data.result.error || 'Failed to send test email',
        });
      }
    },
    onError: (err: Error) => {
      toast({ tone: 'error', title: 'Test Failed', body: err.message });
    },
  });

  const recipients = data?.recipients ?? [];
  const activeRecipient = recipients.find((r) => r.is_active === 1);
  const selectedValue = activeRecipient ? String(activeRecipient.id) : '';

  const handleAddSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const email = newEmail.trim();
    if (!email || !email.includes('@')) {
      setEmailError('Please enter a valid email address');
      return;
    }
    setEmailError(null);
    addMutation.mutate({ email, set_active: setActiveNow });
  };

  return (
    <>
      <Panel
        title={
          <div className="flex items-center gap-2">
            <Mail aria-hidden className="size-4 text-teal" />
            <span>Alert Email Notifications (Gmail / SMTP)</span>
          </div>
        }
        actions={
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium border ${
                data?.smtp_configured
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                  : 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400'
              }`}
            >
              {data?.smtp_configured ? (
                <>
                  <CheckCircle2 aria-hidden className="size-3" />
                  <span>SMTP Active ({data.smtp_host ?? 'Gmail'})</span>
                </>
              ) : (
                <>
                  <AlertCircle aria-hidden className="size-3" />
                  <span>Configure SMTP in .env</span>
                </>
              )}
            </span>
          </div>
        }
        className="mb-6"
      >
        <div className="flex flex-col gap-4">
          <p className="text-xs text-ink-2">
            Alert notifications for door alarms (&gt;60 s) and temperature breaches (2–8 °C) are automatically dispatched to the active email address below.
          </p>

          {/* Dropdown Selection & Primary Actions */}
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[280px] flex-1">
              <label htmlFor="alert-recipient-dropdown" className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-ink-2">
                Active Recipient Dropdown (ALERT_EMAIL_TO)
              </label>
              <Select
                id="alert-recipient-dropdown"
                label="Alert Email Recipient"
                hideLabel
                value={selectedValue}
                onChange={(e) => {
                  const id = Number(e.target.value);
                  if (id) activateMutation.mutate(id);
                }}
                disabled={!canManage || isPending || recipients.length === 0}
                className="w-full"
              >
                {recipients.length === 0 ? (
                  <option value="">
                    {data?.active_email ? `${data.active_email} (.env default)` : 'No alert emails registered'}
                  </option>
                ) : (
                  recipients.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.email} {r.is_active ? '✓ (Active Alert Email)' : ''}
                    </option>
                  ))
                )}
              </Select>
            </div>

            {canManage && (
              <Button
                variant="primary"
                icon={<Plus aria-hidden className="size-4" />}
                onClick={() => {
                  setNewEmail('');
                  setEmailError(null);
                  setIsModalOpen(true);
                }}
                className="h-10 px-3.5"
              >
                Add Alert Gmail
              </Button>
            )}

            <Button
              variant="secondary"
              icon={<Send aria-hidden className="size-4" />}
              loading={testMutation.isPending}
              onClick={() => testMutation.mutate(activeRecipient?.email || data?.active_email || undefined)}
              className="h-10 px-3.5"
              title="Send a test notification to verify Gmail delivery"
            >
              Send Test Alert
            </Button>
          </div>

          {/* Configured Recipients List with Delete Dialog Trigger */}
          {recipients.length > 0 && (
            <div className="mt-2 flex flex-col gap-2 rounded-lg border border-rule bg-panel-2 p-3">
              <span className="text-xs font-semibold uppercase tracking-wider text-ink-2">
                Configured Recipients ({recipients.length})
              </span>
              <div className="flex flex-col divide-y divide-rule">
                {recipients.map((r) => (
                  <div key={r.id} className="flex items-center justify-between py-2.5 first:pt-1 last:pb-1">
                    <div className="flex items-center gap-2.5">
                      <span className="font-mono text-sm text-ink">{r.email}</span>
                      {r.is_active ? (
                        <span className="inline-flex items-center gap-1 rounded bg-teal/10 px-2 py-0.5 text-xs font-medium text-teal">
                          <Check className="size-3" /> Active Recipient
                        </span>
                      ) : (
                        <span className="rounded bg-rule px-2 py-0.5 text-xs text-ink-3">
                          Inactive
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      {!r.is_active && canManage && (
                        <Button
                          variant="ghost"
                          onClick={() => activateMutation.mutate(r.id)}
                          loading={activateMutation.isPending}
                          className="h-8 px-2.5 text-xs text-teal hover:bg-teal/10"
                        >
                          Set Active
                        </Button>
                      )}

                      <Button
                        variant="ghost"
                        icon={<Send className="size-3.5" />}
                        onClick={() => testMutation.mutate(r.email)}
                        loading={testMutation.isPending}
                        className="h-8 px-2.5 text-xs"
                        title={`Send test email to ${r.email}`}
                      >
                        Test
                      </Button>

                      {canManage && (
                        <Button
                          variant="ghost"
                          icon={<Trash2 className="size-3.5 text-red-500" />}
                          onClick={() => setRecipientToDelete(r)}
                          className="h-8 px-2.5 text-xs text-red-500 hover:bg-red-500/10"
                          title={`Delete ${r.email}`}
                        >
                          Delete
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between border-t border-rule pt-3 text-xs text-ink-3">
            <span>
              Current Active Address:{' '}
              <strong className="font-semibold text-ink">
                {activeRecipient?.email || data?.active_email || 'None (Configure above or in .env)'}
              </strong>
            </span>
            <span>{recipients.length} email recipient(s) saved</span>
          </div>
        </div>
      </Panel>

      {/* Add Alert Gmail Modal */}
      <Modal
        open={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title="Add Alert Gmail / Email"
        footer={
          <>
            <Button variant="secondary" onClick={() => setIsModalOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={addMutation.isPending}
              onClick={handleAddSubmit}
              icon={<Plus aria-hidden className="size-4" />}
            >
              Add Recipient
            </Button>
          </>
        }
      >
        <form onSubmit={handleAddSubmit} className="flex flex-col gap-4 py-1">
          <p className="text-sm text-ink-2">
            Enter the Gmail address that should receive ColdChain breach and door-alarm warnings.
          </p>

          <Field
            label="Gmail / Email Address"
            type="email"
            placeholder="e.g. pharmacist.coldchain@gmail.com"
            value={newEmail}
            onChange={(e) => {
              setNewEmail(e.target.value);
              if (emailError) setEmailError(null);
            }}
            error={emailError}
            required
            autoFocus
          />

          <label className="flex items-center gap-2 cursor-pointer pt-1 text-sm text-ink">
            <input
              type="checkbox"
              checked={setActiveNow}
              onChange={(e) => setSetActiveNow(e.target.checked)}
              className="size-4 rounded border-rule-strong accent-teal"
            />
            <span>Set as active alert recipient immediately</span>
          </label>
        </form>
      </Modal>

      {/* Confirmation Modal for Delete (Works reliably across all browsers) */}
      <Modal
        open={recipientToDelete !== null}
        onClose={() => !deleteMutation.isPending && setRecipientToDelete(null)}
        title="Delete Alert Recipient"
        footer={
          <>
            <Button
              variant="secondary"
              disabled={deleteMutation.isPending}
              onClick={() => setRecipientToDelete(null)}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={deleteMutation.isPending}
              onClick={() => {
                if (recipientToDelete) {
                  deleteMutation.mutate(recipientToDelete.id);
                }
              }}
              icon={<Trash2 aria-hidden className="size-4" />}
            >
              Confirm Delete
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-2 py-2">
          <p className="text-sm text-ink">
            Are you sure you want to remove <strong className="font-semibold text-breach">{recipientToDelete?.email}</strong> from the alert recipients list?
          </p>
          <p className="text-xs text-ink-3">
            This email will no longer receive temperature breach or door alarm notifications.
          </p>
        </div>
      </Modal>
    </>
  );
}
