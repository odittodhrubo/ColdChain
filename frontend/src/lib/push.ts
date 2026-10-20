// P7: browser Web Push. Subscribes this device to BREACH/DOOR alerts and posts the subscription to the backend.
// All of it degrades gracefully: no service worker, no Notification API, or no VAPID key => `supported()` false.
import { api } from './api';

export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/** base64url VAPID key -> Uint8Array (ArrayBuffer-backed), the form pushManager.subscribe wants. */
function urlB64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!pushSupported()) return null;
  return (await navigator.serviceWorker.getRegistration()) ?? navigator.serviceWorker.register('/sw.js');
}

export async function pushStatus(): Promise<'unsupported' | 'off' | 'disabled' | 'on'> {
  if (!pushSupported()) return 'unsupported';
  const { key } = await api<{ key: string | null; enabled: boolean }>('/api/push/vapid-key');
  if (!key) return 'disabled'; // the server has no VAPID keys configured
  const sub = await (await registration())?.pushManager.getSubscription();
  return sub ? 'on' : 'off';
}

/** Ask permission, subscribe, and register with the backend. Returns the new status. Throws on a hard failure. */
export async function enablePush(): Promise<'on' | 'denied'> {
  const reg = await registration();
  if (!reg) throw new Error('This browser does not support notifications.');
  if ((await Notification.requestPermission()) !== 'granted') return 'denied';
  const { key } = await api<{ key: string | null }>('/api/push/vapid-key');
  if (!key) throw new Error('Push notifications are not configured on the server.');
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlB64ToBytes(key),
    }));
  const json = sub.toJSON(); // drop expirationTime: the backend schema is strict (endpoint + keys only)
  await api('/api/push/subscribe', { method: 'POST', body: { endpoint: json.endpoint, keys: json.keys } });
  return 'on';
}

export async function disablePush(): Promise<void> {
  const sub = await (await registration())?.pushManager.getSubscription();
  if (!sub) return;
  await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
  await sub.unsubscribe();
}
