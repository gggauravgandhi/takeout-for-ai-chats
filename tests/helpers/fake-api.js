// In-memory fake of the api contract, with scripted failures and call counting.

const iso = (sec) => new Date(sec * 1000).toISOString();

/**
 * Builds a conversation shaped like GET /backend-api/conversation/{id}.
 * @param {{ id: string, title?: string, create?: number, update?: number, gizmo_id?: string|null,
 *   archived?: boolean, attachments?: {id: string, name: string, mime_type?: string}[], pointers?: string[] }} o
 */
export function makeConversation({
  id, title = 'Chat', create = 1792160509, update = create + 8, gizmo_id = null, archived = false,
  attachments = [], pointers = [],
}) {
  const parts = ['answer', ...pointers.map((f) => ({ content_type: 'image_asset_pointer', asset_pointer: `sediment://${f}`, size_bytes: 3 }))];
  return {
    conversation_id: id, title, create_time: create, update_time: update, gizmo_id, is_archived: archived,
    current_node: 'a1',
    mapping: {
      root: { id: 'root', parent: null, children: ['u1'], message: null },
      u1: {
        id: 'u1', parent: 'root', children: ['a1'],
        message: { id: 'u1', author: { role: 'user' }, content: { content_type: 'text', parts: ['question'] }, metadata: { attachments } },
      },
      a1: {
        id: 'a1', parent: 'u1', children: [],
        message: { id: 'a1', author: { role: 'assistant' }, content: { content_type: 'multimodal_text', parts }, metadata: {} },
      },
    },
  };
}

/** Default data set: c3 (archived, custom GPT), c1 (uploads), c2 (project chat). Oldest first: c3, c1, c2. */
export function standardData() {
  return {
    conversations: [
      makeConversation({ id: 'c1000000-aaaa', title: 'Log vitals', create: 1792160509,
        attachments: [{ id: 'file_up1', name: 'photo.jpg', mime_type: 'image/jpeg' }], pointers: ['file_gen1'] }),
      makeConversation({ id: 'c2000000-bbbb', title: 'Project chat', create: 1792250000, gizmo_id: 'g-p-1' }),
      makeConversation({ id: 'c3000000-cccc', title: 'Archived GPT chat', create: 1792000000, gizmo_id: 'g-custom1', archived: true }),
    ],
    projects: [{ id: 'g-p-1', name: 'My Project', files: [{ file_id: 'file_proj1', name: 'spec.pdf' }], conversationIds: ['c2000000-bbbb'] }],
    files: {
      file_up1: { fileName: 'photo.jpg', mime: 'image/jpeg', body: 'JPG' },
      file_gen1: { fileName: 'image.png', mime: 'image/png', body: 'PNG' },
      file_proj1: { fileName: 'spec.pdf', mime: 'application/pdf', body: 'PDF' },
    },
    memories: { memories: [{ id: 'm1', content: 'likes tea' }] },
    instructions: { about_user: 'dev' },
    me: { id: 'user-1', email: 'a@b.c' },
    gizmos: { 'g-custom1': { gizmo: { id: 'g-custom1', display: { name: 'My GPT' } } } },
    session: { accessToken: 't', accountId: 'acc-1', planType: 'team', email: 'a@b.c' },
  };
}

const listItem = (c) => ({
  id: c.conversation_id, title: c.title, create_time: iso(c.create_time), update_time: iso(c.update_time),
  is_archived: c.is_archived, gizmo_id: c.gizmo_id, mapping: null,
});

/**
 * @param {ReturnType<typeof standardData>} [data]
 * @returns the api plus test controls: `calls`, `count(method)`, `fail(method, match, kind, times)`,
 *   `touch(id)` (bump update_time), `hook` (async (method, args) run before every call).
 */
export function createFakeApi(data = standardData()) {
  const convs = new Map(data.conversations.map((c) => [c.conversation_id, structuredClone(c)]));
  const failures = [];
  const ctl = { calls: [], hook: null };

  const err = (kind, message) => Object.assign(new Error(message ?? `fake ${kind} error`), { kind });

  async function run(method, args, fn) {
    ctl.calls.push({ method, args });
    if (ctl.hook) await ctl.hook(method, args);
    const f = failures.find((x) => x.method === method && (x.match === '*' || x.match === args[0]) && x.left > 0);
    if (f) {
      f.left--;
      throw err(f.kind);
    }
    return fn();
  }
  const method = (name, fn) => (...args) => run(name, args, () => fn(...args));
  const listBy = (pred) => [...convs.values()].filter(pred).map(listItem);

  const api = {
    session: method('session', async () => structuredClone(data.session)),
    listConversations: method('listConversations', async ({ archived = false } = {}) => listBy((c) => c.is_archived === archived)),
    listProjects: method('listProjects', async () => data.projects.map((p) => ({ gizmo: { gizmo: { id: p.id, display: { name: p.name } } } }))),
    getProject: method('getProject', async (id) => {
      const p = data.projects.find((x) => x.id === id);
      if (!p) throw err('notfound');
      return { gizmo: { id, display: { name: p.name }, instructions: 'be nice' }, files: structuredClone(p.files) };
    }),
    listProjectConversations: method('listProjectConversations', async (id) => {
      const p = data.projects.find((x) => x.id === id);
      return listBy((c) => p.conversationIds.includes(c.conversation_id));
    }),
    getConversation: method('getConversation', async (id) => {
      if (!convs.has(id)) throw err('notfound');
      return structuredClone(convs.get(id));
    }),
    downloadFile: method('downloadFile', async (fileId) => {
      const f = data.files[fileId];
      if (!f) throw err('notfound');
      return { blob: new Blob([f.body]), fileName: f.fileName, mime: f.mime };
    }),
    getMemories: method('getMemories', async () => structuredClone(data.memories)),
    getCustomInstructions: method('getCustomInstructions', async () => structuredClone(data.instructions)),
    getMe: method('getMe', async () => structuredClone(data.me)),
    getGizmo: method('getGizmo', async (id) => {
      if (!data.gizmos[id]) throw err('notfound');
      return structuredClone(data.gizmos[id]);
    }),
    getGizmosBootstrap: method('getGizmosBootstrap', async () => ({ gizmos: [] })),
  };

  Object.defineProperties(api, {
    calls: { get: () => ctl.calls },
    hook: { set: (fn) => void (ctl.hook = fn) },
  });
  return Object.assign(api, {
    count: (name, firstArg) => ctl.calls.filter((c) => c.method === name && (firstArg === undefined || c.args[0] === firstArg)).length,
    /** Make `method` throw an error with `.kind` when called with first arg `match` ("*" = any). */
    fail: (name, match, kind, times = Infinity) => void failures.push({ method: name, match, kind, left: times }),
    clearFailures: () => void (failures.length = 0),
    touch: (id) => {
      const c = convs.get(id);
      c.update_time += 100;
    },
    addConversation: (c) => void convs.set(c.conversation_id, structuredClone(c)),
    addFile: (id, file) => void (data.files[id] = file),
  });
}
