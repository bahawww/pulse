import { type JSX, useMemo } from 'react';
import type { FilesystemInfo } from '../shared/contract';
import { formatBytes, formatPercent } from '../lib/format';

/**
 * Every real mount, with bytes and inodes. Inodes get their own number because
 * a disk at 40% bytes can still refuse new files, and nothing reports that
 * until a write fails.
 */

interface FilesystemPanelProps {
  readonly filesystems: readonly FilesystemInfo[];
  readonly rootMount: string;
  readonly rootInodePercent: number;
}

const INODE_WARN = 80;

function tone(percent: number): string {
  if (percent >= 90) return 'is-crit';
  if (percent >= 75) return 'is-warn';
  return '';
}

export function FilesystemPanel({ filesystems, rootMount }: FilesystemPanelProps): JSX.Element {
  const rows = useMemo(
    () =>
      [...filesystems].sort((a, b) => {
        if (a.mount === rootMount) return -1;
        if (b.mount === rootMount) return 1;
        return b.percent - a.percent;
      }),
    [filesystems, rootMount],
  );

  return (
    <section className="card" aria-labelledby="fs-h">
      <div className="card-head">
        <div>
          <h3 id="fs-h" className="card-title">
            Storage
          </h3>
          <p className="card-sub">{filesystems.length} mounted filesystems</p>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="empty">No filesystems reported.</p>
      ) : (
        <div>
          {rows.map((fs) => {
            const inodesHigh = fs.inodeTotal > 0 && fs.inodePercent >= INODE_WARN;
            return (
              <div className="fs-row" key={fs.mount}>
                <div style={{ minWidth: 0 }}>
                  <div className="fs-name" title={fs.mount}>
                    {fs.mount}
                    {fs.mount === rootMount && <span className="tag" style={{ marginLeft: 8 }}>root</span>}
                  </div>
                  <div className="fs-meta" title={fs.device}>
                    {fs.device} · {fs.fstype}
                  </div>
                </div>
                <div className="fs-pct">{formatPercent(fs.percent)}%</div>
                <div className="meter" aria-hidden="true">
                  <div
                    className={`meter-fill ${tone(fs.percent)}`}
                    style={{ width: `${Math.min(fs.percent, 100)}%`, background: tone(fs.percent) ? undefined : 'var(--s-disk)' }}
                  />
                </div>
                <div className="fs-meta">
                  {formatBytes(fs.usedBytes)} of {formatBytes(fs.totalBytes)} · {formatBytes(fs.availableBytes)} free
                </div>
                <div className="fs-meta" style={{ textAlign: 'right', color: inodesHigh ? 'var(--warn)' : undefined }}>
                  {fs.inodeTotal > 0 ? `inodes ${formatPercent(fs.inodePercent)}%` : 'inodes —'}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
