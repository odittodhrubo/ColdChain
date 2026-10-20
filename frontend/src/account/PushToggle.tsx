import { Bell, BellOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { disablePush, enablePush, pushStatus } from '../lib/push';
import { Button } from '../ui/Button';
import { useToast } from '../ui/Toast';

type Status = 'loading' | 'unsupported' | 'off' | 'disabled' | 'on';

/**
 * P7: turn Web Push on or off for this browser. BREACH and the 5-minute door alarm then reach the device even
 * with the tab closed. "disabled" means the server has no VAPID keys; "unsupported" means this browser cannot.
 */
export function PushToggle() {
  const toast = useToast();
  const [status, setStatus] = useState<Status>('loading');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    pushStatus()
      .then(setStatus)
      .catch(() => setStatus('unsupported'));
  }, []);

  async function enable() {
    setBusy(true);
    try {
      const next = await enablePush();
      setStatus(next === 'on' ? 'on' : 'off');
      toast(
        next === 'on'
          ? { tone: 'success', title: 'Alerts on for this device' }
          : { tone: 'info', title: 'Notifications are blocked', body: 'Allow them in your browser settings.' },
      );
    } catch (err) {
      toast({ tone: 'error', title: 'Could not turn on alerts', body: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    try {
      await disablePush();
      setStatus('off');
      toast({ tone: 'info', title: 'Alerts off for this device' });
    } finally {
      setBusy(false);
    }
  }

  if (status === 'loading') return <p className="text-sm text-ink-3">Checking…</p>;
  if (status === 'unsupported')
    return <p className="text-sm text-ink-2">This browser cannot show push notifications.</p>;
  if (status === 'disabled')
    return (
      <p className="text-sm text-ink-2">
        Push notifications are not configured on this server. Set <code>VAPID_PUBLIC_KEY</code> and{' '}
        <code>VAPID_PRIVATE_KEY</code> to enable them.
      </p>
    );

  return (
    <div className="flex max-w-prose flex-col gap-4">
      <p className="text-sm text-ink-2">
        Get a notification on this device for a breach or a door left open, even when the tab is closed.
      </p>
      {status === 'on' ? (
        <Button
          variant="secondary"
          className="self-start"
          loading={busy}
          icon={<BellOff aria-hidden className="size-4" />}
          onClick={() => void disable()}
        >
          Turn off alerts on this device
        </Button>
      ) : (
        <Button
          className="self-start"
          loading={busy}
          icon={<Bell aria-hidden className="size-4" />}
          onClick={() => void enable()}
        >
          Turn on alerts on this device
        </Button>
      )}
    </div>
  );
}
