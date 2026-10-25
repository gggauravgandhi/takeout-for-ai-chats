import { describe, expect, test } from 'bun:test';
import { createFolderWriter, createMemoryWriter, ensurePermission } from '../src/folder.js';

const notFound = () => Object.assign(new Error('nf'), { name: 'NotFoundError' });

function fakeDir() {
  const calls = { dirs: 0 };
  const make = () => {
    const dirs = new Map();
    const files = new Map();
    return {
      dirs,
      files,
      async getDirectoryHandle(name, { create }) {
        if (!dirs.has(name)) {
          if (!create) throw notFound();
          calls.dirs++;
          dirs.set(name, make());
        }
        return dirs.get(name);
      },
      async getFileHandle(name, { create }) {
        if (!files.has(name)) {
          if (!create) throw notFound();
          files.set(name, { data: null });
        }
        const f = files.get(name);
        return {
          async createWritable() {
            return { write: async (d) => void (f.data = d), close: async () => {} };
          },
          async getFile() {
            return { text: async () => (typeof f.data === 'string' ? f.data : await f.data.text()) };
          },
        };
      },
    };
  };
  return { root: make(), calls };
}

describe('memory writer', () => {
  test('writes and reads text, json and blobs', async () => {
    const w = createMemoryWriter();
    await w.writeText('a/b.md', 'hi');
    await w.writeJson('c.json', { x: 1 });
    await w.writeBlob('files/p.bin', new Blob(['bytes']));
    expect(await w.readText('a/b.md')).toBe('hi');
    expect(await w.readText('c.json')).toBe('{\n  "x": 1\n}');
    expect(await w.readText('files/p.bin')).toBe('bytes');
    expect([...w.files.keys()]).toEqual(['a/b.md', 'c.json', 'files/p.bin']);
  });
  test('missing path reads null and does not exist', async () => {
    const w = createMemoryWriter();
    expect(await w.readText('nope')).toBeNull();
    expect(await w.exists('nope')).toBe(false);
    await w.writeText('yes', '');
    expect(await w.exists('yes')).toBe(true);
  });
});

describe('folder writer', () => {
  test('creates nested directories and round-trips', async () => {
    const { root } = fakeDir();
    const w = createFolderWriter(root);
    await w.writeText('chats/x.md', 'hello');
    await w.writeJson('account/deep/me.json', { a: 1 });
    await w.writeBlob('files/c1/p.png', new Blob(['png']));
    expect(await w.readText('chats/x.md')).toBe('hello');
    expect(JSON.parse(await w.readText('account/deep/me.json'))).toEqual({ a: 1 });
    expect(await w.readText('files/c1/p.png')).toBe('png');
    expect(root.dirs.get('account').dirs.has('deep')).toBe(true);
  });
  test('readText returns null and exists false when missing', async () => {
    const w = createFolderWriter(fakeDir().root);
    expect(await w.readText('chats/none.md')).toBeNull();
    expect(await w.exists('chats/none.md')).toBe(false);
    await w.writeText('chats/none.md', 'x');
    expect(await w.exists('chats/none.md')).toBe(true);
  });
  test('caches directory handles', async () => {
    const { root, calls } = fakeDir();
    const w = createFolderWriter(root);
    await w.writeText('chats/a.md', '1');
    await w.writeText('chats/b.md', '2');
    expect(calls.dirs).toBe(1);
  });
  test('rethrows non-NotFound errors', async () => {
    const w = createFolderWriter({
      getDirectoryHandle: async () => {
        throw Object.assign(new Error('boom'), { name: 'NotAllowedError' });
      },
    });
    await expect(w.readText('a/b')).rejects.toThrow('boom');
  });
});

describe('ensurePermission', () => {
  const handle = (query, request) => ({
    queryPermission: async () => query,
    requestPermission: async () => request,
  });
  test('returns query result without requesting', async () => {
    expect(await ensurePermission(handle('prompt', 'granted'))).toBe('prompt');
  });
  test('requests when asked and not granted', async () => {
    expect(await ensurePermission(handle('prompt', 'granted'), { request: true })).toBe('granted');
    expect(await ensurePermission(handle('granted', 'denied'), { request: true })).toBe('granted');
  });
});
