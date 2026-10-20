/**
 * Dictation with the browser's own speech recognition (Chrome, Edge, Safari,
 * Android). It sends the audio to the browser vendor's service, not to Pulse,
 * and needs the microphone permission; where the browser has none, there is no
 * button. The result lands in the message box for the person to check.
 */

interface RecognitionEvent {
  readonly resultIndex: number;
  readonly results: ArrayLike<{ readonly isFinal: boolean; readonly 0: { readonly transcript: string } }>;
}

interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: RecognitionEvent) => void) | null;
  onerror: ((e: { readonly error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

type RecognitionCtor = new () => Recognition;

function ctor(): RecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function voiceSupported(): boolean {
  return ctor() !== null;
}

const ERRORS: Readonly<Record<string, string>> = {
  'not-allowed': 'The microphone is blocked for this site',
  'service-not-allowed': 'The browser does not allow speech recognition here',
  'audio-capture': 'No microphone found',
  network: "The browser's speech service could not be reached",
  'language-not-supported': 'That language is not supported for dictation',
};

export interface Dictation {
  readonly stop: () => void;
}

/** Starts listening. `onText` gets everything said so far, final and still-changing parts apart. */
export function startDictation(opts: {
  readonly onText: (final: string, interim: string) => void;
  readonly onEnd: () => void;
  readonly onError: (message: string) => void;
}): Dictation | null {
  const Ctor = ctor();
  if (!Ctor) return null;
  const rec = new Ctor();
  rec.lang = navigator.language || 'en-US';
  rec.continuous = true;
  rec.interimResults = true;
  let final = '';
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i += 1) {
      const r = e.results[i]!;
      if (r.isFinal) final += r[0].transcript;
      else interim += r[0].transcript;
    }
    opts.onText(final, interim);
  };
  rec.onerror = (e) => {
    // Silence and a deliberate stop are not problems.
    if (e.error !== 'no-speech' && e.error !== 'aborted') opts.onError(ERRORS[e.error] ?? `Dictation failed (${e.error})`);
  };
  rec.onend = opts.onEnd;
  try {
    rec.start();
  } catch {
    return null;
  }
  return { stop: () => rec.stop() };
}
