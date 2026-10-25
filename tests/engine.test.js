import { describe, expect, test } from 'bun:test';
import { createEngine } from '../src/engine.js';
import { createMemoryWriter } from '../src/folder.js';
import { chatBaseName } from '../src/names.js';
import { createFakeApi, makeConversation } from './helpers/fake-api.js';

const C1 = 'c1000000-aaaa';
const C2 = 'c2000000-bbbb';
const C3 = 'c3000000-cccc';
const base = (id, title, create_time) => chatBaseName({ id, title, create_time });
const B1 = base(C1, 'Log vitals', 1792160509);
const B2 = base(C2, 'Project chat', 1792250000);
const B3 = base(C3, 'Archived GPT chat', 1792000000);

function setup({ api = createFakeApi(), writer = createMemoryWriter() } = {}) {
  const states = [];
  const logs = [];
  const engine = createEngine({ api, writer, onState: (s) => states.push(s), onLog: (l) => logs.push(l) });
  const index = async () => JSON.parse(await writer.readText('index.json'));
  return { api, writer, engine, states, logs, index };
}

const until = async (cond) => {
  for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setTimeout(r, 1));
  if (!cond()) throw new Error('timed out');
};

describe('full run', () => {
  test('writes every expected path and reports counts', async () => {
    const { engine, writer, index, logs } = setup();
    await engine.run({ mode: 'all' });
    const paths = [
      `chats/${B1}.json`, `chats/${B1}.md`, `chats/${B2}.json`, `chats/${B2}.md`, `chats/${B3}.json`, `chats/${B3}.md`,
      `files/${C1}/photo.jpg`, `files/${C1}/image.png`,
      'account/memories.json', 'account/memories.md', 'account/custom-instructions.json', 'account/custom-instructions.md',
      'account/me.json', 'account/projects.json', 'account/projects.md', 'account/projects/my-project/files/spec.pdf',
      'account/gpts.json', 'account/gpts.md', 'INDEX.md', 'bundles/bundle-01.md', 'index.json',
    ];
    for (const p of paths) expect(writer.files.has(p), p).toBe(true);
    for (const p of paths.filter((x) => x.endsWith('.md'))) expect((await writer.readText(p)).length).toBeGreaterThan(0);
    expect(JSON.parse(await writer.readText(`chats/${B1}.json`)).conversation_id).toBe(C1);
    expect(await writer.readText(`files/${C1}/photo.jpg`)).toBe('JPG');

    const s = engine.getState();
    expect(s).toMatchObject({ phase: 'done', total: 3, done: 3, partial: 0, failed: 0, skipped: 0, current: null, error: null, errorKind: null });
    expect(s.filesSaved).toBe(3);
    expect(s.failures).toEqual([]);
    expect(s.startedAt).toBeTruthy();
    expect(s.finishedAt).toBeTruthy();

    const idx = await index();
    expect(idx.version).toBe(1);
    expect(idx.exportedAt).toBeTruthy();
    expect(idx.account).toEqual({ planType: 'team', accountId: 'acc-1' });
    expect(Object.keys(idx.chats).sort()).toEqual([C1, C2, C3]);
    expect(idx.chats[C1]).toMatchObject({ baseName: B1, status: 'done', title: 'Log vitals', messageCount: 2, error: null });
    expect(idx.chats[C1].files.map((f) => f.path)).toEqual([`files/${C1}/photo.jpg`, `files/${C1}/image.png`]);
    expect(idx.chats[C1].create_time).toBe(new Date(1792160509 * 1000).toISOString());
    expect(logs.some((l) => l.includes(`Saved ${B1} (2 files)`))).toBe(true);
  });

  test('emits copies of state, never internals', async () => {
    const { engine, states } = setup();
    await engine.run({});
    expect(states.length).toBeGreaterThan(5);
    expect(states.map((s) => s.phase)).toEqual(expect.arrayContaining(['account', 'listing', 'chats', 'finishing', 'done']));
    const snap = engine.getState();
    snap.failures.push('x');
    snap.total = 99;
    expect(engine.getState().total).toBe(3);
    expect(new Set(states).size).toBe(states.length);
  });

  test('run while running rejects', async () => {
    const { engine } = setup();
    const p = engine.run({});
    await expect(engine.run({})).rejects.toThrow();
    await p;
    expect(engine.getState().phase).toBe('done');
  });

  test('archived chats are included with archived flag', async () => {
    const { engine, index, writer } = setup();
    await engine.run({});
    expect((await index()).chats[C3].archived).toBe(true);
    expect((await index()).chats[C1].archived).toBe(false);
    expect(writer.files.has(`chats/${B3}.md`)).toBe(true);
  });

  test('project chats carry project id and name', async () => {
    const { engine, index } = setup();
    await engine.run({});
    expect((await index()).chats[C2]).toMatchObject({ project_id: 'g-p-1', project_name: 'My Project' });
    expect((await index()).chats[C1]).toMatchObject({ project_id: null, project_name: null });
  });

  test('fetches GPT definitions for g- ids but not g-p- ids', async () => {
    const { engine, api, writer } = setup();
    await engine.run({});
    expect(api.count('getGizmo')).toBe(1);
    expect(api.count('getGizmo', 'g-custom1')).toBe(1);
    expect(JSON.parse(await writer.readText('account/gpts.json'))).toHaveLength(1);
  });

  test('same-named attachments get unique file names', async () => {
    const api = createFakeApi();
    api.addConversation(makeConversation({
      id: 'c4000000-dddd', title: 'Dups', create: 1792300000,
      attachments: [{ id: 'file_d1', name: 'dup.png' }, { id: 'file_d2', name: 'dup.png' }],
    }));
    api.addFile('file_d1', { fileName: 'dup.png', mime: 'image/png', body: 'one' });
    api.addFile('file_d2', { fileName: 'dup.png', mime: 'image/png', body: 'two' });
    const { engine, writer } = setup({ api });
    await engine.run({});
    expect(await writer.readText('files/c4000000-dddd/dup.png')).toBe('one');
    expect(await writer.readText('files/c4000000-dddd/dup (2).png')).toBe('two');
  });
});

