import type { AlertEvent } from '../shared/contract.js';
import { formatClock, formatDay, TZ_LABEL } from '../shared/time.js';

/**
 * Telegram delivery for alerts.
 *
 * Credentials are read from the environment and never held anywhere else: the
 * bot token is only ever passed to Telegram, and nothing about it is written to
 * a file or included in a response body. If the channel is not configured the
 * panel says so explicitly, rather than silently appearing to work — a rule
 * engine with no working delivery is a dashboard that only the person staring
 * at it can see.
 */

interface TelegramConfig {
  readonly token: string;
  readonly chatId: string;
  readonly silent: boolean;
}

function loadConfig(): TelegramConfig | null {
  const token = process.env.TELEGRAM_BOT_TOKEN ?? process.env.HERMES_TELEGRAM_BOT_TOKEN ?? '';
  const chatId = process.env.TELEGRAM_CHAT_ID ?? process.env.HERMES_TELEGRAM_CHAT_ID ?? '';
  if (!token || !chatId) return null;
  return {
    token,
    chatId,
    silent: (process.env.TELEGRAM_SILENT ?? '') === '1',
  };
}

export interface ChannelStatus {
  readonly configured: boolean;
  readonly kind: string;
  readonly lastError: string | null;
  readonly lastSentAt: number | null;
  readonly sentCount: number;
}

const status: { -readonly [K in keyof ChannelStatus]: ChannelStatus[K] } = {
  configured: false,
  kind: 'telegram',
  lastError: null,
  lastSentAt: null,
  sentCount: 0,
};

/** Re-reads env at call time so a config change is picked up without a restart. */
export function channelStatus(): ChannelStatus {
  const config = loadConfig();
  status.configured = config !== null;
  return { ...status };
}

/**
 * Telegram's own limit is 4096 characters per message. Alert text is short, but
 * an untrusted length here would produce an opaque 400 from the API, so it is
 * truncated defensively before sending.
 */
const MAX_MESSAGE = 3800;

function format(event: AlertEvent): string {
  const icon = event.severity === 'critical' ? '🔴' : event.severity === 'warning' ? '🟡' : '🔵';
  const title = event.severity === 'critical' ? 'CRITICAL' : event.severity === 'warning' ? 'WARNING' : 'INFO';

  if (event.resolvedAt !== null) {
    const held = Math.round((event.resolvedAt - event.since) / 1000);
    return [
      `✅ <b>RESOLVED</b> — ${escapeHtml(event.metric)}`,
      escapeHtml(event.message),
      '',
      `<i>vps-dashboard · rule ${escapeHtml(event.ruleId)} · lasted ${held}s</i>`,
    ].join('\n');
  }

  const stamp = `${formatDay(event.since)} ${formatClock(event.since)}`;
  return [
    `${icon} <b>${title}</b> — ${escapeHtml(event.metric)}`,
    escapeHtml(event.message),
    '',
    `<i>vps-dashboard · since ${escapeHtml(stamp)} ${TZ_LABEL} · rule ${escapeHtml(event.ruleId)}</i>`,
  ].join('\n');
}

/**
 * HTML mode, not MarkdownV2. MarkdownV2 rejects any unescaped `- . ( ) !` and
 * more, and the old escaper only covered `* _ [ ]`, so every message (the footer
 * alone contains "vps-dashboard") came back HTTP 400. HTML needs three escapes.
 */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function send(text: string): Promise<boolean> {
  const config = loadConfig();
  if (!config) return false;

  const body = JSON.stringify({
    chat_id: config.chatId,
    text: text.slice(0, MAX_MESSAGE),
    parse_mode: 'HTML',
    disable_notification: config.silent,
  });

  try {
    const res = await fetch(`https://api.telegram.org/bot${config.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      // The API echoes the token in some error URLs; keep only the status.
      status.lastError = `telegram HTTP ${res.status}`;
      return false;
    }

    status.lastError = null;
    status.lastSentAt = Date.now();
    status.sentCount += 1;
    return true;
  } catch (err) {
    status.lastError = err instanceof Error ? err.message.slice(0, 120) : 'send failed';
    return false;
  }
}

/**
 * Delivers an event.
 *
 * Resolutions are best-effort: a resolved alert that fails to send is a missing
 * "all clear" rather than a missed problem, so it is reported but not retried as
 * loudly as a firing alert.
 */
export async function notify(event: AlertEvent): Promise<boolean> {
  if (!loadConfig()) return false;
  return send(format(event));
}

export function channelName(): string {
  return 'telegram';
}