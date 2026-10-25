// The export run: owns state, resume (index.json) and the pause/stop/skip controls.
import { STOP, accountPhase, chatsPhase, errMsg, finishPhase, listChats, mustPropagate } from './engine-steps.js';

const INDEX_PATH = 'index.json';
const SAVE_EVERY_CHATS = 25;
const SAVE_EVERY_MS = 5000;
const THROTTLE_LIMIT = 3;
const THROTTLE_KINDS = new Set(['rate', 'network']);
const THROTTLE_MESSAGES = {
  rate: 'ChatGPT is rate limiting this export. Paused; press Resume in a few minutes.',
  network: 'Cannot reach ChatGPT. Paused; check your connection, then press Resume.',
};
const COUNTED = new Set(['done', 'partial', 'failed', 'skipped']);
const now = () => new Date().toISOString();

const emptyIndex = () => ({ version: 1, exportedAt: null, account: null, chats: {}, accountErrors: {} });

const initialState = () => ({
  phase: 'idle', total: 0, done: 0, partial: 0, failed: 0, skipped: 0, filesSaved: 0,
  current: null, failures: [], error: null, errorKind: null, startedAt: null, finishedAt: null,
});

const snapshot = (s) => ({
  ...s,
  current: s.current ? { ...s.current } : null,
  failures: s.failures.map((f) => ({ ...f })),
});

/**
 * Running counts over every chat in the index, updated by delta so each change is O(1).
 * @param {Record<string, any>} chats index.json "chats"
 */
function createTally(chats) {
  const counts = { done: 0, partial: 0, failed: 0, skipped: 0 };
  const failures = new Map();
  let files = 0;
  const apply = (id, e, sign) => {
    if (!e) return;
    if (COUNTED.has(e.status)) counts[e.status] += sign;
    if (Array.isArray(e.files)) files += sign * e.files.filter((f) => f?.status === 'done').length;
    if (e.status !== 'failed' && e.status !== 'partial') return;
    if (sign > 0) failures.set(id, { id, title: e.title, error: e.error });
    else failures.delete(id);
  };
  for (const [id, e] of Object.entries(chats)) apply(id, e, 1);
  return {
    replace: (id, previous, next) => {
      apply(id, previous, -1);
      apply(id, next, 1);
    },
    files: () => files,
    view: () => ({ ...counts, filesSaved: files, failures: [...failures.values()] }),
  };
}

async function loadIndex(writer, log) {
  const raw = await writer.readText(INDEX_PATH);
  if (raw === null) return emptyIndex();
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.chats === 'object' && parsed.chats !== null) return { ...emptyIndex(), ...parsed };
  } catch {
    // fall through to the backup below
  }
  const backup = `index.corrupt-${Date.now()}.json`;
  await writer.writeText(backup, raw);
  log(`index.json was corrupt: saved a copy as ${backup} and starting fresh`);
  return emptyIndex();
}

/**
 * @param {{ api: any, writer: any, onState?: (s: object) => void, onLog?: (line: string) => void }} deps
 * @returns {{ run: (opts?: { mode?: 'all'|'retry-failed' }) => Promise<void>, pause: () => void, resume: () => void,
 *   stop: () => void, skip: (chatId: string) => void, getState: () => object }}
 */