describe('resume', () => {
  test('second run with no changes fetches nothing', async () => {
    const { engine, api } = setup();
    await engine.run({});
    const before = api.count('getConversation');
    await engine.run({});
    expect(api.count('getConversation')).toBe(before);
    expect(engine.getState()).toMatchObject({ phase: 'done', total: 3, done: 3 });
  });

  test('changed update_time re-exports only that chat and reuses saved files', async () => {
    const { engine, api } = setup();
    await engine.run({});
    api.touch(C1);
    await engine.run({});
    expect(api.count('getConversation')).toBe(4);
    expect(api.count('getConversation', C1)).toBe(2);
    expect(api.count('downloadFile', 'file_up1')).toBe(1);
  });

  test('corrupt index.json is backed up and the run starts fresh', async () => {
    const writer = createMemoryWriter();
    await writer.writeText('index.json', '{not json');
    const { engine, logs, index } = setup({ writer });
    await engine.run({});
    const backup = [...writer.files.keys()].find((k) => /^index\.corrupt-\d+\.json$/.test(k));
    expect(backup).toBeTruthy();
    expect(writer.files.get(backup)).toBe('{not json');
    expect(logs.some((l) => l.toLowerCase().includes('corrupt'))).toBe(true);
    expect(Object.keys((await index()).chats)).toHaveLength(3);
    expect(engine.getState().phase).toBe('done');
  });
});

