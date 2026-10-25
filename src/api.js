// ChatGPT internal API client. One request at a time, polite pacing, retries.
// Error messages are shown to end users: keep them readable, never include the token.

const MAX_BACKOFF_MS = 60_000;
const MAX_RETRY_AFTER_MS = 300_000;
const PAGE_SIZE = 100;
const FOREIGN_HOST_RETRIES = 1;
const enc = encodeURIComponent;

export class ApiError extends Error {
  /**
   * @param {'auth'|'notfound'|'rate'|'http'|'network'|'shape'} kind
   * @param {string} message human readable
   * @param {{ status?: number, url?: string }} [info] url is path only
   */
  constructor(kind, message, { status, url } = {}) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
    this.url = url;
  }
}

const pathOf = (url) => new URL(url, 'https://placeholder.invalid').pathname;
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function retryWaitMs(res, attempt, now) {
  const header = res?.headers.get('Retry-After');
  if (header) {
    const seconds = Number(header);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now();
    if (Number.isFinite(ms)) return Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS);
  }
  return Math.min(2 ** attempt * 1000, MAX_BACKOFF_MS);
}

function exhaustedError(res, retried, url) {
  const info = { status: res?.status, url: pathOf(url) };
  const times = `Waited and retried ${retried} times.`;
  if (!res) return new ApiError('network', `Could not reach ChatGPT. Check your connection. ${times}`, info);
  if (res.status === 429) return new ApiError('rate', `ChatGPT is rate limiting requests. ${times}`, info);
  return new ApiError('http', `ChatGPT had a server problem (HTTP ${res.status}). ${times}`, info);
}

/**
 * `loggedOutOn401`: the request carried our token (or is the session lookup), so a 401 means the
 * login is gone. 403 is never auth: it is one item the account may not read (another workspace's
 * GPT, a project file). `foreignHost`: a signed download link on another host.
 */
function statusError(res, url, { loggedOutOn401 = false, foreignHost = false } = {}) {
  const info = { status: res.status, url: pathOf(url) };
  const refused = res.status === 401 || res.status === 403;
  if (res.status === 401 && loggedOutOn401) {
    return new ApiError('auth', 'ChatGPT refused access. Log in again at chatgpt.com, then retry.', info);
  }
  if (foreignHost && (refused || res.status === 404)) {
    return new ApiError('notfound', 'The file link was refused or has expired.', info);
  }
  if (res.status === 404) {
    return new ApiError('notfound', 'ChatGPT could not find this item. It may have been deleted.', info);
  }
  if (refused) {
    return new ApiError(
      'http',
      `ChatGPT refused access to this item (HTTP ${res.status}). It may belong to another workspace.`,
      info,
    );
  }
  return new ApiError('http', `ChatGPT returned an unexpected error (HTTP ${res.status}).`, info);
}

async function readJson(res, url) {
  try {
    return await res.json();
  } catch {
    throw new ApiError('shape', 'ChatGPT sent a reply this tool does not understand.', { url: pathOf(url) });
  }
}

function requireItems(data, url) {
  if (!data || !Array.isArray(data.items)) {
    throw new ApiError('shape', 'ChatGPT sent a list in an unexpected format.', { url: pathOf(url) });
  }
  return data.items;
}

/**
 * Serialized, paced, retrying HTTP layer plus the lazily loaded session.
 * @returns {{ session: Function, request: Function, getJson: Function }}
 */
function createTransport({ fetch: doFetch, base, sleep, delayMs, maxRetries, now, onRetry }) {
  const baseOrigin = new URL(base).origin;
  let tail = Promise.resolve();
  let started = false;
  let current = null;

  const enqueue = (fn) => {
    const run = tail.then(fn);
    tail = run.catch(() => {});
    return run;
  };

  async function send(url, init, retries = maxRetries) {
    if (started && delayMs > 0) await sleep(delayMs);
    started = true;
    for (let attempt = 1; ; attempt += 1) {
      let res = null;
      try {
        res = await doFetch(url, init);
      } catch {
        res = null;
      }
      if (res && res.status !== 429 && res.status < 500) return res;
      if (attempt > retries) throw exhaustedError(res, attempt - 1, url);
      const waitMs = retryWaitMs(res, attempt, now);
      onRetry?.({ attempt, waitMs, status: res?.status, url: pathOf(url) });
      await sleep(waitMs);
    }
  }

  async function loadSession() {
    const url = `${base}/api/auth/session`;
    const res = await send(url, { credentials: 'include' });
    if (res.status === 403) {
      const message = 'ChatGPT refused the login check. Log in again at chatgpt.com, then retry.';
      throw new ApiError('auth', message, { status: 403, url: pathOf(url) });
    }
    if (!res.ok) throw statusError(res, url, { loggedOutOn401: true });
    const data = await readJson(res, url);
    if (!data?.accessToken) {
      throw new ApiError('auth', 'You are logged out of ChatGPT. Log in at chatgpt.com, then try again.', {
        url: pathOf(url),
      });
    }
    return {
      accessToken: data.accessToken,
      accountId: data.account?.id,
      planType: data.account?.planType,
      email: data.user?.email,
    };
  }

  async function attempt(url, auth) {
    // A file host that refuses or blocks a signed link will not change its mind: retry once only.
    if (!auth) return send(url, { headers: {}, credentials: 'omit' }, FOREIGN_HOST_RETRIES);
    current ??= await loadSession();
    const headers = { Authorization: `Bearer ${current.accessToken}` };
    if (current.accountId) headers['ChatGPT-Account-Id'] = current.accountId;
    return send(url, { headers, credentials: 'include' });
  }

  /** `auth: false` sends no token (for third-party download hosts). */
  const request = (url, { auth = true } = {}) =>
    enqueue(async () => {
      let res = await attempt(url, auth);
      if (res.status === 401 && auth) {
        current = null;
        res = await attempt(url, auth);
      }
      if (!res.ok) throw statusError(res, url, { loggedOutOn401: auth, foreignHost: !auth });
      return res;
    });

  const getJson = async (path) => readJson(await request(`${base}${path}`), path);
  const session = () => enqueue(async () => (current ??= await loadSession()));

  return { session, request, getJson, baseOrigin };
}

