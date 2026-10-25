// Output-folder writers (File System Access API and in-memory) plus handle persistence.

const DB_NAME = 'takeout';
const STORE = 'handles';
const KEY = 'export-dir';

/** @param {string} path @returns {string[]} */
function splitPath(path) {
  return String(path).split('/').filter(Boolean);
}

/**
 * Writer over a FileSystemDirectoryHandle. Paths use "/" and nested folders are created.
 * @param {any} dirHandle
 */
export function createFolderWriter(dirHandle) {
  const dirs = new Map([['', dirHandle]]);

  async function dirFor(parts, create) {
    let key = '';
    let handle = dirHandle;
    for (const part of parts) {
      key = key ? `${key}/${part}` : part;
      if (!dirs.has(key)) dirs.set(key, await handle.getDirectoryHandle(part, { create }));
      handle = dirs.get(key);
    }
    return handle;
  }

  async function fileHandle(path, create) {
    const parts = splitPath(path);
    const name = parts.pop();
    const dir = await dirFor(parts, create);
    return dir.getFileHandle(name, { create });
  }

  async function write(path, data) {
    const handle = await fileHandle(path, true);
    const stream = await handle.createWritable();
    try {
      await stream.write(data);
    } finally {
      await stream.close();
    }
  }

  async function readText(path) {
    try {
      const handle = await fileHandle(path, false);
      return await (await handle.getFile()).text();
    } catch (err) {
      if (err?.name === 'NotFoundError') return null;
      throw err;
    }
  }

  return {
    writeText: (path, text) => write(path, text),
    writeJson: (path, value) => write(path, JSON.stringify(value, null, 2)),
    writeBlob: (path, blob) => write(path, blob),
    readText,
    exists: async (path) => {
      try {
        await fileHandle(path, false);
        return true;
      } catch (err) {
        if (err?.name === 'NotFoundError') return false;
        throw err;
      }
    },
  };
}

/**
 * In-memory writer for tests. `.files` maps path to string or Blob.
 * @returns {{ files: Map<string, string|Blob> } & ReturnType<typeof createFolderWriter>}
 */
export function createMemoryWriter() {
  const files = new Map();
  const asText = async (v) => (typeof v === 'string' ? v : v.text());
  return {
    files,
    writeText: async (path, text) => void files.set(path, text),
    writeJson: async (path, value) => void files.set(path, JSON.stringify(value, null, 2)),
    writeBlob: async (path, blob) => void files.set(path, blob),
    readText: async (path) => (files.has(path) ? asText(files.get(path)) : null),
    exists: async (path) => files.has(path),
  };
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/** @param {any} handle */
export const saveHandle = (handle) => withStore('readwrite', (s) => s.put(handle, KEY));

/** @returns {Promise<any|null>} */
export const loadHandle = async () => (await withStore('readonly', (s) => s.get(KEY))) ?? null;

export const clearHandle = () => withStore('readwrite', (s) => s.delete(KEY));

/**
 * @param {any} handle
 * @param {{ request?: boolean }} [opts]
 * @returns {Promise<'granted'|'prompt'|'denied'>}
 */
export async function ensurePermission(handle, { request = false } = {}) {
  const opts = { mode: 'readwrite' };
  const current = await handle.queryPermission(opts);
  if (current === 'granted' || !request) return current;
  return handle.requestPermission(opts);
}
