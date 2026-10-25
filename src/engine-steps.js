// Steps of the export run. Each takes the engine context `ctx` (see engine.js), so they stay small and testable.
import { extractFileRefs } from './extract.js';
import {
  buildBundles, renderChat, renderCustomInstructions, renderGpts, renderIndex, renderMemories, renderProjects,
} from './markdown.js';
import { chatBaseName, isSafeBaseName, safeFileName, slugify, toDate, uniqueName } from './names.js';

/** Thrown from the control gate when stop() was called. */
export const STOP = new Error('Export stopped');

const FATAL_KINDS = new Set(['auth', 'shape']);
const EXT_BY_MIME = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'application/pdf': '.pdf' };

/** @param {any} err @returns {boolean} true when the run cannot continue past this error */
export const mustPropagate = (err) =>
  err === STOP || FATAL_KINDS.has(err?.kind) || err?.name === 'NotAllowedError' || err?.name === 'SecurityError';

/** @param {any} err @returns {string} */
export const errMsg = (err) => err?.message ?? String(err);

const toIso = (t) => toDate(t)?.toISOString() ?? null;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const isCustomGpt = (id) => typeof id === 'string' && id.startsWith('g-') && !id.startsWith('g-p-');

// ---------- account phase ----------

const SIMPLE_ACCOUNT_STEPS = [
  ['memories', 'getMemories', renderMemories],
  ['custom-instructions', 'getCustomInstructions', renderCustomInstructions],
  ['me', 'getMe', null],
];

async function writeAccount(ctx, name, json, render) {
  await ctx.writer.writeJson(`account/${name}.json`, json);
  if (render) await ctx.writer.writeText(`account/${name}.md`, render(json));
}

const projectIdOf = (item) => item?.gizmo?.gizmo?.id ?? item?.gizmo?.id ?? item?.id ?? null;
const projectNameOf = (proj, id) => proj?.gizmo?.display?.name ?? proj?.gizmo?.name ?? id;

async function saveProjectFiles(ctx, projectId, slug, files) {
  const taken = new Set();
  for (const f of files) {
    const fileId = f.file_id ?? f.id;
    if (!fileId) continue;
    await ctx.attempt(`project-file:${fileId}`, async () => {
      const { blob, fileName } = await ctx.call('downloadFile', fileId, { gizmoId: projectId });
      const name = uniqueName(safeFileName(f.name ?? f.file_name ?? fileName ?? fileId), taken);
      taken.add(name);
      await ctx.writer.writeBlob(`account/projects/${slug}/files/${name}`, blob);
      ctx.addProjectFile();
    });
  }
}

async function collectProject(ctx, item, slugs) {
  const id = projectIdOf(item);
  if (!id) return null;
  const proj = await ctx.attempt(`project:${id}`, () => ctx.call('getProject', id));
  const convs = (await ctx.attempt(`project-chats:${id}`, () => ctx.call('listProjectConversations', id))) ?? [];
  const name = projectNameOf(proj, id);
  const slug = uniqueName(slugify(name), slugs);
  slugs.add(slug);
  if (proj) await saveProjectFiles(ctx, id, slug, proj.files ?? []);
  return {
    project: { id, name },
    convs,
    entry: proj ? { gizmo: proj.gizmo, files: proj.files ?? [], conversationIds: convs.map((c) => c.id) } : null,
  };
}

async function projectsStep(ctx) {
  const chatProject = new Map();
  const projectItems = [];
  const collected = [];
  const listed = await ctx.attempt('projects', () => ctx.call('listProjects'));
  const slugs = new Set();
  for (const item of listed ?? []) {
    const got = await collectProject(ctx, item, slugs);
    if (!got) continue;
    for (const c of got.convs) chatProject.set(c.id, got.project);
    projectItems.push(...got.convs);
    if (got.entry) collected.push(got.entry);
  }
  if (listed) await writeAccount(ctx, 'projects', collected, renderProjects);
  return { chatProject, projectItems };
}

