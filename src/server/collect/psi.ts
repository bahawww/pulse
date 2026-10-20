import fs from 'node:fs';
import type { PsiMetrics } from '../../shared/contract.js';

/**
 * Linux Pressure Stall Information (PSI) from /proc/pressure/{cpu,memory,io}.
 *
 * Each file reports the percentage of wall time over 10s, 60s and 300s that
 * tasks were stalled waiting for the resource:
 *   some avg10=0.00 avg60=0.00 avg300=0.00 total=432440172
 *   full avg10=0.00 avg60=0.00 avg300=0.00 total=0
 */

function parseAvg(raw: string, prefix: 'some' | 'full', window: 'avg10' | 'avg60'): number {
  for (const line of raw.split('\n')) {
    if (!line.startsWith(`${prefix} `)) continue;
    const match = new RegExp(`\\b${window}=([\\d.]+)`).exec(line);
    if (match?.[1]) {
      const val = Number.parseFloat(match[1]);
      return Number.isFinite(val) ? val : 0;
    }
  }
  return 0;
}

function readPressure(resource: 'cpu' | 'memory' | 'io'): string {
  try {
    return fs.readFileSync(`/proc/pressure/${resource}`, 'utf8');
  } catch {
    return '';
  }
}

export function collectPsi(): PsiMetrics {
  const cpu = readPressure('cpu');
  const mem = readPressure('memory');
  const io = readPressure('io');

  return {
    cpuSome10: parseAvg(cpu, 'some', 'avg10'),
    cpuSome60: parseAvg(cpu, 'some', 'avg60'),
    memSome10: parseAvg(mem, 'some', 'avg10'),
    memFull10: parseAvg(mem, 'full', 'avg10'),
    ioSome10: parseAvg(io, 'some', 'avg10'),
    ioFull10: parseAvg(io, 'full', 'avg10'),
  };
}