describe('failures', () => {
  test('expired file makes the chat partial, other files still saved', async () => {
    const api = createFakeApi();
    api.fail('downloadFile', 'file_up1', 'notfound');
    const { engine, index, writer, logs } = setup({ api });
    await engine.run({});
    const entry = (await index()).chats[C1];
    expect(entry.status).toBe('partial');
    expect(entry.files.find((f) => f.id === 'file_up1')).toMatchObject({ status: 'failed' });
    expect(entry.files.find((f) => f.id === 'file_gen1')).toMatchObject({ status: 'done' });
    expect(writer.files.has(`chats/${B1}.md`)).toBe(true);
    expect(logs).toContain('File expired: photo.jpg');
    const s = engine.getState();
    expect(s).toMatchObject({ phase: 'done', partial: 1, done: 2 });
    expect(s.failures).toHaveLength(1);
    expect(s.failures[0]).toMatchObject({ id: C1, title: 'Log vitals' });
    expect(s.failures[0].error).toBeTruthy();
  });

  test('network error on a chat marks it failed and the run continues', async () => {
    const api = createFakeApi();
    api.fail('getConversation', C1, 'network');
    const { engine, index, writer } = setup({ api });
    await engine.run({});
    const idx = await index();
    expect(idx.chats[C1]).toMatchObject({ status: 'failed' });
    expect(idx.chats[C1].error).toBeTruthy();
    expect(idx.chats[C2].status).toBe('done');
    expect(writer.files.has(`chats/${B1}.md`)).toBe(false);
    expect(engine.getState()).toMatchObject({ phase: 'done', failed: 1, done: 2, total: 3 });
    expect(engine.getState().failures[0]).toMatchObject({ id: C1 });
  });

  test('account step failure is recorded and does not stop the run', async () => {
    const api = createFakeApi();
    api.fail('getMemories', '*', 'http');
    const { engine, index } = setup({ api });
    await engine.run({});
    expect(engine.getState().phase).toBe('done');
    const idx = await index();
    expect(Object.keys(idx.accountErrors)).toContain('memories');
    expect(Object.keys(idx.chats)).toHaveLength(3);
  });

  test('auth error mid-run is fatal and keeps completed chats', async () => {
    const api = createFakeApi();
    api.fail('getConversation', C1, 'auth');
    const { engine, index } = setup({ api });
    await expect(engine.run({})).resolves.toBeUndefined();
    const s = engine.getState();
    expect(s).toMatchObject({ phase: 'error', errorKind: 'auth' });
    expect(s.error).toBeTruthy();
    const idx = await index();
    expect(idx.chats[C3].status).toBe('done');
    expect(idx.chats[C1]?.status).not.toBe('done');
    expect(api.count('getConversation', C2)).toBe(0);
  });

  test('auth error at session is fatal', async () => {
    const api = createFakeApi();
    api.fail('session', '*', 'auth');
    const { engine } = setup({ api });
    await engine.run({});
    expect(engine.getState()).toMatchObject({ phase: 'error', errorKind: 'auth' });
  });

  test('shape error is fatal and writes nothing for that chat', async () => {
    const api = createFakeApi();
    api.fail('getConversation', C3, 'shape');
    const { engine, writer } = setup({ api });
    await engine.run({});
    expect(engine.getState()).toMatchObject({ phase: 'error', errorKind: 'shape' });
    expect(writer.files.has(`chats/${B3}.json`)).toBe(false);
    expect(writer.files.has('index.json')).toBe(true);
  });
});

describe('retry-failed', () => {
  test('only touches failed and partial chats', async () => {
    const api = createFakeApi();
    api.fail('downloadFile', 'file_up1', 'notfound', 1);
    api.fail('getConversation', C2, 'network', 1);
    const { engine, index } = setup({ api });
    await engine.run({});
    expect(engine.getState()).toMatchObject({ partial: 1, failed: 1, done: 1 });
    await engine.run({ mode: 'retry-failed' });
    expect(api.count('getConversation')).toBe(5);
    expect(api.count('getConversation', C3)).toBe(1);
    expect(api.count('downloadFile', 'file_gen1')).toBe(1);
    expect(engine.getState()).toMatchObject({ phase: 'done', total: 3, done: 3, failed: 0, partial: 0 });
    const idx = await index();
    expect(idx.chats[C1].status).toBe('done');
    expect(idx.chats[C2].status).toBe('done');
  });
});

