import os from 'node:os';
import type { SystemMetrics } from '../../shared/contract.js';
import { collectCpu } from './cpu.js';
import { collectDisk, collectDiskIo, collectNet } from './disk.js';
import { collectDocker } from './docker.js';
import { collectFilesystems } from './filesystems.js';
import { collectMemory } from './memory.js';
import { collectProcesses } from './processes.js';

/**
 * Assembles the full system snapshot.
 *
 * Every collector is independent and failure-tolerant: a missing procfs file or
 * an unreachable Docker socket degrades ONE panel instead of failing the whole
 * payload. Whatever failed is named in `degraded` so the UI can say so rather
 * than silently rendering an empty chart.
 */

let lastSampleAt = Date.now();

export async function getSystemSnapshot(): Promise<SystemMetrics> {
  const degraded: string[] = [];
  const now = Date.now();
  const elapsed = (now - lastSampleAt) / 1000;
  lastSampleAt = now;

  const cpus = os.cpus();
  const model = cpus[0]?.model ?? 'unknown';

  const cpu = await collectCpu(model, cpus.length || 1);
  if (cpu.perCore.length === 0) degraded.push('cpu');

  const memory = collectMemory();
  if (memory.totalBytes === 0) degraded.push('memory');

  const disk = collectDisk('/');
  if (disk.totalBytes === 0) degraded.push('disk');

  let net: SystemMetrics['net'] = [];
  try {
    net = collectNet();
    if (net.length === 0) degraded.push('network');
  } catch {
    degraded.push('network');
  }

  let diskIo: SystemMetrics['diskIo'] = [];
  try {
    diskIo = collectDiskIo();
  } catch {
    degraded.push('disk-io');
  }

  let processes: SystemMetrics['processes'] = [];
  try {
    // Pass the real elapsed window so tick deltas become true per-second rates.
    processes = collectProcesses(Math.max(elapsed, 0.001));
  } catch {
    degraded.push('processes');
  }

  let docker: SystemMetrics['docker'] = [];
  try {
    docker = await collectDocker();
  } catch {
    degraded.push('docker');
  }

  // Every real filesystem, with inode accounting. Reported separately from the
  // primary `disk` metric so the main gauge keeps its stable meaning (the root
  // volume) while this list covers the mounts a single `df /` would miss.
  let filesystems: SystemMetrics['filesystems'] = [];
  try {
    filesystems = collectFilesystems();
    if (filesystems.length === 0) degraded.push('filesystems');
  } catch {
    degraded.push('filesystems');
  }

  return {
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()} (${os.arch()})`,
    kernel: os.release(),
    uptime: Math.floor(os.uptime()),
    cpu,
    memory,
    disk,
    net,
    diskIo,
    processes,
    docker,
    filesystems,
    degraded,
    serverTime: new Date().toISOString(),
  };
}