/**
 * Memory, custom instructions, me, projects. Non-fatal failures go to index.accountErrors.
 * @returns {Promise<{ chatProject: Map<string, {id: string, name: string}>, projectItems: any[] }>}
 */
export async function accountPhase(ctx) {
  ctx.resetAccountErrors();
  for (const [name, method, render] of SIMPLE_ACCOUNT_STEPS) {
    await ctx.attempt(name, async () => writeAccount(ctx, name, await ctx.call(method), render));
  }
  return projectsStep(ctx);
}

// ---------- listing ----------

function mergeItem(prev, item, archivedHint) {
  const base = prev ?? item;
  return {
    ...base,
    archived: Boolean(prev?.archived || item.is_archived || archivedHint),
    gizmo_id: base.gizmo_id ?? item.gizmo_id ?? null,
  };
}

const createMs = (item) => toDate(item.create_time)?.getTime() ?? 0;

/**
 * Normal + archived + project chats, merged by id, oldest first.
 * @returns {Promise<any[]>} list items with an `archived` flag
 */
export async function listChats(ctx, projectItems) {
  const sources = [
    [await ctx.call('listConversations', { archived: false }), false],
    [await ctx.call('listConversations', { archived: true }), true],
    [projectItems, false],
  ];
  const merged = new Map();
  for (const [items, archivedHint] of sources) {
    for (const item of items) merged.set(item.id, mergeItem(merged.get(item.id), item, archivedHint));
  }
  return [...merged.values()].sort((a, b) => createMs(a) - createMs(b) || (a.id < b.id ? -1 : 1));
}

// ---------- chats ----------

function metaOf(item, prev, chatProject) {
  const proj = chatProject.get(item.id);
  const gizmoProject = item.gizmo_id?.startsWith('g-p-') ? item.gizmo_id : null;
  const create_time = toIso(item.create_time);
  const title = item.title ?? prev?.title ?? 'Untitled';
  return {
    id: item.id,
    title,
    create_time,
    update_time: toIso(item.update_time),
    project_id: proj?.id ?? gizmoProject ?? prev?.project_id ?? null,
    project_name: proj?.name ?? prev?.project_name ?? null,
    archived: item.archived,
    gizmo_id: item.gizmo_id ?? null,
    // Kept from the first export so a later title change does not orphan earlier files.
    baseName: (isSafeBaseName(prev?.baseName) ? prev.baseName : null) ?? chatBaseName({ id: item.id, title, create_time }),
  };
}

function needsExport(prev, meta, mode) {
  if (prev?.status === 'skipped') return false;
  if (mode === 'retry-failed') return prev?.status === 'failed' || prev?.status === 'partial';
  return !(prev?.status === 'done' && prev.update_time === meta.update_time);
}

const isVisibleTurn = (n) =>
  ['user', 'assistant'].includes(n?.message?.author?.role) && !n.message.metadata?.is_visually_hidden_from_conversation;
const countMessages = (conv) => Object.values(conv?.mapping ?? {}).filter(isVisibleTurn).length;

async function keptFiles(ctx, prevFiles) {
  const kept = new Map();
  for (const f of prevFiles) {
    if (f.status === 'done' && (await ctx.writer.exists(f.path))) kept.set(f.id, f);
  }
  return kept;
}

async function saveOneFile(ctx, cid, ref, kept, taken) {
  if (kept) return kept;
  const label = ref.name ?? ref.id;
  try {
    const { blob, fileName, mime } = await ctx.call('downloadFile', ref.id, { conversationId: cid });
    const fallback = ref.id + (EXT_BY_MIME[mime ?? ref.mime] ?? '');
    const name = uniqueName(safeFileName(ref.name || fileName || fallback), taken);
    taken.add(name);
    const path = `files/${safeFileName(cid)}/${name}`;
    await ctx.writer.writeBlob(path, blob);
    return { id: ref.id, name, path, status: 'done', error: null };
  } catch (err) {
    if (mustPropagate(err)) throw err;
    ctx.log(err?.kind === 'notfound' ? `File expired: ${label}` : `File failed: ${label} (${errMsg(err)})`);
    return { id: ref.id, name: label, path: null, status: 'failed', error: errMsg(err) };
  }
}