describe('controls', () => {
  test('skip before the chat is reached marks it skipped for good', async () => {
    const { engine, api, index } = setup();
    engine.skip(C1);
    await engine.run({});
    expect(api.count('getConversation', C1)).toBe(0);
    expect((await index()).chats[C1].status).toBe('skipped');
    expect(engine.getState()).toMatchObject({ skipped: 1, done: 2, total: 3 });
    await engine.run({});
    expect(api.count('getConversation', C1)).toBe(0);
    expect(engine.getState().skipped).toBe(1);
  });

  test('skip on a fresh idle engine (page reloaded) persists to index.json and survives a new engine', async () => {
    const writer = createMemoryWriter();
    await setup({ writer }).engine.run({});
    const failingApi = createFakeApi();
    const { engine, index } = setup({ api: failingApi, writer });
    await engine.skip(C1);
    expect((await index()).chats[C1].status).toBe('skipped');
    const later = setup({ api: failingApi, writer });
    await later.engine.run({});
    expect((await later.index()).chats[C1].status).toBe('skipped');
  });

  test('skip of the current chat takes effect after it finishes', async () => {
    const api = createFakeApi();
    const { engine, index } = setup({ api });
    api.hook = async (m, args) => {
      if (m === 'getConversation' && args[0] === C1) engine.skip(C1);
    };
    await engine.run({});
    expect((await index()).chats[C1].status).toBe('skipped');
    expect(engine.getState().skipped).toBe(1);
  });

  test('pause waits between requests until resume', async () => {
    const api = createFakeApi();
    const { engine } = setup({ api });
    let fired = false;
    api.hook = async (m) => {
      if (m === 'getConversation' && !fired) {
        fired = true;
        engine.pause();
      }
    };
    const p = engine.run({});
    await until(() => engine.getState().phase === 'paused');
    const frozen = api.calls.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(api.calls.length).toBe(frozen);
    expect(engine.getState().phase).toBe('paused');
    engine.resume();
    await p;
    expect(engine.getState()).toMatchObject({ phase: 'done', done: 3 });
    expect(api.calls.length).toBeGreaterThan(frozen);
  });

  test('stop ends the run after the current step and saves the index', async () => {
    const api = createFakeApi();
    const { engine, index } = setup({ api });
    api.hook = async (m) => {
      if (m === 'getConversation') engine.stop();
    };
    await engine.run({});
    expect(engine.getState().phase).toBe('stopped');
    expect(api.count('getConversation')).toBe(1);
    expect((await index()).chats[C3].status).toBe('done');
  });

  test('stop while paused ends the run', async () => {
    const api = createFakeApi();
    const { engine } = setup({ api });
    api.hook = async (m) => {
      if (m === 'getConversation') engine.pause();
    };
    const p = engine.run({});
    await until(() => engine.getState().phase === 'paused');
    engine.stop();
    await p;
    expect(engine.getState().phase).toBe('stopped');
  });
});

describe('retry-failed counts', () => {
  test('counts and failures cover the whole index, not just the retried subset', async () => {
    const api = createFakeApi();
    api.fail('getConversation', C2, 'network', 1);
    const { engine, states } = setup({ api });
    await engine.run({});
    expect(engine.getState()).toMatchObject({ total: 3, done: 2, failed: 1 });
    states.length = 0;
    await engine.run({ mode: 'retry-failed' });
    const chatStates = states.filter((s) => s.phase === 'chats');
    expect(chatStates[0]).toMatchObject({ total: 3, done: 2, failed: 1 });
    expect(chatStates[0].failures.map((f) => f.id)).toEqual([C2]);
    expect(engine.getState()).toMatchObject({ total: 3, done: 3, failed: 0, failures: [] });
  });
});

