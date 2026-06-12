// IndexedDB store for screen captures. Blobs are stored natively (no base64
// bloat), so large videos persist efficiently across reloads. This is the
// local stand-in for a future server database — same shape, swap the backend.

export type Annotation = {
  id: string;
  kind: 'text' | 'click';
  x: number; // 0..1 fraction of media width
  y: number; // 0..1 fraction of media height
  text: string;
};

export type Capture = {
  id: string;
  type: 'screenshot' | 'video';
  blob: Blob; // the media (image/webp or video/webm)
  thumb: Blob | null; // poster image for cards
  mime: string;
  url: string; // source site URL
  host: string;
  title: string;
  description: string;
  notes: string;
  annotations: Annotation[];
  durationMs: number; // 0 for screenshots
  width: number;
  height: number;
  createdAt: number;
};

const DB_NAME = 'vp-captures';
const STORE = 'captures';
const VERSION = 1;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: 'id' });
        os.createIndex('createdAt', 'createdAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        t.oncomplete = () => db.close();
      })
  );
}

export const putCapture = (c: Capture) => tx('readwrite', (s) => s.put(c));
export const getCapture = (id: string) => tx<Capture | undefined>('readonly', (s) => s.get(id));
export const deleteCapture = (id: string) => tx('readwrite', (s) => s.delete(id));

export async function allCaptures(): Promise<Capture[]> {
  const list = await tx<Capture[]>('readonly', (s) => s.getAll());
  return list.sort((a, b) => b.createdAt - a.createdAt);
}