async function saveFiles(ctx, cid, refs, prevFiles) {
  const kept = await keptFiles(ctx, prevFiles);
  const taken = new Set([...kept.values()].map((f) => f.name));
  const out = [];
  for (const ref of refs) out.push(await saveOneFile(ctx, cid, ref, kept.get(ref.id), taken));
  return out;
}

async function exportChat(ctx, meta, prev) {
  const conv = await ctx.call('getConversation', meta.id);
  await ctx.writer.writeJson(`chats/${meta.baseName}.json`, conv);
  const files = await saveFiles(ctx, meta.id, extractFileRefs(conv), prev?.files ?? []);
  const fileLinks = new Map(files.filter((f) => f.status === 'done').map((f) => [f.id, `../${f.path}`]));
  const md = renderChat(conv, { fileLinks, projectName: meta.project_name, baseName: meta.baseName });
  await ctx.writer.writeText(`chats/${meta.baseName}.md`, md);
  const bad = files.filter((f) => f.status === 'failed');
  ctx.log(`Saved ${meta.baseName} (${plural(files.length, 'file')})`);
  return {
    ...meta,
    status: bad.length ? 'partial' : 'done',
    error: bad.length ? `${plural(bad.length, 'file')} failed: ${bad[0].error}` : null,
    messageCount: countMessages(conv),
    mdChars: md.length,
    files,
  };
}

const carried = (meta, prev, patch) => ({
  ...meta, messageCount: prev?.messageCount ?? 0, files: prev?.files ?? [], error: null, ...patch,
});

async function processChat(ctx, meta) {
  const prev = ctx.index.chats[meta.id];
  let entry;
  if (ctx.skips.has(meta.id)) {
    entry = carried(meta, prev, { status: 'skipped' });
  } else {
    ctx.setCurrent({ id: meta.id, title: meta.title });
    try {
      entry = await exportChat(ctx, meta, prev);
      ctx.throttle(null);
    } catch (err) {
      if (mustPropagate(err)) throw err;
      // Sustained rate limiting: pause and leave this chat pending so Resume retries it.
      if (ctx.throttle(err)) return false;
      ctx.log(`Failed ${meta.baseName}: ${errMsg(err)}`);
      entry = carried(meta, prev, { status: 'failed', error: errMsg(err) });
    }
    if (ctx.skips.has(meta.id)) entry = { ...entry, status: 'skipped' };
  }
  await ctx.commit(entry, { current: null });
  return true;
}

/** Exports every chat that needs it. Counts always cover the whole index, so up-to-date chats need no work. */
export async function chatsPhase(ctx, items, chatProject, mode) {
  const metas = items.map((it) => metaOf(it, ctx.index.chats[it.id], chatProject));
  ctx.begin(metas.map((m) => m.id));
  const wanted = (m) =>
    needsExport(ctx.index.chats[m.id], m, mode) || (ctx.skips.has(m.id) && ctx.index.chats[m.id]?.status !== 'skipped');
  for (const m of metas.filter(wanted)) {
    for (;;) {
      await ctx.gate();
      if (await processChat(ctx, m)) break;
    }
  }
}

// ---------- finishing ----------

async function gptsStep(ctx, items) {
  const ids = [...new Set(items.map((i) => i.gizmo_id).filter(isCustomGpt))];
  const found = [];
  for (const id of ids) {
    const gpt = await ctx.attempt(`gpt:${id}`, () => ctx.call('getGizmo', id));
    if (gpt) found.push(gpt);
  }
  if (found.length) await writeAccount(ctx, 'gpts', found, renderGpts);
}