export function createEngine({ api, writer, onState = () => {}, onLog = () => {} }) {
  let state = initialState();
  let index = null;
  let running = false;
  let paused = false;
  let stopped = false;
  let wake = null;
  let saving = Promise.resolve();
  let tally = createTally({});
  let projectFiles = 0;
  let dirty = 0;
  let lastFlushAt = 0;
  let strikes = 0;
  const skips = new Set();

  const set = (patch) => {
    state = { ...state, ...patch };
    onState(snapshot(state));
  };

  const countsPatch = () => {
    const view = tally.view();
    return { ...view, filesSaved: view.filesSaved + projectFiles };
  };

  const setEntry = (entry) => {
    tally.replace(entry.id, index.chats[entry.id], entry);
    index = { ...index, chats: { ...index.chats, [entry.id]: entry } };
  };
  const write = (value) => (saving = saving.catch(() => {}).then(() => writer.writeJson(INDEX_PATH, value)));
  // index.json is rewritten in full, so saves are batched: every 25 chats or 5 seconds, and
  // always on pause, stop, error and finish. A crash loses at most that many chats of progress.
  async function flush() {
    dirty = 0;
    lastFlushAt = Date.now();
    await write(index);
  }
  async function scheduleSave() {
    dirty += 1;
    if (dirty >= SAVE_EVERY_CHATS || Date.now() - lastFlushAt >= SAVE_EVERY_MS) await flush();
  }

  async function gate() {
    while (paused && !stopped) {
      const before = state.phase;
      if (index) await flush().catch((e) => onLog(`Could not save index.json: ${errMsg(e)}`));
      set({ phase: 'paused' });
      await new Promise((resolve) => { wake = resolve; });
      if (!stopped) set({ phase: before, error: null, errorKind: null });
    }
    if (stopped) throw STOP;
  }

  const recordAccountError = (name, message) => {
    index = { ...index, accountErrors: { ...index.accountErrors, [name]: message } };
  };

  async function attempt(name, fn) {
    try {
      return await fn();
    } catch (err) {
      if (mustPropagate(err)) throw err;
      recordAccountError(name, errMsg(err));
      onLog(`Skipped ${name}: ${errMsg(err)}`);
      return undefined;
    }
  }

  const ctx = {
    writer,
    skips,
    log: onLog,
    attempt,
    gate,
    recordAccountError,
    get index() { return index; },
    setEntry,
    call: async (method, ...args) => {
      await gate();
      return api[method](...args);
    },
    resetAccountErrors: () => { index = { ...index, accountErrors: {} }; },
    addProjectFile: () => {
      projectFiles++;
      set({ filesSaved: tally.files() + projectFiles });
    },
    setCurrent: (current) => set({ current }),
    begin: (ids) => set({ total: new Set([...Object.keys(index.chats), ...ids]).size, ...countsPatch() }),
    /** Records a finished chat: updates counts, batches the index save, emits one state. */
    commit: async (entry, extra = {}) => {
      setEntry(entry);
      await scheduleSave();
      set({ ...countsPatch(), ...extra });
    },
    /** Pass the error of a failed chat, or null on success. True means the run is now paused. */
    throttle: (err) => {
      if (!THROTTLE_KINDS.has(err?.kind)) {
        strikes = 0;
        return false;
      }
      strikes += 1;
      if (strikes < THROTTLE_LIMIT) return false;
      strikes = 0;
      paused = true;
      set({ error: THROTTLE_MESSAGES[err.kind], errorKind: 'rate', current: null });
      return true;
    },
  };

  async function execute(mode) {
    await saving.catch(() => {});
    index = await loadIndex(writer, onLog);
    tally = createTally(index.chats);
    set({ total: Object.keys(index.chats).length, ...countsPatch() });
    const session = await ctx.call('session');
    index = { ...index, account: { planType: session.planType ?? null, accountId: session.accountId ?? null } };
    let found = { chatProject: new Map(), projectItems: [] };
    if (mode === 'all') found = await accountPhase(ctx);
    set({ phase: 'listing' });
    const items = await listChats(ctx, found.projectItems);
    set({ phase: 'chats' });
    await chatsPhase(ctx, items, found.chatProject, mode);
    await gate();
    set({ phase: 'finishing' });
    const exportedAt = now();
    await finishPhase(ctx, items, mode, exportedAt);
    index = { ...index, exportedAt };
    await flush();
    set({ phase: 'done', finishedAt: now() });
  }

  async function finishFailed(err) {
    const stoppedByUser = err === STOP;
    set(stoppedByUser
      ? { phase: 'stopped', current: null, error: null, errorKind: null, finishedAt: now() }
      : { phase: 'error', current: null, error: errMsg(err), errorKind: err?.kind ?? 'unknown', finishedAt: now() });
    if (!stoppedByUser) onLog(`Export stopped by an error: ${errMsg(err)}`);
    if (index) await flush().catch((e) => onLog(`Could not save index.json: ${errMsg(e)}`));
  }

  async function skipInRun(chatId) {
    const entry = index?.chats[chatId];
    if (!entry || state.current?.id === chatId || entry.status === 'skipped') return;
    await ctx.commit({ ...entry, status: 'skipped' }).catch((e) => onLog(`Could not save index.json: ${errMsg(e)}`));
  }

  return {
    async run({ mode = 'all' } = {}) {
      if (running) throw new Error('An export is already running');
      running = true;
      paused = false;
      stopped = false;
      index = null;
      tally = createTally({});
      projectFiles = 0;
      dirty = 0;
      strikes = 0;
      lastFlushAt = Date.now();
      state = { ...initialState(), phase: 'account', startedAt: now() };
      set({});
      try {
        await execute(mode);
      } catch (err) {
        await finishFailed(err);
      } finally {
        running = false;
      }
    },
    pause() { paused = true; },
    resume() {
      paused = false;
      wake?.();
    },
    stop() {
      stopped = true;
      wake?.();
    },
    async skip(chatId) {
      skips.add(chatId);
      if (running) return skipInRun(chatId);
      // Idle engine (e.g. the page was reloaded): persist straight to index.json so it is not lost.
      const loaded = await loadIndex(writer, onLog);
      if (running) return; // a run started meanwhile and honours `skips`; do not replace its index
      index = loaded;
      tally = createTally(loaded.chats);
      const entry = loaded.chats[chatId];
      const changed = Boolean(entry) && entry.status !== 'skipped';
      if (changed) setEntry({ ...entry, status: 'skipped' });
      set({ total: Math.max(state.total, Object.keys(index.chats).length), ...countsPatch() });
      if (changed) await write(index).catch((e) => onLog(`Could not save index.json: ${errMsg(e)}`));
    },
    getState: () => snapshot(state),
  };
}