describe('skip state updates', () => {
  test('skip on an idle engine emits recomputed counts and failures', async () => {
    const writer = createMemoryWriter();
    const api = createFakeApi();
    api.fail('getConversation', C2, 'network', 1);
    await setup({ api, writer }).engine.run({});
    const { engine, states } = setup({ api: createFakeApi(), writer });
    await engine.skip(C2);
    const last = states[states.length - 1];
    expect(last).toMatchObject({ total: 3, done: 2, failed: 0, skipped: 1, failures: [] });
    expect(engine.getState()).toMatchObject({ skipped: 1, failed: 0 });
  });

  test('a run starting while an idle skip loads the index is not clobbered', async () => {
    const writer = createMemoryWriter();
    await setup({ writer }).engine.run({});
    const slow = { ...writer, readText: async (p) => { await new Promise((r) => setTimeout(r, 5)); return writer.readText(p); } };
    const { engine, index } = setup({ writer: slow });
    const skipping = engine.skip(C1);
    const running = engine.run({});
    await Promise.all([skipping, running]);
    expect(engine.getState().phase).toBe('done');
    const idx = await index();
    expect(Object.keys(idx.chats).sort()).toEqual([C1, C2, C3]);
    expect(idx.chats[C1].status).toBe('skipped');
    expect(idx.chats[C2].status).toBe('done');
  });
});

describe('index.json saves are batched', () => {
  const countingWriter = () => {
    const writer = createMemoryWriter();
    const out = { writer: null, writes: [] };
    out.writer = { ...writer, writeJson: async (p, v) => { if (p === 'index.json') out.writes.push(Object.keys(v.chats).length); return writer.writeJson(p, v); } };
    out.base = writer;
    return out;
  };

  test('26 chats cause 2 writes, and the final file holds all of them', async () => {
    const api = createFakeApi();
    for (let i = 0; i < 23; i++) {
      api.addConversation(makeConversation({ id: `d${String(i).padStart(7, '0')}-zzzz`, title: `Bulk ${i}`, create: 1793000000 + i }));
    }
    const w = countingWriter();
    const { engine, index } = setup({ api, writer: w.writer });
    await engine.run({});
    expect(w.writes).toEqual([25, 26]);
    expect(Object.keys((await index()).chats)).toHaveLength(26);
  });

  test('a time gap of 5 seconds also triggers a write', async () => {
    const w = countingWriter();
    const realNow = Date.now;
    let t = realNow();
    Date.now = () => (t += 6000);
    try {
      await setup({ writer: w.writer }).engine.run({});
    } finally {
      Date.now = realNow;
    }
    expect(w.writes.length).toBeGreaterThan(1);
  });

  test('pause flushes pending chats to disk', async () => {
    const api = createFakeApi();
    const { engine, writer } = setup({ api });
    api.hook = async (m) => {
      if (m === 'getConversation' && api.count('getConversation') === 2) engine.pause();
    };
    const p = engine.run({});
    await until(() => engine.getState().phase === 'paused');
    await new Promise((r) => setTimeout(r, 5));
    expect(Object.keys(JSON.parse(await writer.readText('index.json')).chats).length).toBeGreaterThanOrEqual(1);
    engine.stop();
    await p;
  });

  test('error flushes the chats finished so far', async () => {
    const api = createFakeApi();
    api.fail('getConversation', C1, 'shape');
    const { engine, index } = setup({ api });
    await engine.run({});
    expect((await index()).chats[C3].status).toBe('done');
  });
});

