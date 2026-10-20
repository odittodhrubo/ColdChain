import { Download, ShieldCheck, ShieldOff, Smartphone } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { api, ApiError } from '../lib/api';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { useToast } from '../ui/Toast';

interface Setup {
  secret: string;
  otpauthUri: string;
  qrSvg: string;
}

const groups = (s: string) => s.match(/.{1,4}/g)?.join(' ') ?? s;
const codeError = (err: unknown) =>
  err instanceof ApiError && err.code === 'INVALID_CODE'
    ? 'That code is not right. Check that the phone shows the time correctly, then try the next code.'
    : err instanceof Error
      ? err.message
      : 'Something went wrong. Try again.';

/** A 6-digit code field: numeric keypad on phones, the OS can offer the code from the authenticator. */
export function CodeField({
  value,
  onChange,
  error,
  label = 'Code from the authenticator app',
}: {
  value: string;
  onChange: (v: string) => void;
  error?: string | null;
  label?: string;
}) {
  return (
    <Field
      label={label}
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="\d{6}"
      maxLength={6}
      placeholder="123456"
      className="max-w-[12rem]"
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
      error={error}
    />
  );
}

/**
 * Two-factor sign-in (S3): off -> setup (scan the QR or type the secret) -> confirm with a code -> the ten
 * recovery codes, shown once. On: switch it off with a current code, unless the server requires it.
 */
export function TwoFactor({ required = false, onEnabled }: { required?: boolean; onEnabled?: () => void }) {
  const { totpEnabled, update } = useAuth();
  const toast = useToast();
  const [setup, setSetup] = useState<Setup | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [turningOff, setTurningOff] = useState(false);

  async function begin() {
    setBusy(true);
    setError(null);
    try {
      setSetup(await api<Setup>('/api/auth/totp/setup', { method: 'POST' }));
    } catch (err) {
      setError(codeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirm(e: FormEvent) {
    e.preventDefault();
    if (code.length !== 6) return setError('Enter the 6 digits the app shows');
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ recoveryCodes: string[] }>('/api/auth/totp/confirm', {
        method: 'POST',
        body: { code },
      });
      setCodes(res.recoveryCodes);
      setSetup(null);
      setCode('');
    } catch (err) {
      setError(codeError(err));
    } finally {
      setBusy(false);
    }
  }

  function finish() {
    setCodes(null);
    update({ totpEnabled: true, mfaSetupRequired: false });
    toast({ tone: 'success', title: 'Two-factor sign-in is on' });
    onEnabled?.();
  }

  async function turnOff(e: FormEvent) {
    e.preventDefault();
    if (code.length !== 6) return setError('Enter the 6 digits the app shows');
    setBusy(true);
    setError(null);
    try {
      await api('/api/auth/totp/disable', { method: 'POST', body: { code } });
      update({ totpEnabled: false });
      setTurningOff(false);
      setCode('');
      toast({ tone: 'info', title: 'Two-factor sign-in is off' });
    } catch (err) {
      setError(codeError(err));
    } finally {
      setBusy(false);
    }
  }

  function download() {
    const text = `ColdChain recovery codes\nEach code signs you in once, without the phone. Keep them somewhere safe.\n\n${codes!.join('\n')}\n`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = Object.assign(document.createElement('a'), {
      href: url,
      download: 'coldchain-recovery-codes.txt',
    });
    a.click();
    URL.revokeObjectURL(url);
  }

  if (codes)
    return (
      <div className="flex max-w-prose flex-col gap-4">
        <p className="text-sm text-ink">
          <strong className="font-semibold">Save these recovery codes now.</strong> Each one signs you in once
          if the phone is lost. They are not shown again.
        </p>
        <ol className="figures grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-[var(--radius-label)] border border-rule bg-panel-2 px-4 py-3 text-[0.95rem] text-ink sm:w-fit">
          {codes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ol>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" icon={<Download aria-hidden className="size-4" />} onClick={download}>
            Download as a text file
          </Button>
          <Button onClick={finish}>I saved them</Button>
        </div>
      </div>
    );

  if (setup)
    return (
      <form
        onSubmit={confirm}
        noValidate
        className="flex max-w-prose flex-col gap-4"
        aria-label="Set up two-factor sign-in"
      >
        <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm text-ink">
          <li>
            Open an authenticator app on your phone (Google Authenticator, Microsoft Authenticator, or
            similar).
          </li>
          <li>Scan this code, or type the key below into the app.</li>
          <li>Enter the 6-digit code the app shows.</li>
        </ol>
        <div className="flex flex-wrap items-start gap-5">
          <img
            src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(setup.qrSvg)}`}
            alt="QR code to add ColdChain to an authenticator app"
            className="size-44 rounded-[var(--radius-label)] border border-rule bg-white p-2"
          />
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="text-sm font-semibold text-ink">Key to type in</span>
            <code className="figures rounded-md border border-rule bg-panel-2 px-3 py-2 text-[0.95rem] break-all text-ink">
              {groups(setup.secret)}
            </code>
            <span className="text-sm text-ink-3">Time-based, 6 digits, 30 seconds</span>
          </div>
        </div>
        <CodeField value={code} onChange={setCode} error={error} />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" loading={busy} icon={<ShieldCheck aria-hidden className="size-4" />}>
            Turn on two-factor sign-in
          </Button>
          <Button variant="ghost" onClick={() => setSetup(null)} disabled={busy}>
            Cancel
          </Button>
        </div>
      </form>
    );

  if (totpEnabled)
    return (
      <div className="flex max-w-prose flex-col gap-4">
        <p className="flex items-center gap-2 text-sm font-semibold text-ink">
          <ShieldCheck aria-hidden className="size-[18px] text-teal" />
          On: signing in needs your password and a code from your phone.
        </p>
        {required ? (
          <p className="text-sm text-ink-2">Two-factor sign-in is required for Admins on this system.</p>
        ) : turningOff ? (
          <form
            onSubmit={turnOff}
            noValidate
            className="flex flex-col gap-4"
            aria-label="Turn off two-factor sign-in"
          >
            <CodeField value={code} onChange={setCode} error={error} />
            <div className="flex flex-wrap gap-2">
              <Button
                type="submit"
                variant="danger"
                loading={busy}
                icon={<ShieldOff aria-hidden className="size-4" />}
              >
                Turn off
              </Button>
              <Button variant="ghost" onClick={() => setTurningOff(false)} disabled={busy}>
                Keep it on
              </Button>
            </div>
          </form>
        ) : (
          <Button variant="secondary" className="self-start" onClick={() => setTurningOff(true)}>
            Turn off two-factor sign-in
          </Button>
        )}
      </div>
    );

  return (
    <div className="flex max-w-prose flex-col gap-4">
      <p className="text-sm text-ink-2">
        {required
          ? 'Admins on this system must sign in with a password and a code from their phone. Set it up to continue.'
          : 'Ask for a code from your phone at every sign-in, so a stolen password alone is not enough.'}
      </p>
      {error && (
        <p role="alert" className="text-sm font-medium text-breach">
          {error}
        </p>
      )}
      <Button
        className="self-start"
        loading={busy}
        icon={<Smartphone aria-hidden className="size-4" />}
        onClick={() => void begin()}
      >
        Set up two-factor sign-in
      </Button>
    </div>
  );
}
