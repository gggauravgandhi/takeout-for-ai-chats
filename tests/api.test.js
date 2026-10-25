import { describe, expect, test } from 'bun:test';
import { ApiError, createApi } from '../src/api.js';

const SESSION = {
  accessToken: 'tok-1',
  account: { id: 'acc-1', planType: 'team', structure: 'workspace' },
  user: { email: 'me@example.com' },
};

const reply = (body, status = 200, headers = {}) => () =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
const boom = () => () => {
  throw new TypeError('Failed to fetch');
};

/**
 * Fake fetch scripted per URL fragment. Each route holds a list of reply
 * functions; they are used in order and the last one repeats.
 */
function harness(routes, opts = {}) {
  const calls = [];
  const waits = [];
  const retries = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const lists = Object.entries(routes).map(([fragment, replies]) => [fragment, [...replies]]);
  const fetch = async (url, init = {}) => {
    calls.push({ url, headers: init.headers ?? {}, credentials: init.credentials });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((r) => setTimeout(r, 1));
      const route = lists.find(([fragment]) => url.includes(fragment));
      if (!route) return new Response('unrouted', { status: 418 });
      const replies = route[1];
      const next = replies.length > 1 ? replies.shift() : replies[0];
      return next(url, init);
    } finally {
      inFlight -= 1;
    }
  };
  const api = createApi({
    fetch,
    sleep: async (ms) => {
      waits.push(ms);
    },
    delayMs: 0,
    onRetry: (info) => retries.push(info),
    ...opts,
  });
  return { api, calls, waits, retries, maxInFlight: () => maxInFlight };
}

const SESSION_ROUTE = { '/api/auth/session': [reply(SESSION)] };
const failure = async (promise) => {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error('expected rejection');
};
const offsetOf = (url) => Number(new URL(url).searchParams.get('offset'));

describe('session and headers', () => {
  test('fetches the session once, lazily, with cookies', async () => {
    const h = harness({ ...SESSION_ROUTE, '/backend-api/me': [reply({ id: 'u' })] });
    expect(h.calls.length).toBe(0);
    await h.api.getMe();
    await h.api.getMe();
    const sessionCalls = h.calls.filter((c) => c.url.endsWith('/api/auth/session'));
    expect(sessionCalls.length).toBe(1);
    expect(sessionCalls[0].url).toBe('https://chatgpt.com/api/auth/session');
    expect(sessionCalls[0].credentials).toBe('include');
  });

  test('sends bearer token and account id on backend calls', async () => {
    const h = harness({ ...SESSION_ROUTE, '/backend-api/me': [reply({ id: 'u' })] });
    expect(await h.api.getMe()).toEqual({ id: 'u' });
    const call = h.calls.find((c) => c.url.includes('/backend-api/me'));
    expect(call.headers.Authorization).toBe('Bearer tok-1');
    expect(call.headers['ChatGPT-Account-Id']).toBe('acc-1');
  });

  test('session() returns the normalized shape', async () => {
    const h = harness(SESSION_ROUTE);
    expect(await h.api.session()).toEqual({
      accessToken: 'tok-1',
      accountId: 'acc-1',
      planType: 'team',
      email: 'me@example.com',
    });
  });

  test('logged-out session throws auth', async () => {
    const h = harness({ '/api/auth/session': [reply({})] });
    const err = await failure(h.api.session());
    expect(err).toBeInstanceOf(ApiError);
    expect(err.kind).toBe('auth');
    expect(err.message).toMatch(/log in/i);
  });

  test('uses the base option', async () => {
    const h = harness(SESSION_ROUTE, { base: 'https://chat.example.org' });
    await h.api.session();
    expect(h.calls[0].url).toBe('https://chat.example.org/api/auth/session');
  });
});