describe('sustained throttling pauses the run', () => {
  test('3 consecutive rate failures pause with a message; the third chat stays pending', async () => {
    const api = createFakeApi();
    api.fail('getConversation', '*', 'rate', 3);
    const { engine, index } = setup({ api });
    const p = engine.run({});
    await until(() => engine.getState().phase === 'paused');
    const s = engine.getState();
    expect(s.errorKind).toBe('rate');
    expect(s.error).toMatch(/rate limiting this export.*press Resume/i);
    expect(s).toMatchObject({ failed: 2, current: null });
    const idx = await index();
    expect(idx.chats[C3].status).toBe('failed');
    expect(idx.chats[C1].status).toBe('failed');
    expect(idx.chats[C2]).toBeUndefined();
    engine.resume();
    await p;
    expect(engine.getState()).toMatchObject({ phase: 'done', error: null, errorKind: null, done: 1, failed: 2 });
    expect((await index()).chats[C2].status).toBe('done');
  });

  test('network failures count too, with a connection message', async () => {
    const api = createFakeApi();
    api.fail('getConversation', '*', 'network', 3);
    const { engine } = setup({ api });
    const p = engine.run({});
    await until(() => engine.getState().phase === 'paused');
    expect(engine.getState().errorKind).toBe('rate');
    expect(engine.getState().error).toMatch(/reach ChatGPT/i);
    engine.stop();
    await p;
    expect(engine.getState()).toMatchObject({ phase: 'stopped', error: null, errorKind: null });
  });

  test('a success or a different failure resets the streak', async () => {
    const api = createFakeApi();
    api.fail('getConversation', C3, 'rate');
    api.fail('getConversation', C2, 'rate');
    const { engine } = setup({ api });
    await engine.run({});
    expect(engine.getState()).toMatchObject({ phase: 'done', failed: 2, done: 1 });
  });

  test('still limited after resume: needs 3 more failures to pause again', async () => {
    const api = createFakeApi();
    api.fail('getConversation', '*', 'rate', 5);
    const { engine } = setup({ api });
    const p = engine.run({});
    await until(() => engine.getState().phase === 'paused');
    engine.resume();
    await p;
    expect(engine.getState()).toMatchObject({ phase: 'done', error: null });
  });
});

describe('finishing is best effort', () => {
  for (const kind of ['http', 'auth', 'notfound']) {
    test(`a ${kind} failure fetching a GPT still writes INDEX.md and bundles`, async () => {
      const api = createFakeApi();
      api.fail('getGizmo', '*', kind);
      const { engine, writer, index } = setup({ api });
      await engine.run({});
      expect(engine.getState()).toMatchObject({ phase: 'done', done: 3 });
      expect(writer.files.has('INDEX.md')).toBe(true);
      expect(writer.files.has('bundles/bundle-01.md')).toBe(true);
      expect((await index()).accountErrors['gpts'] ?? (await index()).accountErrors['gpt:g-custom1']).toBeTruthy();
    });
  }

  test('stop during finishing still stops', async () => {
    const api = createFakeApi();
    api.addConversation(makeConversation({ id: 'c9000000-gggg', title: 'Other GPT', create: 1793000000, gizmo_id: 'g-custom2' }));
    const { engine } = setup({ api });
    api.hook = async (m) => {
      if (m === 'getGizmo') engine.stop();
    };
    await engine.run({});
    expect(engine.getState().phase).toBe('stopped');
  });
});

