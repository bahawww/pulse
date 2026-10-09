import type {
  ContainerSample,
  HistoryPayload,
  HistorySample,
  ProcessSample,
} from '../shared/contract.js';
import { load, persist, wipe as wipeStore } from './store.js';

/**
 * Two-tier rolling history.
 *
 * Why two tiers: a 5-second sample rate is right for the last twenty minutes
 * and wrong for twelve hours. Twelve hours at 5s is 8,640 points — megabytes of
 * JSON for a chart about 1,100px wide, every one of those points invisible at
 * that zoom. So raw 5s samples live in a ring buffer for the short window and
 * are continuously rolled into 1-minute averages that live much longer. A
 * client asking for "15m" gets untouched samples; one asking for "6h" gets
 * minute-resolution averages, and the last few minutes at full detail.
 *
 * The tiers stay in memory because serving a chart must not wait on the disk;
 * SQLite is the durable copy behind them (see store.ts). On boot the recent
 * window is rehydrated from that copy, so a restart resumes the timeline instead
 * of starting an empty one. Rows the store no longer holds are not invented —
 * the chart simply shows the span that exists, which historyStats() reports.
 */

/** 5s sampling x 240 samples = 20 minutes of raw history. */
const RAW_CAPACITY = 240;

/** 1-minute averages, kept long enough to cover a 24h range. */
const ARCHIVE_CAPACITY = 1440;

/**
 * Ignore samples closer together than this.
 *
 * Multiple browser tabs plus the response cache would otherwise bunch samples
 * together. The floor on the interval is what makes the time axis regular.
 */
const MIN_GAP_MS = 4000;

/**
 * Above this, the gap is treated as "nobody was watching".
 *
 * At a ~5s cadence that is roughly three missed samples. Any gap this large
 * means the timeline would be mostly empty, so the buffer restarts instead of
 * stretching one interval across the whole chart.
 */
const MAX_GAP_MS = 30_000;

/** How often raw samples are folded into the archive. */
const ARCHIVE_INTERVAL_MS = 15_000;

const ARCHIVE_BUCKET_MS = 60_000;

/** Row cap when reading the store back. Must cover 24h of 5s rows, or the oldest are cut. */
const STORE_LOAD_LIMIT = 25_000;

/** Above this many points a request gets downsampled. 720 ≈ one point per 1.5px. */
const MAX_POINTS = 720;

const raw: HistorySample[] = [];
const archive: HistorySample[] = [];
let lastArchivedAt = 0;

// ---------------------------------------------------------------------------
// Averaging helpers
//
// Percentages and rates are averaged, never summed — a sum of five CPU readings
// means nothing. Series where a key is absent mean "not measured at that
// instant" (a service that was offline), and those are excluded rather than
// coerced to zero, which would invent a fast response from an absent one.
// ---------------------------------------------------------------------------