describe('listing', () => {
  const page = (total, size = 100) => (url) => {
    const offset = offsetOf(url);
    const n = Math.max(0, Math.min(size, total - offset));
    const items = Array.from({ length: n }, (_, i) => ({ id: `c${offset + i}` }));
    return new Response(JSON.stringify({ items, total, limit: size, offset }));
  };

  test('pages by offset until offset reaches total', async () => {
    const h = harness({ ...SESSION_ROUTE, '/backend-api/conversations?': [page(250)] });
    const items = await h.api.listConversations();
    expect(items.length).toBe(250);
    expect(items[249].id).toBe('c249');
    const urls = h.calls.filter((c) => c.url.includes('/conversations?')).map((c) => c.url);
    expect(urls.length).toBe(3);
    expect(urls[0]).toContain('offset=0&limit=100&order=updated');
    expect(urls[0]).not.toContain('is_archived');
  });

  test('stops on an empty page even if total says more', async () => {
    const h = harness({ ...SESSION_ROUTE, '/backend-api/conversations?': [page(999, 0)] });
    expect(await h.api.listConversations()).toEqual([]);
    expect(h.calls.filter((c) => c.url.includes('/conversations?')).length).toBe(1);
  });

  test('archived flag adds is_archived=true', async () => {
    const h = harness({ ...SESSION_ROUTE, '/backend-api/conversations?': [page(1)] });
    await h.api.listConversations({ archived: true });
    expect(h.calls.at(-1).url).toContain('&is_archived=true');
  });

  test('list without items array throws shape', async () => {
    const h = harness({ ...SESSION_ROUTE, '/backend-api/conversations?': [reply({ total: 3 })] });
    expect((await failure(h.api.listConversations())).kind).toBe('shape');
  });

  test('listProjects follows the cursor and concatenates raw items', async () => {
    const h = harness({
      ...SESSION_ROUTE,
      '/gizmos/snorlax/sidebar': [
        reply({ items: [{ a: 1 }], cursor: 'next-1' }),
        reply({ items: [{ a: 2 }], cursor: null }),
      ],
    });
    expect(await h.api.listProjects()).toEqual([{ a: 1 }, { a: 2 }]);
    const urls = h.calls.filter((c) => c.url.includes('snorlax')).map((c) => c.url);
    expect(urls[0]).toContain('conversations_per_gizmo=0');
    expect(urls[0]).not.toContain('cursor=');
    expect(urls[1]).toContain('cursor=next-1');
  });

  test('listProjectConversations starts at cursor=0 and passes cursors back', async () => {
    const h = harness({
      ...SESSION_ROUTE,
      '/gizmos/g-p-1/conversations': [
        reply({ items: [{ id: 'a' }], cursor: 'z9' }),
        reply({ items: [{ id: 'b' }], cursor: null }),
      ],
    });
    const items = await h.api.listProjectConversations('g-p-1');
    expect(items.map((i) => i.id)).toEqual(['a', 'b']);
    const urls = h.calls.filter((c) => c.url.includes('g-p-1/conversations')).map((c) => c.url);
    expect(urls[0]).toContain('cursor=0');
    expect(urls[1]).toContain('cursor=z9');
  });

  test('getProject and getConversation return raw JSON', async () => {
    const h = harness({
      ...SESSION_ROUTE,
      '/gizmos/g-p-1': [reply({ gizmo: { id: 'g-p-1' }, files: [] })],
      '/backend-api/conversation/c1': [reply({ mapping: {}, current_node: 'n' })],
    });
    expect((await h.api.getProject('g-p-1')).gizmo.id).toBe('g-p-1');
    expect((await h.api.getConversation('c1')).current_node).toBe('n');
  });

  test('conversation without mapping throws shape', async () => {
    const h = harness({ ...SESSION_ROUTE, '/backend-api/conversation/c1': [reply({ title: 'x' })] });
    expect((await failure(h.api.getConversation('c1'))).kind).toBe('shape');
  });

  test('non-JSON body throws shape', async () => {
    const h = harness({ ...SESSION_ROUTE, '/backend-api/me': [reply('<html>nope</html>')] });
    expect((await failure(h.api.getMe())).kind).toBe('shape');
  });

  test('misc endpoints hit the right paths', async () => {
    const h = harness({
      ...SESSION_ROUTE,
      '/backend-api/memories': [reply({ m: 1 })],
      '/backend-api/user_system_messages': [reply({ s: 1 })],
      '/backend-api/gizmos/bootstrap': [reply({ b: 1 })],
      '/backend-api/gizmos/g-1': [reply({ g: 1 })],
    });
    expect(await h.api.getMemories()).toEqual({ m: 1 });
    expect(await h.api.getCustomInstructions()).toEqual({ s: 1 });
    expect(await h.api.getGizmosBootstrap()).toEqual({ b: 1 });
    expect(await h.api.getGizmo('g-1')).toEqual({ g: 1 });
    expect(h.calls.some((c) => c.url.includes('memories?include_memory_entries=true'))).toBe(true);
    expect(h.calls.some((c) => c.url.includes('bootstrap?limit=100'))).toBe(true);
  });
});

