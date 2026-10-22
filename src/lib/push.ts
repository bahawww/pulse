import { postJson } from './csrf';

/**
 * This browser's Web Push subscription for terminal notices (server: push.ts).
 * Needs HTTPS and a service worker; on iPhone also Pulse added to the home
 * screen (iOS 16.4+), which is when PushManager exists at all.
 */

export type PushState = 'on' | 'off' | 'denied' | 'unsupported';

/**
 * Typed as `printf` in the shell. While a command runs, the shell reads it only
 * after that command ends, so it reports that command's exit code. The leading
 * space keeps it out of bash history (HISTCONTROL=ignoreboth).
 */
export const NOTIFY_WHEN_DONE = " printf '\\033]777;notify;Done;exit %s\\007' $?\r";

export function pushSupported(): boolean {
  return window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined';
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  return (await navigator.serviceWorker.getRegistration()) ?? null;
}

export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await registration();
  return (await reg?.pushManager.getSubscription()) ? 'on' : 'off';
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const b64 = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

/** Asks the browser, subscribes and registers with the server. Answers the new state. */
export async function enablePush(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  const perm = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
  if (perm !== 'granted') return perm === 'denied' ? 'denied' : 'off';
  const reg = (await registration()) ?? (await navigator.serviceWorker.ready);
  const res = await fetch('/api/push/key', { cache: 'no-store', headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`push key: HTTP ${res.status}`);
  const { key } = (await res.json()) as { key: string };
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
  const saved = await postJson('/api/push/subscribe', sub.toJSON());
  if (!saved.ok) throw new Error(`subscribe: HTTP ${saved.status}`);
  return 'on';
}

export async function disablePush(): Promise<PushState> {
  const reg = pushSupported() ? await registration() : null;
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await postJson('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => undefined);
    await sub.unsubscribe().catch(() => undefined);
  }
  return pushSupported() ? 'off' : 'unsupported';
}
