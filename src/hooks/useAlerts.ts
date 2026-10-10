import { useCallback, useEffect, useRef, useState } from 'react';
import type { AlertEvent, AlertState } from '../shared/contract';
import { usePolled, type PolledState } from './usePolled';

/**
 * Web alert delivery. One poll of /api/alerts shared by the bell, the hero
 * status and the watcher below, so they can never disagree.
 *
 * While the tab is open, a newly firing alert raises a toast and (when the
 * browser allows it) a desktop notification, and the tab title carries the
 * firing count so it is visible from another tab. Alerts already firing when
 * the page loads only light the badge: replaying them as toasts on every page
 * open would train you to ignore the toast.
 *
 * Desktop notifications need a secure context. Over plain http://<ip> the
 * browser has no Notification permission to grant, and the UI says so.
 */

export type DesktopPermission = NotificationPermission | 'unsupported' | 'insecure';

export interface AlertsHandle {
  readonly state: PolledState<AlertState>;
  readonly firing: readonly AlertEvent[];
  readonly desktop: DesktopPermission;
  readonly requestDesktop: () => void;
}

const POLL_MS = 15_000;
const BASE_TITLE = 'Pulse';

function readPermission(): DesktopPermission {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  if (!window.isSecureContext) return 'insecure';
  return Notification.permission;
}

export function useAlerts(onNotify: (message: string) => void): AlertsHandle {
  // Pushed over /api/stream when an alert changes; polled only while the stream is down.
  const state = usePolled<AlertState>('/api/alerts', POLL_MS, true, 'alerts');
  const [desktop, setDesktop] = useState<DesktopPermission>(readPermission);
  // null until the first successful poll, so alerts already firing at page load
  // are recorded as seen rather than announced.
  const seen = useRef<Map<string, boolean> | null>(null);

  const firing = state.data ? state.data.events.filter((e) => e.resolvedAt === null) : [];

  useEffect(() => {
    const data = state.data;
    if (!data) return;

    if (seen.current === null) {
      seen.current = new Map(data.events.map((e) => [e.id, e.resolvedAt === null]));
      return;
    }

    for (const event of data.events) {
      const wasFiring = seen.current.get(event.id);
      const isFiring = event.resolvedAt === null;
      if (wasFiring === undefined && isFiring) announce(event, 'fired');
      else if (wasFiring === true && !isFiring) announce(event, 'resolved');
      seen.current.set(event.id, isFiring);
    }

    function announce(event: AlertEvent, kind: 'fired' | 'resolved') {
      const text = kind === 'fired' ? `Alert: ${event.message}` : `Resolved: ${event.message}`;
      onNotify(text);
      if (readPermission() === 'granted') {
        try {
          // `tag` collapses repeats of the same breach into one OS notification.
          new Notification(kind === 'fired' ? `${event.severity.toUpperCase()} · ${event.metric}` : `Resolved · ${event.metric}`, {
            body: event.message,
            tag: event.id,
          });
        } catch {
          /* some browsers only allow notifications from a service worker */
        }
      }
    }
  }, [state.data, onNotify]);

  // Firing count in the tab title, visible from any other tab.
  const count = firing.length;
  useEffect(() => {
    document.title = count > 0 ? `(${count}) ${BASE_TITLE}` : BASE_TITLE;
  }, [count]);

  const requestDesktop = useCallback(() => {
    if (readPermission() !== 'default') {
      setDesktop(readPermission());
      return;
    }
    void Notification.requestPermission().then(() => setDesktop(readPermission()));
  }, []);

  return { state, firing, desktop, requestDesktop };
}
