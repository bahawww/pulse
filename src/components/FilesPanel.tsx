import { type DragEvent, type FormEvent, type JSX, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FileEntry, FileListing, FilePreview } from '../shared/contract';
import { formatDay, formatClock } from '../shared/time';
import { formatBytes } from '../lib/format';
import { ensureCsrf, postJson, setCsrf } from '../lib/csrf';
import { ConfirmDialog } from './ConfirmDialog';
import { Bone, Loading } from './Skeleton';
import {
  ArrowUpIcon,
  DownloadIcon,
  FileIcon,
  FolderIcon,
  FolderPlusIcon,
  HomeIcon,
  LinkIcon,
  PencilIcon,
  RefreshIcon,
  TrashIcon,
  UploadIcon,
  EyeIcon,
  EyeOffIcon,
} from './icons';

/**
 * File explorer for the VPS: browse folders, preview text and images, download,
 * upload (button or drag and drop), new folder, rename, delete.
 *
 * Everything runs on the server as the SSH login user (src/server/files.ts),
 * so it can reach exactly what a shell could, without sudo.
 */

interface FilesPanelProps {
  readonly onNotify: (message: string) => void;
  /** Upload, new folder, rename, delete: the files:write permission. Without it the panel is read-only. */
  readonly canWrite: boolean;
}

type SortKey = 'name' | 'size' | 'mtime';

interface Upload {
  readonly id: number;
  readonly name: string;
  readonly total: number;
  loaded: number;
  status: 'up' | 'done' | 'error';
  error?: string;
}

// Tailwind runs without preflight (src/tailwind.css), so bare buttons and lists
// here start from browser defaults and reset themselves.
const BARE_BUTTON = 'tw:m-0 tw:appearance-none tw:border-0 tw:bg-transparent tw:p-0 tw:text-inherit';
const BARE_LIST = 'tw:m-0 tw:list-none tw:p-0';

const PATH_KEY = 'pulse_files_path';
const HIDDEN_KEY = 'pulse_files_hidden';
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|ico)$/i;

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}