const projectsFromIndex = (chats) => {
  const byId = new Map();
  for (const c of Object.values(chats)) if (c.project_id) byId.set(c.project_id, c.project_name ?? c.project_id);
  return [...byId].map(([id, name]) => ({ id, name }));
};

const MAX_BUNDLES = 20;

/** Contiguous, size-balanced [start, end) ranges, at most MAX_BUNDLES, every item in exactly one. */
export function planBundles(sizes) {
  const slots = Math.min(MAX_BUNDLES, sizes.length);
  const ranges = [];
  let start = 0;
  let remaining = sizes.reduce((a, b) => a + b, 0);
  for (let left = slots; left > 0; left--) {
    const target = remaining / left;
    const limit = sizes.length - (left - 1);
    let end = start + 1;
    let sum = sizes[start];
    while (left === 1 ? end < sizes.length : end < limit && Math.abs(sum + sizes[end] - target) < Math.abs(sum - target)) {
      sum += sizes[end++];
    }
    ranges.push([start, end]);
    remaining -= sum;
    start = end;
  }
  return ranges;
}

async function sizeOf(ctx, e) {
  if (Number.isFinite(e.mdChars)) return e.mdChars;
  return (await ctx.writer.readText(`chats/${e.baseName}.md`))?.length ?? 0;
}

async function readGroup(ctx, entries) {
  const chats = [];
  for (const e of entries) {
    const markdown = await ctx.writer.readText(`chats/${e.baseName}.md`);
    if (markdown !== null) chats.push({ baseName: e.baseName, title: e.title, create_time: e.create_time, markdown });
  }
  return chats;
}

// Plans from sizes, then renders one bundle at a time so memory holds one bundle, not the export.
async function bundlesStep(ctx) {
  const entries = Object.values(ctx.index.chats)
    .filter((c) => (c.status === 'done' || c.status === 'partial') && isSafeBaseName(c.baseName))
    .sort((a, b) => createMs(a) - createMs(b) || (a.id < b.id ? -1 : 1));
  const sizes = [];
  for (const e of entries) sizes.push(await sizeOf(ctx, e));
  const ranges = planBundles(sizes);
  const width = Math.max(2, String(ranges.length).length);
  const pad = (n) => String(n).padStart(width, '0');
  for (const [i, [start, end]] of ranges.entries()) {
    const chats = await readGroup(ctx, entries.slice(start, end));
    if (!chats.length) continue;
    // Coupled to renderBundle in markdown.js: buildBundles(group, 1) titles its only bundle
    // "# Chats bundle 01 of 01"; rewrite that first line to the real position.
    const { content } = buildBundles(chats, 1)[0];
    const heading = `# Chats bundle ${pad(i + 1)} of ${pad(ranges.length)}`;
    await ctx.writer.writeText(`bundles/bundle-${pad(i + 1)}.md`, content.replace(/^# Chats bundle \d+ of \d+/, heading));
  }
}

const isWriterDenied = (err) => err?.name === 'NotAllowedError' || err?.name === 'SecurityError';

/** Runs a step that must not block INDEX.md and bundles; only stop and lost folder access escape. */
async function bestEffort(ctx, name, fn) {
  try {
    await fn();
  } catch (err) {
    if (err === STOP || isWriterDenied(err)) throw err;
    ctx.recordAccountError(name, errMsg(err));
    ctx.log(`Skipped ${name}: ${errMsg(err)}`);
  }
}

/** GPT definitions (full runs only), INDEX.md, bundles. index.json is saved by the caller. */
export async function finishPhase(ctx, items, mode, exportedAt) {
  if (mode === 'all') await bestEffort(ctx, 'gpts', () => gptsStep(ctx, items));
  const { index } = ctx;
  await ctx.writer.writeText('INDEX.md', renderIndex(Object.values(index.chats), {
    projects: projectsFromIndex(index.chats), exportedAt, account: index.account,
  }));
  await bestEffort(ctx, 'bundles', () => bundlesStep(ctx));
}