/**
 * @param {{ fetch?: typeof fetch, base?: string, sleep?: (ms: number) => Promise<void>,
 *   delayMs?: number, maxRetries?: number, now?: () => number,
 *   onRetry?: (info: { attempt: number, waitMs: number, status?: number, url: string }) => void }} [options]
 */
export function createApi({
  fetch: doFetch = globalThis.fetch,
  base = 'https://chatgpt.com',
  sleep = defaultSleep,
  delayMs = 600,
  maxRetries = 5,
  now = Date.now,
  onRetry,
} = {}) {
  const t = createTransport({ fetch: doFetch, base, sleep, delayMs, maxRetries, now, onRetry });

  async function pageByOffset(pathFor) {
    const out = [];
    let offset = 0;
    for (;;) {
      const path = pathFor(offset);
      const data = await t.getJson(path);
      const items = requireItems(data, path);
      if (items.length === 0) return out;
      out.push(...items);
      offset += items.length;
      if (typeof data.total === 'number' && offset >= data.total) return out;
    }
  }

  async function pageByCursor(pathFor, first) {
    const out = [];
    let cursor = first;
    for (;;) {
      const path = pathFor(cursor);
      const data = await t.getJson(path);
      out.push(...requireItems(data, path));
      const next = data.cursor;
      if (next === null || next === undefined || next === cursor) return out;
      cursor = next;
    }
  }

  /** Download metadata, or null when this lookup does not know the file. */
  async function fileMeta(path) {
    try {
      const meta = await t.getJson(path);
      return meta?.status === 'success' && meta.download_url ? meta : null;
    } catch (err) {
      if (err?.kind === 'notfound') return null;
      throw err;
    }
  }

  async function downloadFile(fileId, { conversationId, gizmoId } = {}) {
    const owner = gizmoId ? `gizmo_id=${enc(gizmoId)}` : `conversation_id=${enc(conversationId)}`;
    const path = `/backend-api/files/download/${enc(fileId)}?${owner}&inline=false`;
    // Older file ids (file-service://) may only be known to the plain per-file endpoint.
    // That second lookup is best effort: anything but a login problem keeps the first verdict.
    const fallback = () => fileMeta(`/backend-api/files/${enc(fileId)}/download`).catch((err) => {
      if (err?.kind === 'auth') throw err;
      return null;
    });
    const meta = (await fileMeta(path)) ?? (await fallback());
    if (!meta) {
      throw new ApiError('notfound', 'ChatGPT no longer has this file.', { url: pathOf(`${base}${path}`) });
    }
    const target = new URL(meta.download_url, base);
    if (target.protocol !== 'https:') {
      throw new ApiError('notfound', 'ChatGPT gave a download link this tool will not follow.', { url: pathOf(`${base}${path}`) });
    }
    const res = await t.request(target.href, { auth: target.origin === t.baseOrigin });
    return { blob: await res.blob(), fileName: meta.file_name, mime: meta.mime_type };
  }

  async function getConversation(id) {
    const path = `/backend-api/conversation/${enc(id)}`;
    const data = await t.getJson(path);
    if (!data || typeof data.mapping !== 'object' || data.mapping === null) {
      throw new ApiError('shape', 'ChatGPT sent a chat in an unexpected format.', { url: path });
    }
    return data;
  }

  return {
    session: t.session,
    listConversations: ({ archived = false } = {}) =>
      pageByOffset(
        (offset) =>
          `/backend-api/conversations?offset=${offset}&limit=${PAGE_SIZE}&order=updated${archived ? '&is_archived=true' : ''}`,
      ),
    listProjects: () =>
      pageByCursor(
        (cursor) =>
          `/backend-api/gizmos/snorlax/sidebar?conversations_per_gizmo=0${cursor ? `&cursor=${enc(cursor)}` : ''}`,
      ),
    getProject: (gizmoId) => t.getJson(`/backend-api/gizmos/${enc(gizmoId)}`),
    listProjectConversations: (gizmoId) =>
      pageByCursor((cursor) => `/backend-api/gizmos/${enc(gizmoId)}/conversations?cursor=${enc(cursor)}`, '0'),
    getConversation,
    downloadFile,
    getMemories: () => t.getJson('/backend-api/memories?include_memory_entries=true'),
    getCustomInstructions: () => t.getJson('/backend-api/user_system_messages'),
    getMe: () => t.getJson('/backend-api/me'),
    getGizmo: (id) => t.getJson(`/backend-api/gizmos/${enc(id)}`),
    getGizmosBootstrap: () => t.getJson('/backend-api/gizmos/bootstrap?limit=100'),
  };
}
