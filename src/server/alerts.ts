import type {
  AlertEvent,
  AlertRule,
  AlertState,
  AlertThresholds,
  SystemMetrics,
} from '../shared/contract.js';
import { loadAlertEvents, saveAlertEvent } from './store.js';

/**
 * Threshold rules over the fixed 5s sample stream.
 *
 * The design constraint that shapes everything here: an alert nobody can act on
 * is noise, and noise trains people to ignore the panel. Three rules follow from
 * that.
 *
 *  - Debounce. A rule must breach for N consecutive samples before it fires, so
 *    a single CPU spike does not page anyone. The default of 3 samples (15s) is
 *    long enough to ignore a build, short enough to catch a real problem.
 *  - Hysteresis. Firing at 80% and clearing at 80% means a value hovering on the
 *    line produces a fire/resolve pair every few seconds. Clearing needs the
 *    value to come back below the limit by a margin.
 *  - Re-notify only on a new episode. A metric that stays breached for an hour
 *    is one alert, not 720 of them.
 */

/** How far back below the limit a metric must fall before the alert clears. */
const CLEAR_MARGIN = 5;

/** Keep at most this many events so a stuck rule cannot grow the payload. */
const MAX_EVENTS = 60;

export const DEFAULT_RULES: readonly AlertRule[] = [
  {
    id: 'cpu-high',
    label: 'CPU sustained high',
    enabled: true,
    severity: 'warning',
    thresholds: { cpuPercent: 80, ramPercent: null, diskPercent: null, inodePercent: null, netRxPerSec: null, latencyMs: [], forSamples: 3 },
  },
  {
    id: 'ram-high',
    label: 'Memory pressure',
    enabled: true,
    severity: 'warning',
    thresholds: { cpuPercent: null, ramPercent: 85, diskPercent: null, inodePercent: null, netRxPerSec: null, latencyMs: [], forSamples: 3 },
  },
  {
    id: 'disk-full',
    label: 'Disk nearly full',
    enabled: true,
    severity: 'critical',
    thresholds: { cpuPercent: null, ramPercent: null, diskPercent: 85, inodePercent: null, netRxPerSec: null, latencyMs: [], forSamples: 2 },
  },
  {
    id: 'inode-full',
    label: 'Inodes exhausted',
    enabled: true,
    severity: 'critical',
    thresholds: { cpuPercent: null, ramPercent: null, diskPercent: null, inodePercent: 80, netRxPerSec: null, latencyMs: [], forSamples: 2 },
  },
  {
    id: 'latency-high',
    label: 'Service latency high',
    enabled: true,
    severity: 'warning',
    thresholds: { cpuPercent: null, ramPercent: null, diskPercent: null, inodePercent: null, netRxPerSec: null, latencyMs: [200], forSamples: 4 },
  },
];

/** One metric currently breaching, and how long it has been. */
interface Breach {
  readonly metric: string;
  readonly since: number;
  count: number;
  lastValue: number;
  lastThreshold: number;
}

/** Events keyed by ruleId+metric so an episode is one entry, not many. */
const active = new Map<string, Breach>();
const events: AlertEvent[] = [];

function key(ruleId: string, metric: string): string {
  return `${ruleId}:${metric}`;
}

function describe(metric: string): string {
  switch (metric) {
    case 'cpu':
      return 'CPU';
    case 'ram':
      return 'Memory';
    case 'disk':
      return 'Disk';
    case 'inode':
      return 'Inodes';
    case 'latency':
      return 'Service latency';
    default:
      return metric;
  }
}

/** Formats the number the way the rule's limit was expressed. */
function formatValue(metric: string, value: number, threshold: number): string {
  if (metric === 'latency') return `${Math.round(value)}ms (limit ${threshold}ms)`;
  return `${Math.round(value)}% (limit ${threshold}%)`;
}

function clearBreach(ruleId: string, metric: string, now: number): AlertEvent | null {
  const k = key(ruleId, metric);
  const breach = active.get(k);
  if (!breach) return null;
  active.delete(k);

  const index = events.findIndex((e) => e.ruleId === ruleId && e.metric === metric && e.resolvedAt === null);
  if (index < 0) return null;
  const existing = events[index];
  if (!existing) return null;

  const resolved: AlertEvent = { ...existing, resolvedAt: now };
  events[index] = resolved;
  saveAlertEvent(resolved);
  return resolved;
}

function fire(
  rule: AlertRule,
  metric: string,
  value: number,
  threshold: number,
  since: number,
  now: number,
): AlertEvent | null {
  const k = key(rule.id, metric);
  const existingIndex = events.findIndex((e) => e.ruleId === rule.id && e.metric === metric && e.resolvedAt === null);
  const isNew = existingIndex < 0;

  // Keyed on the clock, not a counter: a counter restarts at zero on every boot,
  // and restored events from the last run would then collide with new ones.
  const event: AlertEvent = {
    id: `${k}#${now}`,
    ruleId: rule.id,
    severity: rule.severity,
    metric,
    message: `${describe(metric)} at ${formatValue(metric, value, threshold)} for ${Math.round((now - since) / 1000)}s`,
    value,
    threshold,
    since,
    firedAt: now,
    resolvedAt: null,
    occurrences: 1,
  };

  if (isNew) {
    events.unshift(event);
    if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
    saveAlertEvent(event);
    return event;
  }

  // Already firing: refresh the reading in place rather than adding an event, so
  // a sustained breach stays one row that gets more recent, not a flood.
  const prev = events[existingIndex];
  if (!prev) return null;
  events[existingIndex] = {
    ...prev,
    value,
    message: `${describe(metric)} at ${formatValue(metric, value, threshold)} for ${Math.round((now - since) / 1000)}s`,
  };
  return null;
}