describe('retries and errors', () => {
  test('429 with Retry-After seconds waits that long then succeeds', async () => {
    const h = harness({
      ...SESSION_ROUTE,
      '/backend-api/me': [reply('', 429, { 'Retry-After': '3' }), reply({ ok: 1 })],
    });
    expect(await h.api.getMe()).toEqual({ ok: 1 });
    expect(h.waits).toEqual([3000]);
  });

  test('Retry-After as HTTP date is honored', async () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    const when = new Date(now + 10_000).toUTCString();
    const h = harness(
      {
        ...SESSION_ROUTE,
        '/backend-api/me': [reply('', 429, { 'Retry-After': when }), reply({ ok: 1 })],
      },
      { now: () => now },
    );
    await h.api.getMe();
    expect(h.waits).toEqual([10_000]);
  });

  test('503 backs off 2, 4, 8 seconds and reports each retry', async () => {
    const h = harness({
      ...SESSION_ROUTE,
      '/backend-api/me': [reply('', 503), reply('', 503), reply('', 503), reply({ ok: 1 })],
    });
    await h.api.getMe();
    expect(h.waits).toEqual([2000, 4000, 8000]);
    expect(h.retries.map((r) => r.attempt)).toEqual([1, 2, 3]);
    expect(h.retries[0]).toEqual({ attempt: 1, waitMs: 2000, status: 503, url: '/backend-api/me' });
  });

  test('backoff is capped at 60 seconds', async () => {
    const h = harness(
      { ...SESSION_ROUTE, '/backend-api/me': [reply('', 503)] },
      { maxRetries: 7 },
    );
    await failure(h.api.getMe());
    expect(h.waits).toEqual([2000, 4000, 8000, 16000, 32000, 60000, 60000]);
  });

  test('exhausted 429 throws rate with a readable message', async () => {
    const h = harness(
      { ...SESSION_ROUTE, '/backend-api/me': [reply('', 429)] },
      { maxRetries: 2 },
    );
    const err = await failure(h.api.getMe());
    expect(err.kind).toBe('rate');
    expect(err.status).toBe(429);
    expect(err.message).toBe('ChatGPT is rate limiting requests. Waited and retried 2 times.');
    expect(h.waits.length).toBe(2);
  });

  test('exhausted 5xx throws http', async () => {
    const h = harness(
      { ...SESSION_ROUTE, '/backend-api/me': [reply('', 502)] },
      { maxRetries: 1 },
    );
    const err = await failure(h.api.getMe());
    expect(err.kind).toBe('http');
    expect(err.status).toBe(502);
  });

  test('network errors are retried', async () => {
    const h = harness({ ...SESSION_ROUTE, '/backend-api/me': [boom(), reply({ ok: 1 })] });
    expect(await h.api.getMe()).toEqual({ ok: 1 });
    expect(h.waits).toEqual([2000]);
    expect(h.retries[0].status).toBeUndefined();
  });

  test('exhausted network errors throw network', async () => {
    const h = harness({ ...SESSION_ROUTE, '/backend-api/me': [boom()] }, { maxRetries: 1 });
    const err = await failure(h.api.getMe());
    expect(err.kind).toBe('network');
  });

  test('401 refreshes the session once and retries with the new token', async () => {
    const h = harness({
      '/api/auth/session': [reply(SESSION), reply({ ...SESSION, accessToken: 'tok-2' })],
      '/backend-api/me': [reply('', 401), reply({ ok: 1 })],
    });
    expect(await h.api.getMe()).toEqual({ ok: 1 });
    const meCalls = h.calls.filter((c) => c.url.includes('/backend-api/me'));
    expect(meCalls[0].headers.Authorization).toBe('Bearer tok-1');
    expect(meCalls[1].headers.Authorization).toBe('Bearer tok-2');
    expect(h.calls.filter((c) => c.url.endsWith('/api/auth/session')).length).toBe(2);
  });

  test('401 twice throws auth without leaking the token', async () => {
    const h = harness({ ...SESSION_ROUTE, '/backend-api/me': [reply('', 401)] });
    const err = await failure(h.api.getMe());
    expect(err.kind).toBe('auth');
    expect(err.status).toBe(401);
    expect(err.url).toBe('/backend-api/me');
    expect(`${err.message} ${err.url}`).not.toContain('tok-1');
  });

  test('403 on an item is a per-item http error, not auth', async () => {
    const h = harness({ ...SESSION_ROUTE, '/backend-api/me': [reply('', 403)] });
    const err = await failure(h.api.getMe());
    expect(err.kind).toBe('http');
    expect(err.status).toBe(403);
    expect(err.message).toMatch(/workspace/i);
    expect(h.calls.filter((c) => c.url.endsWith('/api/auth/session')).length).toBe(1);
  });

  test('403 on a GPT from another workspace does not look like a logout', async () => {
    const h = harness({ ...SESSION_ROUTE, '/backend-api/gizmos/g-x': [reply('', 403)] });
    expect((await failure(h.api.getGizmo('g-x'))).kind).toBe('http');
  });

  test('401 or 403 from the session endpoint itself is auth', async () => {
    for (const status of [401, 403]) {
      const h = harness({ '/api/auth/session': [reply('', status)] });
      expect((await failure(h.api.session())).kind).toBe('auth');
    }
  });

  test('404 throws notfound without retrying', async () => {
    const h = harness({ ...SESSION_ROUTE, '/backend-api/conversation/c1': [reply('', 404)] });
    const err = await failure(h.api.getConversation('c1'));
    expect(err.kind).toBe('notfound');
    expect(h.waits).toEqual([]);
  });

  test('error urls drop the query string', async () => {
    const h = harness({ ...SESSION_ROUTE, '/backend-api/conversations?': [reply('', 404)] });
    const err = await failure(h.api.listConversations());
    expect(err.url).toBe('/backend-api/conversations');
  });
});

