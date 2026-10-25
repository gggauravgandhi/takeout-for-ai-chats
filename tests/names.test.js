import { describe, expect, test } from 'bun:test';
import { chatBaseName, isSafeBaseName, safeFileName, slugify, toDate, uniqueName } from '../src/names.js';

describe('toDate', () => {
  test('reads epoch seconds and ISO strings', () => {
    expect(toDate(Date.parse('2026-10-14T04:21:49.360Z') / 1000).toISOString()).toBe('2026-10-14T04:21:49.360Z');
    expect(toDate('2026-10-13T04:27:16.535268Z').toISOString().slice(0, 10)).toBe('2026-10-13');
  });
  test('returns null for missing or invalid', () => {
    expect(toDate(null)).toBeNull();
    expect(toDate('nope')).toBeNull();
  });
});

describe('slugify', () => {
  test('makes ascii slugs and strips accents and punctuation', () => {
    expect(slugify('Log Sam’s Daily Notes!')).toBe('log-sam-s-daily-notes');
    expect(slugify('Café  —  Ünïcode')).toBe('cafe-unicode');
  });
  test('falls back to untitled and respects max without trailing dash', () => {
    expect(slugify('')).toBe('untitled');
    expect(slugify('???')).toBe('untitled');
    expect(slugify('aaaa bbbb', 5)).toBe('aaaa');
  });
});

describe('chatBaseName', () => {
  test('is date_slug_id8 and stable between list (ISO) and detail (epoch) shapes', () => {
    const fromList = chatBaseName({ id: 'a1b2c3d4-ce70-83e8', title: 'Hello World', create_time: '2026-10-13T04:27:16Z' });
    const fromDetail = chatBaseName({ id: 'a1b2c3d4-ce70-83e8', title: 'Hello World', create_time: Date.parse('2026-10-13T04:27:16Z') / 1000 });
    expect(fromList).toBe('2026-10-13_hello-world_a1b2c3d4');
    expect(fromDetail).toBe(fromList);
  });
  test('handles missing title and time', () => {
    expect(chatBaseName({ id: 'abcdefghij', title: null, create_time: null })).toBe('undated_untitled_abcdefgh');
  });
});

describe('safeFileName', () => {
  test('removes path separators and illegal characters', () => {
    expect(safeFileName('a/b\\c:d*e?.png')).toBe('a_b_c_d_e_.png');
    expect(safeFileName('../../etc/passwd')).toBe('_.._etc_passwd');
  });
  test('never empty, keeps extension when truncating', () => {
    expect(safeFileName('')).toBe('file');
    expect(safeFileName('...')).toBe('file');
    const long = safeFileName('x'.repeat(300) + '.jpeg', 50);
    expect(long.length).toBe(50);
    expect(long.endsWith('.jpeg')).toBe(true);
  });
});

describe('safeFileName windows reserved names', () => {
  test('appends an underscore to the stem of reserved device names', () => {
    expect(safeFileName('CON')).toBe('CON_');
    expect(safeFileName('nul.txt')).toBe('nul_.txt');
    expect(safeFileName('com1.tar.gz')).toBe('com1_.tar.gz');
    expect(safeFileName('LPT9.png')).toBe('LPT9_.png');
  });
  test('leaves look-alikes alone', () => {
    expect(safeFileName('console.log')).toBe('console.log');
    expect(safeFileName('com10.txt')).toBe('com10.txt');
    expect(safeFileName('aux-notes.md')).toBe('aux-notes.md');
  });
});

describe('chatBaseName ids and isSafeBaseName', () => {
  test('ids with path characters cannot add separators', () => {
    const name = chatBaseName({ id: '../../x/y', title: 'T', create_time: null });
    expect(name).not.toMatch(/[/\\]|\.\./);
    expect(isSafeBaseName(name)).toBe(true);
  });
  test('accepts generated names, rejects traversal and odd characters', () => {
    expect(isSafeBaseName('2026-10-13_hello-world_a1b2c3d4')).toBe(true);
    expect(isSafeBaseName('../evil')).toBe(false);
    expect(isSafeBaseName('a..b')).toBe(false);
    expect(isSafeBaseName('a/b')).toBe(false);
    expect(isSafeBaseName('')).toBe(false);
    expect(isSafeBaseName(42)).toBe(false);
  });
});

describe('uniqueName', () => {
  test('compares case-insensitively and keeps the requested case', () => {
    const taken = new Set(['Photo.png']);
    expect(uniqueName('photo.png', taken)).toBe('photo (2).png');
    expect(uniqueName('PHOTO.PNG', new Set(['photo.png', 'PHOTO (2).PNG']))).toBe('PHOTO (3).PNG');
    expect(uniqueName('other.png', taken)).toBe('other.png');
  });
  test('adds a counter before the extension', () => {
    const taken = new Set(['a.png', 'a (2).png', 'noext']);
    expect(uniqueName('b.png', taken)).toBe('b.png');
    expect(uniqueName('a.png', taken)).toBe('a (3).png');
    expect(uniqueName('noext', taken)).toBe('noext (2)');
  });
});