/** Every (metric, value) a rule should watch, paired with its limit. */
function candidates(
  rule: AlertRule,
  system: SystemMetrics,
  latency: Readonly<Record<string, number>> | undefined,
): { metric: string; value: number; threshold: number }[] {
  const t: AlertThresholds = rule.thresholds;
  const out: { metric: string; value: number; threshold: number }[] = [];

  if (t.cpuPercent !== null) out.push({ metric: 'cpu', value: system.cpu.usage, threshold: t.cpuPercent });
  if (t.ramPercent !== null) out.push({ metric: 'ram', value: system.memory.percent, threshold: t.ramPercent });
  if (t.diskPercent !== null) out.push({ metric: 'disk', value: system.disk.percent, threshold: t.diskPercent });
  if (t.inodePercent !== null) {
    // Any filesystem counts, not just `/`: a full data disk is as urgent as a
    // full root.
    let worst = 0;
    for (const fs of system.filesystems) {
      if (fs.inodePercent > worst) worst = fs.inodePercent;
    }
    out.push({ metric: 'inode', value: worst, threshold: t.inodePercent });
  }

  if (t.latencyMs.length > 0 && latency) {
    for (const limit of t.latencyMs) {
      // Report the worst offender, named, rather than an average that hides it.
      let worstId: string | null = null;
      let worstMs = 0;
      for (const [id, ms] of Object.entries(latency)) {
        if (ms > worstMs) {
          worstMs = ms;
          worstId = id;
        }
      }
      if (worstId !== null && worstMs > limit) {
        out.push({ metric: 'latency', value: worstMs, threshold: limit });
      }
    }
  }

  return out;
}

/**
 * Advances the engine by one sample and returns any events that changed state.
 *
 * Returning only transitions (not every breaching sample) is what lets the
 * caller send exactly one message per episode.
 */
export function evaluate(
  rules: readonly AlertRule[],
  system: SystemMetrics,
  latency: Readonly<Record<string, number>> | undefined,
  now: number,
): { fired: AlertEvent[]; resolved: AlertEvent[] } {
  const fired: AlertEvent[] = [];
  const resolved: AlertEvent[] = [];
  const enabled = rules.filter((r) => r.enabled);

  for (const rule of enabled) {
    const seen = candidates(rule, system, latency);
    const seenMetrics = new Set<string>();

    for (const c of seen) {
      seenMetrics.add(c.metric);
      const k = key(rule.id, c.metric);
      const breach = active.get(k);

      if (!breach) {
        // Not yet breaching. Clear hysteresis: the value must come back below
        // (limit - margin) before a new episode can start, so a value sitting
        // exactly on the limit cannot oscillate.
        if (c.value < c.threshold - CLEAR_MARGIN) continue;
        active.set(k, { metric: c.metric, since: now, count: 1, lastValue: c.value, lastThreshold: c.threshold });
        const breach = active.get(k);
        if (breach) breach.count = 1;
        continue;
      }

      if (c.value < c.threshold - CLEAR_MARGIN) {
        const cleared = clearBreach(rule.id, c.metric, now);
        if (cleared) resolved.push(cleared);
        continue;
      }

      breach.count += 1;
      breach.lastValue = c.value;
      breach.lastThreshold = c.threshold;

      if (breach.count >= rule.thresholds.forSamples) {
        const event = fire(rule, c.metric, c.value, c.threshold, breach.since, now);
        if (event) fired.push(event);
      }
    }

    // A metric that stopped being reported at all (e.g. a service went offline
    // so it has no latency) must not leave a stale breach behind.
    for (const [k, breach] of [...active.entries()]) {
      if (!k.startsWith(`${rule.id}:`)) continue;
      if (seenMetrics.has(breach.metric)) continue;
      const cleared = clearBreach(rule.id, breach.metric, now);
      if (cleared) resolved.push(cleared);
    }
  }

  // Disable a rule and its breach disappears from the active list immediately.
  for (const [k] of [...active.entries()]) {
    const ruleId = k.split(':')[0] ?? '';
    if (!enabled.some((r) => r.id === ruleId)) active.delete(k);
  }

  return { fired, resolved };
}

export function snapshot(rules: readonly AlertRule[], channel: AlertState['channel']): AlertState {
  let activeCount = 0;
  for (const e of events) if (e.resolvedAt === null) activeCount += 1;
  return { rules, events, channel, activeCount };
}

/** Wipes engine state. */
export function resetAlerts(): void {
  active.clear();
  events.length = 0;
}

/**
 * Reloads alert history from SQLite after a restart, so the bell shows what
 * fired before the deploy instead of an empty list.
 *
 * A breach still open when the process died has no live engine state behind
 * it, so it is closed at boot. Otherwise it would show as firing forever.
 */
export function restoreAlertEvents(now: number): number {
  const loaded = loadAlertEvents(MAX_EVENTS);
  events.length = 0;
  for (const e of loaded) {
    if (e.resolvedAt === null) {
      const closed: AlertEvent = { ...e, resolvedAt: now };
      events.push(closed);
      saveAlertEvent(closed);
    } else {
      events.push(e);
    }
  }
  return events.length;
}

export function activeBreachCount(): number {
  return active.size;
}