describe('bundles', () => {
  const bundleKeys = (writer) => [...writer.files.keys()].filter((k) => k.startsWith('bundles/')).sort();

  test('names and headings are numbered per bundle, oldest chat first', async () => {
    const { engine, writer } = setup();
    await engine.run({});
    expect(bundleKeys(writer)).toEqual(['bundles/bundle-01.md', 'bundles/bundle-02.md', 'bundles/bundle-03.md']);
    for (const n of [1, 2, 3]) {
      const text = await writer.readText(`bundles/bundle-0${n}.md`);
      expect(text.split('\n')[0]).toBe(`# Chats bundle 0${n} of 03`);
    }
    expect(await writer.readText('bundles/bundle-01.md')).toContain('Archived GPT chat');
    expect(await writer.readText('bundles/bundle-03.md')).toContain('Project chat');
  });

  test('many chats: at most 20 bundles, every chat exactly once, in order', async () => {
    const api = createFakeApi();
    for (let i = 0; i < 37; i++) {
      api.addConversation(makeConversation({ id: `e${String(i).padStart(7, '0')}-yyyy`, title: `Bulk ${i}`, create: 1793000000 + i }));
    }
    const { engine, writer } = setup({ api });
    await engine.run({});
    const keys = bundleKeys(writer);
    expect(keys).toHaveLength(20);
    let seen = [];
    for (const [i, key] of keys.entries()) {
      const text = await writer.readText(key);
      expect(text.split('\n')[0]).toBe(`# Chats bundle ${String(i + 1).padStart(2, '0')} of 20`);
      seen = seen.concat([...text.matchAll(/<a id="chat-([^"]+)"><\/a>/g)].map((m) => m[1]));
    }
    expect(seen).toHaveLength(40);
    expect(new Set(seen).size).toBe(40);
    const dates = seen.map((n) => n.slice(0, 10));
    expect([...dates].sort()).toEqual(dates);
  });

  test('reads chat markdown one bundle at a time', async () => {
    const api = createFakeApi();
    for (let i = 0; i < 17; i++) {
      api.addConversation(makeConversation({ id: `f${String(i).padStart(7, '0')}-xxxx`, title: `Bulk ${i}`, create: 1793000000 + i }));
    }
    const base = createMemoryWriter();
    const events = [];
    const writer = {
      ...base,
      readText: async (p) => { if (p.startsWith('chats/') && p.endsWith('.md')) events.push('read'); return base.readText(p); },
      writeText: async (p, t) => { if (p.startsWith('bundles/')) events.push('bundle'); return base.writeText(p, t); },
    };
    const { engine } = setup({ api, writer });
    await engine.run({});
    const firstBundle = events.indexOf('bundle');
    expect(events.slice(0, firstBundle).filter((e) => e === 'read').length).toBeLessThan(10);
    expect(events.filter((e) => e === 'bundle')).toHaveLength(20);
  });

  test('entries record mdChars; an index without them still bundles', async () => {
    const writer = createMemoryWriter();
    await setup({ writer }).engine.run({});
    const idx = JSON.parse(await writer.readText('index.json'));
    expect(idx.chats[C1].mdChars).toBe((await writer.readText(`chats/${B1}.md`)).length);
    const before = await writer.readText('bundles/bundle-02.md');
    for (const e of Object.values(idx.chats)) delete e.mdChars;
    await writer.writeJson('index.json', idx);
    await writer.writeText('bundles/bundle-02.md', 'stale');
    await setup({ writer, api: createFakeApi() }).engine.run({});
    expect(await writer.readText('bundles/bundle-02.md')).toBe(before);
  });
});

describe('paths built from untrusted ids', () => {
  test('a baseName read back from index.json that is unsafe is recomputed', async () => {
    const writer = createMemoryWriter();
    await setup({ writer }).engine.run({});
    const idx = JSON.parse(await writer.readText('index.json'));
    idx.chats[C1].baseName = '../evil';
    idx.chats[C1].update_time = 'old';
    await writer.writeJson('index.json', idx);
    await setup({ writer }).engine.run({});
    const after = JSON.parse(await writer.readText('index.json'));
    expect(after.chats[C1].baseName).toBe(B1);
    expect([...writer.files.keys()].some((k) => k.includes('..'))).toBe(false);
  });

  test('conversation and file ids with separators stay inside their folders', async () => {
    const api = createFakeApi();
    const evil = '../../etc/x';
    api.addConversation(makeConversation({
      id: evil, title: 'Evil', create: 1793000000, attachments: [{ id: 'file_e1', name: 'a.txt' }],
    }));
    api.addFile('file_e1', { fileName: 'a.txt', mime: 'text/plain', body: 'x' });
    const { engine, writer } = setup({ api });
    await engine.run({});
    expect(engine.getState().done).toBe(4);
    for (const key of writer.files.keys()) {
      expect(key.split('/').includes('..'), key).toBe(false);
      expect(key.startsWith('/'), key).toBe(false);
    }
    expect([...writer.files.keys()].some((k) => k.startsWith('files/') && k.endsWith('/a.txt'))).toBe(true);
  });
});