function join(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

function parent(dir: string): string {
  const cut = dir.lastIndexOf('/');
  return cut <= 0 ? '/' : dir.slice(0, cut);
}

function stamp(ms: number): string {
  return ms > 0 ? `${formatDay(ms)} ${formatClock(ms, false)}` : '—';
}

/** Opens as a folder: a directory, or a symlink to one. */
function isFolder(e: FileEntry): boolean {
  return e.kind === 'dir' || (e.kind === 'link' && e.target === 'dir');
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store', headers: { Accept: 'application/json' } });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

async function postOrThrow(url: string, body: unknown): Promise<void> {
  const res = await postJson(url, body);
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
}

/** XHR, not fetch: fetch cannot report upload progress. Retries once on a stale CSRF token. */
function sendFile(dir: string, file: File, overwrite: boolean, onProgress: (loaded: number) => void): Promise<number> {
  const attempt = (token: string) =>
    new Promise<{ status: number; error?: string; code?: string }>((resolve) => {
      const xhr = new XMLHttpRequest();
      const q = new URLSearchParams({ dir, name: file.name, ...(overwrite ? { overwrite: '1' } : {}) });
      xhr.open('POST', `/api/files/upload?${q.toString()}`);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.setRequestHeader('X-CSRF-Token', token);
      xhr.upload.onprogress = (e) => onProgress(e.loaded);
      xhr.onload = () => {
        let body: { error?: string; code?: string } = {};
        try {
          body = JSON.parse(xhr.responseText) as typeof body;
        } catch {
          /* not JSON */
        }
        resolve({ status: xhr.status, ...body });
      };
      xhr.onerror = () => resolve({ status: 0, error: 'network error' });
      xhr.send(file);
    });
  return (async () => {
    let r = await attempt((await ensureCsrf()) ?? '');
    if (r.status === 403 && r.code === 'csrf') {
      setCsrf(null);
      r = await attempt((await ensureCsrf()) ?? '');
    }
    if (r.status === 409) return 409;
    if (r.status < 200 || r.status >= 300) throw new Error(r.error ?? `HTTP ${r.status}`);
    return r.status;
  })();
}

export function FilesPanel({ onNotify, canWrite }: FilesPanelProps): JSX.Element {
  const [listing, setListing] = useState<FileListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(() => readStored(HIDDEN_KEY) === '1');
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 });
  const [selected, setSelected] = useState<FileEntry | null>(null);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editingPath, setEditingPath] = useState(false);
  const [toDelete, setToDelete] = useState<FileEntry | null>(null);
  const [conflict, setConflict] = useState<File[]>([]);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadId = useRef(0);
  const requestId = useRef(0);
  // After the first listing, a folder change replays only a short cascade, not the view entrance.
  const [navigated, setNavigated] = useState(false);
  const loadedOnce = useRef(false);

  const dir = listing?.path ?? null;

  const open = useCallback(async (path: string | null) => {
    const id = ++requestId.current;
    setLoading(true);
    try {
      const next = await getJson<FileListing>(`/api/files/list${path ? `?path=${encodeURIComponent(path)}` : ''}`);
      if (id !== requestId.current) return;
      if (loadedOnce.current) setNavigated(true);
      loadedOnce.current = true;
      setListing(next);
      setError(null);
      setSelected(null);
      setFilter('');
      setRenaming(null);
      setCreating(false);
      store(PATH_KEY, next.path);
    } catch (err) {
      if (id !== requestId.current) return;
      setError(err instanceof Error ? err.message : 'cannot open folder');
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, []);

  // Start where the last visit ended, else home.
  useEffect(() => {
    void open(readStored(PATH_KEY)).then(() => undefined);
  }, [open]);

  // A stored folder that is gone (or now forbidden) falls back to home once.
  const triedHome = useRef(false);
  useEffect(() => {
    if (error && !listing && !triedHome.current) {
      triedHome.current = true;
      void open(null);
    }
  }, [error, listing, open]);

  // Reloads the folder on screen now. Bound to `dir` at render, an upload that
  // finished after you moved on reloaded, and so went back to, its own folder.
  const dirRef = useRef(dir);
  dirRef.current = dir;
  const refresh = useCallback(() => {
    if (dirRef.current) void open(dirRef.current);
  }, [open]);

  // Preview the selected file: images straight from download, text via preview.
  useEffect(() => {
    setPreview(null);
    setPreviewError(null);
    if (!selected || !dir || isFolder(selected) || IMAGE_EXT.test(selected.name)) return undefined;
    let live = true;
    getJson<FilePreview>(`/api/files/preview?path=${encodeURIComponent(join(dir, selected.name))}`)
      .then((p) => live && setPreview(p))
      .catch((err: unknown) => live && setPreviewError(err instanceof Error ? err.message : 'no preview'));
    return () => {
      live = false;
    };
  }, [selected, dir]);

  const entries = useMemo(() => {
    const all = listing?.entries ?? [];
    const needle = filter.trim().toLowerCase();
    return all
      .filter((e) => showHidden || !e.name.startsWith('.'))
      .filter((e) => !needle || e.name.toLowerCase().includes(needle))
      .sort((a, b) => {
        const folders = Number(isFolder(b)) - Number(isFolder(a));
        if (folders !== 0) return folders;
        const by =
          sort.key === 'size' ? a.size - b.size : sort.key === 'mtime' ? a.mtime - b.mtime : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
        return by * sort.dir;
      });
  }, [listing, filter, showHidden, sort]);

  const hiddenCount = (listing?.entries ?? []).filter((e) => e.name.startsWith('.')).length;

  const toggleHidden = () => {
    setShowHidden((v) => {
      store(HIDDEN_KEY, v ? '0' : '1');
      return !v;
    });
  };

  const sortBy = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === 'name' ? 1 : -1 }));

  // ---- uploads
  const upload = useCallback(
    async (files: File[], overwrite = false) => {
      if (!dir || files.length === 0) return;
      const clashes: File[] = [];
      for (const file of files) {
        const id = ++uploadId.current;
        setUploads((u) => [...u, { id, name: file.name, total: file.size, loaded: 0, status: 'up' }]);
        const patch = (p: Partial<Upload>) => setUploads((u) => u.map((x) => (x.id === id ? { ...x, ...p } : x)));
        try {
          const status = await sendFile(dir, file, overwrite, (loaded) => patch({ loaded }));
          if (status === 409) {
            clashes.push(file);
            setUploads((u) => u.filter((x) => x.id !== id));
          } else patch({ loaded: file.size, status: 'done' });
        } catch (err) {
          patch({ status: 'error', error: err instanceof Error ? err.message : 'failed' });
        }
      }
      if (clashes.length > 0) setConflict(clashes);
      refresh();
      // Finished rows clear themselves; failed ones stay until dismissed.
      setTimeout(() => setUploads((u) => u.filter((x) => x.status !== 'done')), 2500);
    },
    [dir, refresh],
  );

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void upload([...e.dataTransfer.files]);
  };

  // ---- writes
  const mkdir = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const name = String(new FormData(e.currentTarget).get('name') ?? '').trim();
    if (!dir || !name) return setCreating(false);
    try {
      await postOrThrow('/api/files/mkdir', { dir, name });
      onNotify(`Created ${name}`);
      refresh();
    } catch (err) {
      onNotify(`Could not create folder: ${err instanceof Error ? err.message : 'failed'}`);
    }
  };

  const rename = async (entry: FileEntry, name: string) => {
    setRenaming(null);
    if (!dir || !name || name === entry.name) return;
    try {
      await postOrThrow('/api/files/rename', { path: join(dir, entry.name), name });
      onNotify(`Renamed to ${name}`);
      refresh();
    } catch (err) {
      onNotify(`Could not rename: ${err instanceof Error ? err.message : 'failed'}`);
    }
  };

  const remove = async () => {
    const entry = toDelete;
    setToDelete(null);
    if (!dir || !entry) return;
    try {
      await postOrThrow('/api/files/delete', { path: join(dir, entry.name) });
      onNotify(`Deleted ${entry.name}`);
      if (selected?.name === entry.name) setSelected(null);
      refresh();
    } catch (err) {
      onNotify(`Could not delete: ${err instanceof Error ? err.message : 'failed'}`);
    }
  };

  const downloadUrl = (name: string, inline = false) =>
    dir ? `/api/files/download?path=${encodeURIComponent(join(dir, name))}${inline ? '&inline=1' : ''}` : '#';

  // ---- breadcrumbs
  const crumbs = useMemo(() => {
    if (!dir) return [];
    const parts = dir.split('/').filter(Boolean);
    return [{ label: '/', path: '/' }, ...parts.map((p, i) => ({ label: p, path: `/${parts.slice(0, i + 1).join('/')}` }))];
  }, [dir]);

  const goTo = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const value = String(new FormData(e.currentTarget).get('path') ?? '').trim();
    setEditingPath(false);
    if (value.startsWith('/')) void open(value);
  };

  return (
    <section className="card" aria-labelledby="files-h">
      <div className="toolbar">
        <div>
          <h3 id="files-h" className="card-title">
            Files
          </h3>
          <p className="card-sub">Runs as the server's login user, with that user's permissions. {canWrite ? ' Drop files here to upload.' : ' Read-only for your account.'}</p>
        </div>
        <div className={`tw:flex-wrap tw:items-center tw:gap-2 ${canWrite ? 'tw:flex' : 'tw:hidden'}`}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCreating(true)} disabled={!dir}>
            <FolderPlusIcon size={14} />
            New folder
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => fileInput.current?.click()} disabled={!dir}>
            <UploadIcon size={14} />
            Upload
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              void upload([...(e.target.files ?? [])]);
              e.target.value = '';
            }}
          />
        </div>
      </div>

      {/* Path bar: up, home, refresh, then the breadcrumb (click it to type a path). */}
      <div className="files-bar tw:flex tw:min-w-0 tw:items-center tw:gap-2">
        <button type="button" className="btn btn-icon btn-sm" onClick={() => dir && void open(parent(dir))} disabled={!dir || dir === '/'} aria-label="Up one folder" title="Up">
          <ArrowUpIcon size={14} />
        </button>
        <button type="button" className="btn btn-icon btn-sm" onClick={() => listing && void open(listing.home)} disabled={!listing} aria-label="Home folder" title="Home">
          <HomeIcon size={14} />
        </button>
        <button type="button" className="btn btn-icon btn-sm" onClick={refresh} disabled={!dir} aria-label="Refresh" title="Refresh">
          <RefreshIcon size={14} />
        </button>
        {editingPath ? (
          <form onSubmit={goTo} className="tw:min-w-0 tw:flex-1">
            <input
              name="path"
              defaultValue={dir ?? ''}
              autoFocus
              spellCheck={false}
              onBlur={() => setEditingPath(false)}
              onKeyDown={(e) => e.key === 'Escape' && setEditingPath(false)}
              aria-label="Go to path"
              className="tw:w-full tw:rounded-md tw:border tw:border-line-strong tw:bg-surface-2 tw:px-3 tw:py-1.5 tw:font-mono tw:text-[13px] tw:text-fg tw:outline-none"
            />
          </form>
        ) : (
          <nav
            aria-label="Current folder"
            onDoubleClick={() => setEditingPath(true)}
            className="tw:flex tw:min-w-0 tw:flex-1 tw:items-center tw:overflow-x-auto tw:rounded-md tw:border tw:border-line tw:bg-surface-2 tw:px-2 tw:py-1 tw:font-mono tw:text-[13px] tw:whitespace-nowrap"
          >
            {crumbs.map((c, i) => (
              <span key={c.path} className="tw:flex tw:items-center">
                {i > 1 && <span className="tw:px-0.5 tw:text-fg-2">/</span>}
                <button
                  type="button"
                  onClick={() => void open(c.path)}
                  className={`${BARE_BUTTON} tw:cursor-pointer tw:rounded tw:px-1 tw:py-0.5 tw:text-fg-2 tw:hover:bg-surface-3 tw:hover:text-fg`}
                >
                  {c.label}
                </button>
              </span>
            ))}
            <button type="button" onClick={() => setEditingPath(true)} className={`${BARE_BUTTON} tw:ml-auto tw:cursor-pointer tw:pl-2 tw:text-[11px] tw:text-fg-2 tw:hover:text-fg`}>
              edit
            </button>
          </nav>
        )}
      </div>

      <div className="tw:flex tw:items-center tw:gap-2">
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter this folder"
          aria-label="Filter this folder"
          className="tw:min-w-0 tw:flex-1 tw:appearance-none tw:rounded-md tw:border tw:border-line tw:bg-transparent tw:px-3 tw:py-1.5 tw:text-[13px] tw:text-fg tw:outline-none tw:placeholder:text-fg-3 tw:focus:border-line-strong"
        />
        {hiddenCount > 0 && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={toggleHidden} aria-pressed={showHidden}>
            {showHidden ? <EyeIcon size={13} /> : <EyeOffIcon size={13} />}
            {showHidden ? 'Hide' : 'Show'} {hiddenCount} hidden
          </button>
        )}
      </div>

      {uploads.length > 0 && (
        <ul className={`files-uploads ${BARE_LIST} tw:flex tw:flex-col tw:gap-1.5`} aria-label="Uploads">
          {uploads.map((u) => (
            <li key={u.id} className="tw:flex tw:items-center tw:gap-3 tw:text-[12px]">
              <span className="tw:w-40 tw:truncate tw:text-fg-2">{u.name}</span>
              <span className="tw:h-1 tw:flex-1 tw:overflow-hidden tw:rounded tw:bg-line">
                <span
                  className={`tw:block tw:h-full tw:origin-left tw:transition-transform tw:duration-200 ${u.status === 'error' ? 'tw:bg-crit' : u.status === 'done' ? 'tw:bg-ok' : 'tw:bg-accent'}`}
                  style={{ transform: `scaleX(${u.total > 0 ? u.loaded / u.total : 1})` }}
                />
              </span>
              <span className={`tw:w-28 tw:text-right tw:font-mono ${u.status === 'error' ? 'tw:text-crit-text' : 'tw:text-fg-3'}`}>
                {u.status === 'error' ? (u.error ?? 'failed') : u.status === 'done' ? 'done' : `${formatBytes(u.loaded)}`}
              </span>
              {u.status === 'error' && (
                <button type="button" className="btn btn-icon btn-sm" aria-label="Dismiss" onClick={() => setUploads((x) => x.filter((y) => y.id !== u.id))}>
                  ✕
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className={`tw:grid tw:gap-4 ${selected && !isFolder(selected) ? 'tw:wide:grid-cols-[minmax(0,1fr)_380px]' : ''}`}>
        <div
          onDragOver={(e) => {
            if (!canWrite) return;
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
          }}
          onDrop={canWrite ? onDrop : undefined}
          className={`tw:relative tw:min-w-0 tw:overflow-hidden tw:rounded-lg tw:border ${dragging ? 'tw:border-accent tw:bg-accent-soft' : 'tw:border-line'}`}
        >
          {dragging && (
            <div className="tw:pointer-events-none tw:absolute tw:inset-0 tw:z-10 tw:grid tw:place-items-center tw:text-[13px] tw:text-fg">
              Drop to upload into {dir}
            </div>
          )}

          <div className="tw:grid tw:grid-cols-[minmax(0,1fr)_88px_150px_104px] tw:items-center tw:gap-3 tw:border-b tw:border-line tw:px-3 tw:py-2 tw:text-[11px] tw:font-semibold tw:tracking-wide tw:text-fg-2 tw:uppercase tw:max-sm:grid-cols-[minmax(0,1fr)_104px]">
            {(['name', 'size', 'mtime'] as const).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => sortBy(key)}
                className={`${BARE_BUTTON} tw:cursor-pointer tw:text-left tw:tracking-wide tw:uppercase tw:hover:text-fg-2 ${key === 'size' ? 'tw:text-right tw:max-sm:hidden' : ''} ${key === 'mtime' ? 'tw:max-sm:hidden' : ''} ${sort.key === key ? 'tw:text-fg-2' : ''}`}
                aria-label={`Sort by ${key === 'mtime' ? 'modified' : key}`}
              >
                {key === 'mtime' ? 'Modified' : key === 'size' ? 'Size' : 'Name'}
                {sort.key === key && <span aria-hidden="true">{sort.dir === 1 ? ' ↑' : ' ↓'}</span>}
              </button>
            ))}
            <span />
          </div>

          {creating && (
            <form onSubmit={(e) => void mkdir(e)} className="tw:flex tw:items-center tw:gap-2 tw:border-b tw:border-line tw:px-3 tw:py-2">
              <FolderIcon size={16} className="tw:shrink-0 tw:text-fg-2" />
              <input
                name="name"
                autoFocus
                placeholder="Folder name"
                onKeyDown={(e) => e.key === 'Escape' && setCreating(false)}
                onBlur={(e) => !e.currentTarget.value && setCreating(false)}
                className="tw:min-w-0 tw:flex-1 tw:rounded tw:border tw:border-line-strong tw:bg-surface-2 tw:px-2 tw:py-1 tw:text-[13px] tw:text-fg tw:outline-none"
              />
              <button type="submit" className="btn btn-sm">
                Create
              </button>
            </form>
          )}

          {loading && !listing ? (
            <Loading what="files">
              <div className="tw:flex tw:flex-col tw:gap-2 tw:p-3">
                {Array.from({ length: 8 }, (_, i) => (
                  <Bone key={i} h={18} w={`${40 + ((i * 17) % 45)}%`} />
                ))}
              </div>
            </Loading>
          ) : error && !listing ? (
            <p className="empty">{error}</p>
          ) : (
            <>
              {error && <p className="tw:border-b tw:border-line tw:px-3 tw:py-2 tw:text-[12px] tw:text-crit-text">{error}</p>}
              {entries.length === 0 ? (
                <p className="empty">{filter ? 'Nothing matches the filter.' : 'This folder is empty.'}</p>
              ) : (
                // Keyed by folder: opening another one replays the row cascade (motion.css).
                <ul
                  key={dir ?? ''}
                  className={`files-list${navigated ? ' is-nav' : ''} ${BARE_LIST} tw:max-h-[60vh] tw:overflow-y-auto tw:transition-opacity tw:duration-200 ${loading ? 'tw:opacity-60' : ''}`}
                >
                  {entries.map((e) => {
                    const folder = isFolder(e);
                    const active = selected?.name === e.name;
                    return (
                      <li
                        key={e.name}
                        className={`tw:group tw:grid tw:grid-cols-[minmax(0,1fr)_88px_150px_104px] tw:items-center tw:gap-3 tw:border-b tw:border-line tw:px-3 tw:py-2 tw:text-[13px] tw:transition-colors tw:duration-150 tw:last:border-b-0 tw:hover:bg-surface-3 tw:max-sm:grid-cols-[minmax(0,1fr)_104px] ${active ? 'tw:bg-accent-soft' : ''}`}
                      >
                        {renaming === e.name ? (
                          <form
                            onSubmit={(ev) => {
                              ev.preventDefault();
                              void rename(e, String(new FormData(ev.currentTarget).get('name') ?? '').trim());
                            }}
                            className="tw:min-w-0"
                          >
                            <input
                              name="name"
                              defaultValue={e.name}
                              autoFocus
                              onFocus={(ev) => ev.currentTarget.setSelectionRange(0, e.name.lastIndexOf('.') > 0 ? e.name.lastIndexOf('.') : e.name.length)}
                              onKeyDown={(ev) => ev.key === 'Escape' && setRenaming(null)}
                              onBlur={() => setRenaming(null)}
                              aria-label={`New name for ${e.name}`}
                              className="tw:w-full tw:rounded tw:border tw:border-line-strong tw:bg-surface-3 tw:px-2 tw:py-0.5 tw:text-[13px] tw:text-fg tw:outline-none"
                            />
                          </form>
                        ) : (
                          <button
                            type="button"
                            onClick={() => (folder && dir ? void open(join(dir, e.name)) : setSelected(active ? null : e))}
                            className={`${BARE_BUTTON} tw:flex tw:min-w-0 tw:cursor-pointer tw:items-center tw:gap-2.5 tw:text-left`}
                            title={e.kind === 'link' ? `${e.name} (link)` : e.name}
                          >
                            {folder ? (
                              <FolderIcon size={16} className="tw:shrink-0 tw:text-accent" />
                            ) : (
                              <FileIcon size={16} className="tw:shrink-0 tw:text-fg-2" />
                            )}
                            <span className={`tw:truncate ${e.name.startsWith('.') ? 'tw:text-fg-2' : 'tw:text-fg'}`}>{e.name}</span>
                            {e.kind === 'link' && (
                              <span className="tw:shrink-0 tw:text-fg-2" aria-label="symbolic link">
                                <LinkIcon size={11} />
                              </span>
                            )}
                          </button>
                        )}
                        <span className="tw:text-right tw:font-mono tw:text-[12px] tw:text-fg-2 tw:max-sm:hidden">{folder ? '—' : formatBytes(e.size)}</span>
                        <span className="tw:font-mono tw:text-[12px] tw:text-fg-2 tw:max-sm:hidden" title={`${e.mode} ${e.owner}`}>
                          {stamp(e.mtime)}
                        </span>
                        <span className="tw:flex tw:justify-end tw:gap-1 tw:opacity-0 tw:transition-opacity tw:group-hover:opacity-100 tw:group-focus-within:opacity-100 tw:[@media(hover:none)]:opacity-100">
                          {!folder && (
                            <a className="btn btn-icon btn-sm" href={downloadUrl(e.name)} download aria-label={`Download ${e.name}`} title="Download">
                              <DownloadIcon size={13} />
                            </a>
                          )}
                          {canWrite && (
                            <button type="button" className="btn btn-icon btn-sm" onClick={() => setRenaming(e.name)} aria-label={`Rename ${e.name}`} title="Rename">
                              <PencilIcon size={13} />
                            </button>
                          )}
                          {canWrite && (
                            <button type="button" className="btn btn-icon btn-sm" onClick={() => setToDelete(e)} aria-label={`Delete ${e.name}`} title="Delete">
                              <TrashIcon size={13} />
                            </button>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
              {listing?.truncated && (
                <p className="tw:border-t tw:border-line tw:px-3 tw:py-2 tw:text-[12px] tw:text-fg-3">Only the first {listing.entries.length} entries are shown.</p>
              )}
            </>
          )}
        </div>

        {selected && !isFolder(selected) && dir && (
          <aside className="files-preview tw:flex tw:min-w-0 tw:flex-col tw:gap-3 tw:rounded-lg tw:border tw:border-line tw:bg-surface-2 tw:p-4" aria-label={`Preview of ${selected.name}`}>
            <div className="tw:flex tw:items-start tw:justify-between tw:gap-3">
              <div className="tw:min-w-0">
                <h4 className="tw:m-0 tw:truncate tw:text-[14px] tw:font-semibold tw:text-fg">{selected.name}</h4>
                <p className="tw:font-mono tw:text-[11px] tw:text-fg-2">
                  {formatBytes(selected.size)} · {stamp(selected.mtime)} · {selected.mode} {selected.owner}
                </p>
              </div>
              <button type="button" className="btn btn-icon btn-sm" onClick={() => setSelected(null)} aria-label="Close preview">
                ✕
              </button>
            </div>
            <div key={selected.name} className="files-preview-body tw:min-h-24 tw:overflow-hidden tw:rounded-md tw:border tw:border-line tw:bg-bg">
              {IMAGE_EXT.test(selected.name) ? (
                <img src={downloadUrl(selected.name, true)} alt={selected.name} className="tw:mx-auto tw:block tw:max-h-[50vh] tw:max-w-full tw:object-contain" />
              ) : previewError ? (
                <p className="empty">{previewError}</p>
              ) : !preview ? (
                <div className="tw:p-3">
                  <Bone h={140} />
                </div>
              ) : preview.text === null ? (
                <p className="empty">Binary file. Download it to open.</p>
              ) : (
                <pre className="tw:m-0 tw:max-h-[50vh] tw:overflow-auto tw:p-3 tw:font-mono tw:text-[12px] tw:leading-relaxed tw:whitespace-pre tw:text-fg">
                  {preview.text}
                </pre>
              )}
            </div>
            {preview?.truncated && <p className="tw:text-[11px] tw:text-fg-2">Showing the first 256 KB.</p>}
            <a className="btn btn-primary btn-sm tw:self-start" href={downloadUrl(selected.name)} download>
              <DownloadIcon size={13} />
              Download
            </a>
          </aside>
        )}
      </div>

      <ConfirmDialog
        open={toDelete !== null}
        icon="delete"
        title={`Delete ${toDelete?.name ?? ''}?`}
        message={
          toDelete && isFolder(toDelete)
            ? 'The folder and everything inside it are removed for good. This cannot be undone.'
            : 'The file is removed for good. This cannot be undone.'
        }
        confirmLabel="Delete"
        onConfirm={() => void remove()}
        onCancel={() => setToDelete(null)}
      />
      <ConfirmDialog
        open={conflict.length > 0}
        icon="replace"
        title={conflict.length === 1 ? `Replace ${conflict[0]?.name ?? ''}?` : `Replace ${conflict.length} files?`}
        message={`${conflict.length === 1 ? 'A file with that name' : 'Files with those names'} already exist in this folder. Replacing overwrites ${conflict.length === 1 ? 'it' : 'them'}.`}
        confirmLabel="Replace"
        onConfirm={() => {
          const files = conflict;
          setConflict([]);
          void upload(files, true);
        }}
        onCancel={() => setConflict([])}
      />
    </section>
  );
}
