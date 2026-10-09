import { useCallback, useEffect, useState } from 'react';

/** Chromium's install prompt event. Not in the DOM typings yet. */
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export interface InstallHandle {
  /** The browser offered to install and the app is not installed yet. */
  readonly canInstall: boolean;
  readonly install: () => void;
}

/**
 * "Install app" support. The browser fires beforeinstallprompt once, early, so
 * this is mounted at the root, before login, and keeps the event until used.
 */
export function useInstall(): InstallHandle {
  const [offer, setOffer] = useState<InstallPromptEvent | null>(null);

  useEffect(() => {
    const onOffer = (e: Event) => {
      e.preventDefault();
      setOffer(e as InstallPromptEvent);
    };
    const onInstalled = () => setOffer(null);
    window.addEventListener('beforeinstallprompt', onOffer);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onOffer);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const install = useCallback(() => {
    if (!offer) return;
    void offer.prompt().then(() => offer.userChoice).finally(() => setOffer(null));
  }, [offer]);

  return { canInstall: offer !== null, install };
}