describe('downloadFile: older file ids and file hosts', () => {
  const FOREIGN = 'https://files.oaiusercontent.com/file-Old?sig=abc';

  test('falls back to /backend-api/files/{id}/download when the conversation lookup is 404', async () => {
    const { api, calls } = harness({
      ...SESSION_ROUTE,
      '/backend-api/files/download/file-Old': [reply({ detail: 'not found' }, 404)],
      '/backend-api/files/file-Old/download': [reply({ status: 'success', download_url: FOREIGN, file_name: 'old.png', mime_type: 'image/png' })],
      'files.oaiusercontent.com': [reply('PNGDATA')],
    });
    const out = await api.downloadFile('file-Old', { conversationId: 'c1' });
    expect(out.fileName).toBe('old.png');
    expect(await out.blob.text()).toBe('PNGDATA');
    const host = calls.find((c) => c.url.startsWith('https://files.oaiusercontent.com'));
    expect(host.headers.Authorization).toBeUndefined();
    expect(host.credentials).toBe('omit');
  });

  test('falls back when the conversation lookup says status is not success', async () => {
    const { api } = harness({
      ...SESSION_ROUTE,
      '/backend-api/files/download/file-Old': [reply({ status: 'error', error_code: 'file_not_found' })],
      '/backend-api/files/file-Old/download': [reply({ status: 'success', download_url: FOREIGN, file_name: 'old.png' })],
      'files.oaiusercontent.com': [reply('X')],
    });
    expect((await api.downloadFile('file-Old', { conversationId: 'c1' })).fileName).toBe('old.png');
  });

  test('both lookups missing is notfound', async () => {
    const { api } = harness({
      ...SESSION_ROUTE,
      '/backend-api/files/download/file-Gone': [reply({}, 404)],
      '/backend-api/files/file-Gone/download': [reply({}, 404)],
    });
    expect((await failure(api.downloadFile('file-Gone', { conversationId: 'c1' }))).kind).toBe('notfound');
  });

  test('a file host that blocks the request (network error) is retried once, not five times', async () => {
    const { api, retries } = harness({
      ...SESSION_ROUTE,
      '/backend-api/files/download/file-Cors': [reply({ status: 'success', download_url: 'https://files.oaiusercontent.com/x', file_name: 'a.png' })],
      'files.oaiusercontent.com': [boom()],
    });
    const err = await failure(api.downloadFile('file-Cors', { conversationId: 'c1' }));
    expect(err).toBeInstanceOf(ApiError);
    expect(retries.length).toBe(1);
  });
});