function average(values: number[]): number {
  if (values.length === 0) return 0;
  let total = 0;
  for (const v of values) total += v;
  return total / values.length;
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function averageLatency(batch: HistorySample[]): HistorySample['latency'] {
  const m = new Map<string, number[]>();
  for (const s of batch) {
    if (!s.latency) continue;
    for (const [id, ms] of Object.entries(s.latency)) push(m, id, ms);
  }
  if (m.size === 0) return undefined;
  const out: Record<string, number> = {};
  for (const [id, list] of m) out[id] = average(list);
  return out;
}

function averageContainers(batch: HistorySample[]): HistorySample['containers'] {
  const cpu = new Map<string, number[]>();
  const mem = new Map<string, number[]>();
  const names = new Map<string, string>();
  for (const s of batch) {
    if (!s.containers) continue;
    for (const [id, c] of Object.entries(s.containers)) {
      push(cpu, id, c.cpuPercent);
      push(mem, id, c.memBytes);
      names.set(id, c.name);
    }
  }
  if (cpu.size === 0) return undefined;
  const out: Record<string, ContainerSample> = {};
  for (const [id, list] of cpu) {
    out[id] = {
      name: names.get(id) ?? id,
      cpuPercent: average(list),
      memBytes: Math.round(average(mem.get(id) ?? [0])),
    };
  }
  return out;
}

function averageProcesses(batch: HistorySample[]): HistorySample['processes'] {
  const cpu = new Map<string, number[]>();
  const mem = new Map<string, number[]>();
  const names = new Map<string, string>();
  for (const s of batch) {
    if (!s.processes) continue;
    for (const [pid, p] of Object.entries(s.processes)) {
      push(cpu, pid, p.cpuFraction);
      push(mem, pid, p.rssBytes);
      names.set(pid, p.name);
    }
  }
  if (cpu.size === 0) return undefined;
  const out: Record<string, ProcessSample> = {};
  for (const [pid, list] of cpu) {
    out[pid] = {
      name: names.get(pid) ?? pid,
      cpuFraction: average(list),
      rssBytes: Math.round(average(mem.get(pid) ?? [0])),
    };
  }
  return out;
}

/**
 * Collapses a batch of samples into one averaged point.
 *
 * The optional series are spread into the literal rather than assigned onto it
 * afterwards, because HistorySample fields are readonly — building the object
 * in one expression keeps the type honest without weakening it.
 */
function collapse(batch: HistorySample[], t: number): HistorySample {
  const latency = averageLatency(batch);
  const containers = averageContainers(batch);
  const processes = averageProcesses(batch);
  return {
    t,
    cpu: Math.round(average(batch.map((s) => s.cpu))),
    ram: Math.round(average(batch.map((s) => s.ram))),
    disk: Math.round(average(batch.map((s) => s.disk))),
    netRx: Math.round(average(batch.map((s) => s.netRx))),
    netTx: Math.round(average(batch.map((s) => s.netTx))),
    ...(latency ? { latency } : {}),
    ...(containers ? { containers } : {}),
    ...(processes ? { processes } : {}),
  };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Folds aged raw samples into the archive.
 *
 * Only samples older than one archive interval are moved, so a sample is never
 * archived twice, and it is removed from the raw tier as it is archived so the
 * same instant is not represented at two resolutions.
 */
function rollArchive(now: number): void {
  if (now - lastArchivedAt < ARCHIVE_INTERVAL_MS) return;
  lastArchivedAt = now;

  const cutoff = now - ARCHIVE_INTERVAL_MS - MIN_GAP_MS;
  // Walk from the OLDEST end, stopping at the first sample that is still
  // current. Walking from the newest end and breaking on the first miss looks
  // equivalent but never matches anything: the newest sample is by definition
  // newer than the cutoff, so the loop broke immediately every time and the
  // archive stayed empty forever. Oldest-first is also the correct assumption,
  // because `record` appends in time order.
  const stale: HistorySample[] = [];
  for (const s of raw) {
    if (s.t > cutoff) break;
    stale.push(s);
  }
  if (stale.length === 0) return;
  raw.splice(0, stale.length);

  // Bucket start, so the timestamp says which minute it represents.
  const bucketStart = Math.floor(now / ARCHIVE_BUCKET_MS) * ARCHIVE_BUCKET_MS;
  const previous = archive[archive.length - 1];
  const t = previous && bucketStart <= previous.t ? previous.t + ARCHIVE_BUCKET_MS : bucketStart;

  archive.push(collapse(stale, t));
  if (archive.length > ARCHIVE_CAPACITY) archive.splice(0, archive.length - ARCHIVE_CAPACITY);
}

export interface RecordInput {
  readonly system: HistorySample & { readonly t: number };
  readonly latency?: Readonly<Record<string, number>>;
  readonly containers?: Readonly<Record<string, ContainerSample>>;
  readonly processes?: Readonly<Record<string, ProcessSample>>;
}

/**
 * Adds one sample.
 *
 * The caller owns the fixed 5s cadence. Sampling was previously a side effect
 * of the /api/stats request, which meant the gap between samples was however
 * long the browser waited between polls — seconds while a tab was open, hours
 * when nobody was — and the chart drew that hole as a vertical spike, which is
 * what made it look like noise.
 */
export function record(input: RecordInput): void {
  const { system } = input;
  const now = system.t;
  const last = raw[raw.length - 1];

  if (last) {
    const gap = now - last.t;

    // Too soon: a burst is not a trend. Keep the newer reading.
    if (gap < MIN_GAP_MS) {
      const replaced = build(system, input);
      raw[raw.length - 1] = replaced;
      persist(replaced);
      return;
    }

    // A hole: we know nothing about the interval, so start a fresh window
    // rather than drawing a cliff across it. Must happen BEFORE the push,
    // otherwise it would wipe the sample just added.
    if (gap > MAX_GAP_MS) {
      raw.length = 0;
      archive.length = 0;
      lastArchivedAt = 0;
      // The in-memory window restarts so the chart draws a gap instead of a
      // cliff, but the stored history is NOT wiped: those rows are real
      // measurements and a process restart must not delete them.
    }
  }

  const sample = build(system, input);
  raw.push(sample);
  if (raw.length > RAW_CAPACITY) raw.splice(0, raw.length - RAW_CAPACITY);
  // Durable copy. Best-effort by design: a storage failure must not stop the
  // live sampler, and store.ts swallows its own errors.
  persist(sample);
  rollArchive(now);
}

/**
 * Assembles a sample. Empty optional series are omitted rather than attached as
 * `{}`, because an empty object reads as "measured, and there was nothing there"
 * which is a different claim from "not measured".
 */
function build(system: RecordInput['system'], input: RecordInput): HistorySample {
  return {
    ...system,
    ...(input.latency && Object.keys(input.latency).length > 0 ? { latency: { ...input.latency } } : {}),
    ...(input.containers && Object.keys(input.containers).length > 0
      ? { containers: { ...input.containers } }
      : {}),
    ...(input.processes && Object.keys(input.processes).length > 0
      ? { processes: { ...input.processes } }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Total window currently servable, raw and archive combined. */
export function maxSpanMs(): number {
  const oldest = archive.length > 0 ? archive[0] : raw[0];
  if (!oldest) return 0;
  return Math.max(0, Date.now() - oldest.t);
}

export interface HistoryStats {
  readonly rawCount: number;
  readonly archiveCount: number;
  readonly maxSpanMs: number;
  readonly bucketCount: number;
}

/** Introspection for the UI's storage line and for tests. */
export function historyStats(): HistoryStats {
  return {
    rawCount: raw.length,
    archiveCount: archive.length,
    maxSpanMs: maxSpanMs(),
    bucketCount: Math.max(raw.length, archive.length),
  };
}

/**
 * Serves a window at a resolution the requested range can actually use.
 *
 * Short ranges keep raw 5s samples. Long ranges are downsampled to 1-minute
 * averages so the payload stays in the hundreds of KB instead of the megabytes
 * a full-resolution 12-hour series would cost.
 */
export function query(windowMs: number): HistoryPayload {
  const now = Date.now();
  rollArchive(now);
  const cutoff = now - windowMs;

  const rawInWindow = raw.filter((s) => s.t >= cutoff);
  const archiveInWindow = archive.filter((s) => s.t >= cutoff);

  // After a sampling hole the in-memory window restarts, but SQLite still holds
  // the older rows. Backfill them, otherwise a 15m view can show 4 samples while
  // an hour of real measurements sits on disk.
  // A narrow window is served from the raw tier alone, so only raw coverage
  // counts. Archive rows (minute averages) cannot stand in for 5s samples there.
  const rawStart = rawInWindow[0]?.t ?? Number.POSITIVE_INFINITY;
  const archiveStart = archiveInWindow[0]?.t ?? Number.POSITIVE_INFINITY;
  const wide = windowMs / MIN_GAP_MS > MAX_POINTS;
  const memStart = wide ? Math.min(rawStart, archiveStart) : rawStart;
  const stored =
    memStart - cutoff > MIN_GAP_MS * 2
      ? load(cutoff, Math.min(memStart, now) - 1, STORE_LOAD_LIMIT)
      : [];

  // At full resolution this window would hold more points than a wide chart can
  // show, so average instead. `truncated` then tells the UI the visible span is
  // shorter than what was asked for.
  const fullResCount = rawInWindow.length + stored.length;
  const downsample = fullResCount > MAX_POINTS || windowMs / MIN_GAP_MS > MAX_POINTS;

  let bucketMs = MIN_GAP_MS;
  let merged: HistorySample[];

  if (downsample) {
    bucketMs = ARCHIVE_BUCKET_MS;
    // The archive holds the older minutes; the raw tier holds the newest ones,
    // which the archive has not reached yet. Together they cover the window at
    // two resolutions rather than a single uniform one — a recent 5s dip should
    // not be averaged away by a 6h view.
    merged = [...stored, ...archiveInWindow, ...rawInWindow];
  } else {
    merged = [...stored, ...rawInWindow];
  }

  merged.sort((a, b) => a.t - b.t);

  const bucketed = downsample ? bucketBy(merged, bucketMs, cutoff) : merged;
  const first = bucketed[0];
  const last = bucketed[bucketed.length - 1];

  return {
    samples: bucketed,
    spanMs: first && last ? last.t - first.t : 0,
    complete: bucketed.length > 1,
    intervalSec: Math.round(bucketMs / 1000),
    maxSpanMs: maxSpanMs(),
    truncated: downsample,
  };
}

/** Fixed-width bucketing. Buckets with no samples are omitted, not zero-filled. */
function bucketBy(samples: HistorySample[], bucketMs: number, cutoff: number): HistorySample[] {
  const groups = new Map<number, HistorySample[]>();
  for (const s of samples) {
    const key = Math.floor(s.t / bucketMs) * bucketMs;
    const list = groups.get(key);
    if (list) list.push(s);
    else groups.set(key, [s]);
  }

  const out: HistorySample[] = [];
  for (const [t, list] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    if (t < cutoff) continue;
    out.push(collapse(list, t));
  }
  return out;
}

/** Default view used by anything that has not chosen a range. */
export function getHistory(): HistoryPayload {
  return query(20 * 60_000);
}

/**
 * Wipes both tiers and the durable copy.
 *
 * This is an explicit reset, not the gap-handling path above, so it does clear
 * storage — otherwise a "clear history" that left the database untouched would
 * reappear in full on the next boot.
 */
export function clearHistory(): void {
  raw.length = 0;
  archive.length = 0;
  lastArchivedAt = 0;
  wipeStore();
}

/**
 * Rehydrates the in-memory tiers from the durable store.
 *
 * Called once at boot. The last RAW_CAPACITY rows go back into the raw tier and
 * the older ones are collapsed into minute buckets for the archive, so the
 * 5m/15m/1h/6h/12h ranges have something to serve immediately instead of filling
 * in only as new samples arrive.
 *
 * Returns how many samples were restored, for the startup log.
 */
export function rehydrate(): number {
  if (raw.length > 0 || archive.length > 0) return 0;

  const until = Date.now();
  const since = until - Math.max(RAW_CAPACITY, ARCHIVE_CAPACITY) * ARCHIVE_BUCKET_MS;
  const stored = load(since, until, STORE_LOAD_LIMIT);
  if (stored.length === 0) return 0;

  // Split at the boundary the archive owns: anything older than one archive
  // interval belongs in the minute tier, the rest keeps full resolution.
  const boundary = until - ARCHIVE_INTERVAL_MS - MIN_GAP_MS;
  const older: HistorySample[] = [];
  const recent: HistorySample[] = [];
  for (const s of stored) {
    if (s.t > boundary) recent.push(s);
    else older.push(s);
  }

  raw.push(...recent);
  if (raw.length > RAW_CAPACITY) raw.splice(0, raw.length - RAW_CAPACITY);

  // Bucket the older rows by minute so the long ranges are served at the same
  // resolution they will be served at later.
  const minuteRows = bucketBy(older, ARCHIVE_BUCKET_MS, since);
  archive.push(...minuteRows);
  if (archive.length > ARCHIVE_CAPACITY) archive.splice(0, archive.length - ARCHIVE_CAPACITY);

  // The newest row is already current, so rollArchive would refuse to run until
  // the next interval. Seeding lastArchivedAt from the newest stored row keeps
  // the archive rolling on schedule after a boot.
  lastArchivedAt = stored[stored.length - 1]?.t ?? 0;

  return stored.length;
}

export const HISTORY_CAPACITY = RAW_CAPACITY;