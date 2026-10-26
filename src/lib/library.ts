import { store, type TakeMeta } from './store';

/**
 * Your recordings, kept in the browser's IndexedDB (in the desktop app: the
 * app's own profile). Nothing leaves your machine.
 */
export interface TakeRecord {
  id: string;
  title: string;
  createdAt: number;
  duration: number;
  retakes: number;
  held: number;
  video: Blob;
  thumb: Blob | null;
  transcript: { start: number; end: number; text: string }[] | null;
  chapters: { t: number; name: string }[];
  captionsBurned: boolean;
}

const DB = 'take1';
const STORE = 'takes';
let dbp: Promise<IDBDatabase> | null = null;

function db() {
  if (!dbp)
    dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  return dbp;
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = fn(d.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const thumbUrls = new Map<string, string>();

function meta(r: TakeRecord): TakeMeta {
  if (r.thumb && !thumbUrls.has(r.id)) thumbUrls.set(r.id, URL.createObjectURL(r.thumb));
  return {
    id: r.id,
    title: r.title,
    createdAt: r.createdAt,
    duration: r.duration,
    retakes: r.retakes,
    held: r.held,
    size: r.video.size,
    hasCaptions: !!r.transcript?.length,
    captionsBurned: r.captionsBurned,
    thumbUrl: thumbUrls.get(r.id) ?? null,
  };
}

export const library = {
  async refresh() {
    try {
      const all = await tx<TakeRecord[]>('readonly', (s) => s.getAll());
      store.set({ library: all.map(meta).sort((a, b) => b.createdAt - a.createdAt) });
    } catch {
      store.set({ library: [] });
    }
  },
  get: (id: string) => tx<TakeRecord | undefined>('readonly', (s) => s.get(id)),
  async put(rec: TakeRecord) {
    await tx('readwrite', (s) => s.put(rec));
    await library.refresh();
  },
  async update(id: string, patch: Partial<TakeRecord>) {
    const cur = await library.get(id);
    if (!cur) return;
    await library.put({ ...cur, ...patch });
  },
  async remove(id: string) {
    await tx('readwrite', (s) => s.delete(id));
    const u = thumbUrls.get(id);
    if (u) URL.revokeObjectURL(u);
    thumbUrls.delete(id);
    await library.refresh();
  },
};