describe('downloadFile', () => {
  const meta = (download_url) =>
    reply({ status: 'success', download_url, file_name: 'a.png', mime_type: 'image/png', file_size_bytes: 3 });

  test('relative download_url resolves against base and sends auth', async () => {
    const h = harness({
      ...SESSION_ROUTE,
      '/files/download/f1': [meta('/backend-api/estuary/content?id=f1')],
      '/estuary/content': [reply('abc')],
    });
    const out = await h.api.downloadFile('f1', { conversationId: 'c1' });
    expect(out.fileName).toBe('a.png');
    expect(out.mime).toBe('image/png');
    expect(await out.blob.text()).toBe('abc');
    const metaCall = h.calls.find((c) => c.url.includes('/files/download/f1'));
    expect(metaCall.url).toContain('conversation_id=c1&inline=false');
    const dl = h.calls.find((c) => c.url.includes('/estuary/content'));
    expect(dl.url).toBe('https://chatgpt.com/backend-api/estuary/content?id=f1');
    expect(dl.headers.Authorization).toBe('Bearer tok-1');
  });

  test('absolute same-origin download_url also gets auth', async () => {
    const h = harness({
      ...SESSION_ROUTE,
      '/files/download/f1': [meta('https://chatgpt.com/backend-api/estuary/content?id=f1')],
      '/estuary/content': [reply('abc')],
    });
    await h.api.downloadFile('f1', { conversationId: 'c1' });
    const dl = h.calls.find((c) => c.url.includes('/estuary/content'));
    expect(dl.headers.Authorization).toBe('Bearer tok-1');
  });

  test('foreign origin never receives the token or account id', async () => {
    const h = harness({
      ...SESSION_ROUTE,
      '/files/download/f1': [meta('https://files.example.com/blob?sig=1')],
      'files.example.com': [reply('xyz')],
    });
    const out = await h.api.downloadFile('f1', { conversationId: 'c1' });
    expect(await out.blob.text()).toBe('xyz');
    const dl = h.calls.find((c) => c.url.includes('files.example.com'));
    expect(dl.headers.Authorization).toBeUndefined();
    expect(dl.headers['ChatGPT-Account-Id']).toBeUndefined();
    expect(dl.credentials).not.toBe('include');
  });

  test('401 or 403 from the download host is notfound, never auth', async () => {
    for (const status of [401, 403]) {
      const h = harness({
        ...SESSION_ROUTE,
        '/files/download/f1': [meta('https://files.example.com/blob?sig=1')],
        'files.example.com': [reply('', status)],
      });
      expect((await failure(h.api.downloadFile('f1', { conversationId: 'c1' }))).kind).toBe('notfound');
    }
  });

  test('403 from the same-origin download content is http, not auth', async () => {
    const h = harness({
      ...SESSION_ROUTE,
      '/files/download/f1': [meta('/backend-api/estuary/content?id=f1')],
      '/estuary/content': [reply('', 403)],
    });
    expect((await failure(h.api.downloadFile('f1', { conversationId: 'c1' }))).kind).toBe('http');
  });

  test('download_url must be https', async () => {
    for (const url of ['http://chatgpt.com/backend-api/x', 'javascript:alert(1)', 'data:text/plain,hi', 'ftp://files.example.com/a']) {
      const h = harness({ ...SESSION_ROUTE, '/files/download/f1': [meta(url)] });
      expect((await failure(h.api.downloadFile('f1', { conversationId: 'c1' }))).kind).toBe('notfound');
      expect(h.calls.length).toBe(2); // session + lookup only, the target was never fetched
    }
  });

  test('lookalike hosts never get Authorization on the initial request', async () => {
    for (const url of ['https://chatgpt.com.evil.example/blob', 'https://evil.example/chatgpt.com', 'https://chatgpt.com:8443/blob']) {
      const h = harness({
        ...SESSION_ROUTE,
        '/files/download/f1': [meta(url)],
        'evil.example': [reply('x')],
        ':8443': [reply('x')],
      });
      await h.api.downloadFile('f1', { conversationId: 'c1' });
      const dl = h.calls[h.calls.length - 1];
      expect(dl.url).toBe(url);
      expect(dl.headers.Authorization).toBeUndefined();
      expect(dl.headers['ChatGPT-Account-Id']).toBeUndefined();
    }
  });

  test('project files use gizmo_id', async () => {
    const h = harness({
      ...SESSION_ROUTE,
      '/files/download/f2': [meta('/backend-api/estuary/content?id=f2')],
      '/estuary/content': [reply('abc')],
    });
    await h.api.downloadFile('f2', { gizmoId: 'g-p-1' });
    const metaCall = h.calls.find((c) => c.url.includes('/files/download/f2'));
    expect(metaCall.url).toContain('gizmo_id=g-p-1&inline=false');
    expect(metaCall.url).not.toContain('conversation_id');
  });

  test('status other than success throws notfound', async () => {
    const h = harness({
      ...SESSION_ROUTE,
      '/files/download/f1': [reply({ status: 'error', error_code: 'file_not_found' })],
    });
    expect((await failure(h.api.downloadFile('f1', { conversationId: 'c1' }))).kind).toBe('notfound');
  });

  test('404 on the file lookup throws notfound', async () => {
    const h = harness({ ...SESSION_ROUTE, '/files/download/f1': [reply('', 404)] });
    expect((await failure(h.api.downloadFile('f1', { conversationId: 'c1' }))).kind).toBe('notfound');
  });
});

describe('pacing', () => {
  test('concurrent callers never overlap and observe delayMs', async () => {
    const h = harness(
      {
        ...SESSION_ROUTE,
        '/backend-api/memories': [reply({ m: 1 })],
        '/backend-api/me': [reply({ me: 1 })],
      },
      { delayMs: 7 },
    );
    const [a, b] = await Promise.all([h.api.getMe(), h.api.getMemories()]);
    expect(a).toEqual({ me: 1 });
    expect(b).toEqual({ m: 1 });
    expect(h.maxInFlight()).toBe(1);
    expect(h.waits).toEqual([7, 7]);
  });

  test('a failed request does not block the queue', async () => {
    const h = harness({
      ...SESSION_ROUTE,
      '/backend-api/conversation/c1': [reply('', 404)],
      '/backend-api/me': [reply({ me: 1 })],
    });
    const [bad, good] = await Promise.allSettled([h.api.getConversation('c1'), h.api.getMe()]);
    expect(bad.status).toBe('rejected');
    expect(good.status).toBe('fulfilled');
  });
});
