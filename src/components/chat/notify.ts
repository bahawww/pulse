/**
 * Browser alerts for the chat: a system notification, a tab-title mark and a
 * short vibration when the agent needs an answer or finishes while the chat is
 * out of sight. Off until the person turns it on (the browser asks then).
 * A notification carries the chat's title only, never what was said.
 */

const KEY = 'vps_chat_notify';

export function notifySupported(): boolean {
  return typeof Notification !== 'undefined';
}

export function notifyEnabled(): boolean {
  try {
    return notifySupported() && localStorage.getItem(KEY) === '1' && Notification.permission === 'granted';
  } catch {
    return false;
  }
}

/** Turns alerts on (asking the browser first) or off. Answers what is now the case. */
export async function setNotifyEnabled(on: boolean): Promise<boolean> {
  let enabled = false;
  if (on && notifySupported()) {
    const perm = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    enabled = perm === 'granted';
  }
  try {
    if (enabled) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode: on for this visit only */
  }
  return enabled;
}

/** A notification through the service worker when there is one (Android needs it), else directly. */
export async function showAlert(title: string, body: string, tag: string): Promise<void> {
  if (!notifyEnabled()) return;
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) {
      await reg.showNotification(title, { body, tag, icon: '/icons/icon-192.png', requireInteraction: tag.startsWith('ask') });
      return;
    }
  } catch {
    /* fall through */
  }
  try {
    const n = new Notification(title, { body, tag, icon: '/icons/icon-192.png' });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    /* some mobile browsers only allow the worker route */
  }
}

export function vibrate(pattern: number | number[]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* not available */
  }
}
