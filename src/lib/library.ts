import { store, type TakeMeta } from './store';

/**
 * Your recordings, kept in IndexedDB on this computer (the desktop app has its own).
 *
 * Two object stores:
 *  - `takes`: small records (title, duration, transcript, chapters, a thumbnail),
 *    read in full to draw the Library.
 *  - `videos`: the MP4 blobs, keyed by take id, only read when you play or
 *    download one. Listing the Library never touches them.
 */
export interface TakeRecord {
  id: string;
  title: string;
  createdAt: number;
  duration: number;
  retakes: number;
  held: number;
  size: number;
  thumb: Blob | null;
  transcript: { start: number; end: number; text: string; words?: { text: string; start: number; end: number }[] }[] | null;
  chapters: { t: number; name: string }[];
  captionsBurned: boolean;
  /** false until you've opened the Library after exporting it */
  seen?: boolean;
}

const DB = 'take1';
const TAKES = 'takes';
const VIDEOS = 'videos';
let dbp: Promise<IDBDatabase> | null = null;

function db() {
  if (!dbp)
    dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB, 2);
      r.onupgradeneeded = (e) => {
        const d = r.result;
        if (!d.objectStoreNames.contains(TAKES)) d.createObjectStore(TAKES, { keyPath: 'id' });
        if (!d.objectStoreNames.contains(VIDEOS)) d.createObjectStore(VIDEOS);
        // v1 kept the video inside each take record: move it out
        if (e.oldVersion === 1) {
          const tx = r.transaction!;
          const takes = tx.objectStore(TAKES);
          const videos = tx.objectStore(VIDEOS);
          takes.openCursor().onsuccess = (ev) => {
            const cur = (ev.target as IDBRequest<IDBCursorWithValue | null>).result;
            if (!cur) return;
            const { video, ...rest } = cur.value as TakeRecord & { video?: Blob };
            if (video) {
              videos.put(video, rest.id);
              cur.update({ ...rest, size: video.size, seen: rest.seen ?? true });
            }
            cur.continue();
          };
        }
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  return dbp;
}

async function req<T>(storeName: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = fn(d.transaction(storeName, mode).objectStore(storeName));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
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
    size: r.size,
    hasCaptions: !!r.transcript?.length,
    captionsBurned: r.captionsBurned,
    thumbUrl: thumbUrls.get(r.id) ?? null,
    seen: r.seen ?? true,
  };
}

export const library = {
  async refresh() {
    try {
      const all = await req<TakeRecord[]>(TAKES, 'readonly', (s) => s.getAll());
      store.set({ library: all.map(meta).sort((a, b) => b.createdAt - a.createdAt) });
    } catch {
      store.set({ library: [] });
    }
  },
  getMeta: (id: string) => req<TakeRecord | undefined>(TAKES, 'readonly', (s) => s.get(id)),
  getVideo: (id: string) => req<Blob | undefined>(VIDEOS, 'readonly', (s) => s.get(id)),
  async save(rec: TakeRecord, video?: Blob) {
    // ask the browser not to evict recordings under storage pressure
    navigator.storage?.persist?.().catch(() => {});
    if (video) await req(VIDEOS, 'readwrite', (s) => s.put(video, rec.id));
    await req(TAKES, 'readwrite', (s) => s.put(rec));
    await library.refresh();
  },
  async update(id: string, patch: Partial<TakeRecord>) {
    const cur = await library.getMeta(id);
    if (cur) await library.save({ ...cur, ...patch });
  },
  /** Opening the Library clears the "new" badge. */
  async markSeen() {
    try {
      const all = await req<TakeRecord[]>(TAKES, 'readonly', (s) => s.getAll());
      const unseen = all.filter((r) => r.seen === false);
      if (!unseen.length) return;
      // one transaction for all of them
      const d = await db();
      await new Promise<void>((resolve, reject) => {
        const tx = d.transaction(TAKES, 'readwrite');
        const st = tx.objectStore(TAKES);
        for (const r of unseen) st.put({ ...r, seen: true });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      await library.refresh();
    } catch {
      /* storage blocked */
    }
  },
  async remove(id: string) {
    await req(VIDEOS, 'readwrite', (s) => s.delete(id));
    await req(TAKES, 'readwrite', (s) => s.delete(id));
    const u = thumbUrls.get(id);
    if (u) URL.revokeObjectURL(u);
    thumbUrls.delete(id);
    await library.refresh();
  },
};
