// Markdown rendering: one chat, the INDEX, merged bundles and the account pages.
// Everything here is defensive: ChatGPT's data shapes vary, so nothing may throw on odd input.

import { fileIdFromPointer } from './extract.js';
import { chatBaseName, toDate } from './names.js';

const SPAN = /\uE200([^\uE201]*)\uE201/g;
const PRIVATE_USE = /[\uE000-\uF8FF]/g;
const SPAN_SEP = '\uE202';
const MAX_JSON_STRING = 2000;
const BRANCH_QUOTE_LEN = 80;

const str = (v) => (typeof v === 'string' ? v : '');
const oneLine = (s) => str(s).replace(/\s+/g, ' ').trim();
/** Display name of an entity span payload: second array element, else the last string. */
function entityName(payload) {
  try {
    const arr = JSON.parse(payload);
    if (!Array.isArray(arr)) return '';
    if (typeof arr[1] === 'string' && arr[1]) return arr[1];
    return [...arr].reverse().find((v) => typeof v === 'string' && v) ?? '';
  } catch {
    return '';
  }
}

const spanText = (_, inner) => {
  const [type, ...rest] = inner.split(SPAN_SEP);
  return type === 'entity' ? entityName(rest.join(SPAN_SEP)) : '';
};
const clean = (s) => str(s).replace(SPAN, spanText).replace(PRIVATE_USE, '');
/** One-line text safe in headings, link text and list items: no HTML, no brackets, no leading #. */
const esc = (s) => oneLine(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/[[\]]/g, '\\$&').replace(/^#/, '\\#');
const escHtml = (s) => oneLine(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const encParens = (s) => s.replace(/\(/g, '%28').replace(/\)/g, '%29');
const encUrl = (link) => encParens(str(link).replace(/ /g, '%20'));
const encSegment = (seg) => (seg === '' || seg === '.' || seg === '..' ? seg : encParens(encodeURIComponent(seg.toWellFormed())));
/** Relative file path: each segment percent-encoded, "/" and "../" kept. */
const enc = (link) => str(link).split('/').map(encSegment).join('/');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const isoDay = (t) => toDate(t)?.toISOString().slice(0, 10) ?? null;

/** @returns {string|null} "YYYY-MM-DD HH:MM UTC" */
function fmtDate(t) {
  const d = toDate(t);
  if (!d) return null;
  const iso = d.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** Code fence that cannot be closed early by backticks inside the text. */
function fence(text, lang = '') {
  const longest = Math.max(0, ...(String(text).match(/`+/g) ?? []).map((r) => r.length));
  const f = '`'.repeat(Math.max(3, longest + 1));
  return `${f}${lang}\n${String(text).replace(/\s+$/, '')}\n${f}`;
}

function truncatedJson(value) {
  try {
    return JSON.stringify(value, (k, v) => (typeof v === 'string' && v.length > MAX_JSON_STRING ? `${v.slice(0, MAX_JSON_STRING)}…` : v), 2) ?? '';
  } catch {
    return String(value);
  }
}

// ---------------------------------------------------------------- tree walking

/** Ids from `startId` following the last child at every level (what ChatGPT shows). */
function chainFrom(mapping, startId) {
  const out = [];
  const seen = new Set();
  let id = startId;
  while (id && mapping[id] && !seen.has(id)) {
    seen.add(id);
    out.push(id);
    const kids = mapping[id].children ?? [];
    id = kids[kids.length - 1];
  }
  return out;
}

function fallbackLeaf(mapping) {
  const ids = Object.keys(mapping);
  const roots = ids.filter((id) => !mapping[id]?.parent || !mapping[mapping[id].parent]);
  const start = roots.length ? roots[roots.length - 1] : ids[ids.length - 1];
  return chainFrom(mapping, start).pop() ?? null;
}

/** Node ids root to current_node (or deepest last-child leaf), message-less nodes included. */
function pathIds(conversation) {
  const mapping = conversation?.mapping ?? {};
  const current = conversation?.current_node;
  let id = mapping[current] ? current : fallbackLeaf(mapping);
  const ids = [];
  const seen = new Set();
  while (id && mapping[id] && !seen.has(id)) {
    seen.add(id);
    ids.push(id);
    id = mapping[id].parent;
  }
  return ids.reverse();
}

/**
 * @param {{ mapping?: Record<string, any>, current_node?: string|null }} conversation
 * @returns {any[]} nodes from the root to current_node that carry a message
 */
export function mainPath(conversation) {
  const mapping = conversation?.mapping ?? {};
  return pathIds(conversation).map((id) => mapping[id]).filter((n) => n?.message);
}

// ---------------------------------------------------------------- message pieces

function plainText(message) {
  const c = message?.content ?? {};
  const parts = Array.isArray(c.parts) ? c.parts.filter((p) => typeof p === 'string') : [];
  return oneLine(clean(parts.length ? parts.join(' ') : c.text));
}

function collectLinks(value, out = new Map(), depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return out;
  if (Array.isArray(value)) {
    value.forEach((v) => collectLinks(v, out, depth + 1));
    return out;
  }
  if (/^https?:\/\//.test(str(value.url)) && !out.has(value.url)) {
    out.set(value.url, oneLine(value.title || value.attribution || value.name) || value.url);
  }
  for (const key of ['items', 'metadata', 'sources', 'refs']) collectLinks(value[key], out, depth + 1);
  return out;
}

function sourcesBlock(meta) {
  const links = collectLinks([meta?.content_references, meta?.citations]);
  if (!links.size) return [];
  const items = [...links].map(([url, title]) => `- [${esc(title)}](${encUrl(url)})`);
  return [`**Sources**\n\n${items.join('\n')}`];
}

function imageBlock(part, ctx, names) {
  const id = fileIdFromPointer(part.asset_pointer);
  const name = id ? names.get(id) : null;
  const link = id ? ctx.fileLinks.get(id) : null;
  if (link) return `![${esc(name ?? 'image')}](${enc(link)})`;
  return `*[image not downloaded: ${oneLine(name ?? id ?? part.asset_pointer) || 'unknown'}]*`;
}

function partBlocks(parts, ctx, names) {
  const out = [];
  for (const part of Array.isArray(parts) ? parts : []) {
    if (typeof part === 'string') {
      const t = clean(part).trim();
      if (t) out.push(t);
    } else if (part?.content_type === 'image_asset_pointer') out.push(imageBlock(part, ctx, names));
    else if (typeof part?.text === 'string') {
      const t = clean(part.text).trim();
      if (t) out.push(t);
    } else if (part && typeof part === 'object') out.push(fence(truncatedJson(part), 'json'));
  }
  return out;
}

function attachmentBlocks(attachments, shownIds, ctx) {
  const images = [];
  const files = [];
  for (const a of Array.isArray(attachments) ? attachments : []) {
    if (!a?.id || shownIds.has(a.id)) continue;
    const name = oneLine(a.name) || a.id;
    const link = ctx.fileLinks.get(a.id);
    if (str(a.mime_type).startsWith('image/')) {
      images.push(link ? `![${esc(name)}](${enc(link)})` : `*[image not downloaded: ${name}]*`);
    } else files.push(link ? `- [${esc(name)}](${enc(link)})` : `- ${esc(name)} (not downloaded)`);
  }
  return files.length ? [...images, files.join('\n')] : images;
}

function canvasBlocks(message) {
  let doc;
  try {
    doc = JSON.parse(message.content.text);
  } catch {
    return null;
  }
  if (typeof doc?.content !== 'string') return null;
  const kind = str(doc.type);
  const lang = kind.startsWith('code/') ? kind.slice(5) : 'markdown';
  return [`*Canvas: ${esc(doc.name) || 'untitled'}*\n\n${fence(doc.content, lang)}`];
}

function codeBlocks(message) {
  const { text, language } = message.content;
  if (!str(text).trim()) return [];
  const tool = message.recipient && message.recipient !== 'all' ? message.recipient : null;
  if (tool?.endsWith('.create')) {
    const canvas = canvasBlocks(message);
    if (canvas) return canvas;
  }
  const isCanvasEdit = Boolean(tool?.endsWith('.create') || tool?.endsWith('.update_textdoc'));
  const lang = isCanvasEdit ? 'json' : str(language).replace(/^unknown$/, '');
  return [`${tool ? `*${tool}*\n\n` : ''}${fence(text, lang)}`];
}

function outputBlocks(content) {
  return str(content.text).trim() ? [`*Output*\n\n${fence(content.text, 'text')}`] : [];
}

function bodyBlocks(message, ctx) {
  const content = message.content ?? {};
  const names = new Map((message.metadata?.attachments ?? []).filter((a) => a?.id).map((a) => [a.id, oneLine(a.name)]));
  const shown = new Set((Array.isArray(content.parts) ? content.parts : []).map((p) => fileIdFromPointer(p?.asset_pointer)).filter(Boolean));
  switch (content.content_type) {
    case 'text':
    case 'multimodal_text':
      return [...partBlocks(content.parts, ctx, names), ...attachmentBlocks(message.metadata?.attachments, shown, ctx)];
    case 'code': return codeBlocks(message);
    case 'execution_output': return outputBlocks(content);
    default: return [fence(truncatedJson(content), 'json')];
  }
}

function thoughtBlocks(content) {
  return (Array.isArray(content.thoughts) ? content.thoughts : []).map((t) => {
    const summary = oneLine(clean(t?.summary));
    const body = clean(t?.content).trim();
    return [summary && `**${summary}**`, body].filter(Boolean).join('\n\n');
  }).filter(Boolean);
}

/** One message to { role, reasoning, recap, body }, or null when it is not shown. */
function analyze(message, ctx) {
  const role = message?.author?.role;
  const meta = message?.metadata ?? {};
  const type = message?.content?.content_type;
  if (!message || role === 'system' || meta.is_visually_hidden_from_conversation || type === 'user_editable_context') return null;
  const out = { role: role === 'user' ? 'user' : 'assistant', reasoning: [], recap: null, body: [] };
  const preamble = role === 'assistant' && message.channel === 'commentary' && meta.is_thinking_preamble_message;
  if (type === 'thoughts') out.reasoning = thoughtBlocks(message.content);
  else if (type === 'reasoning_recap') out.recap = oneLine(clean(message.content.content)) || null;
  else if (preamble) out.reasoning = [clean(message.content.parts?.join?.('\n') ?? message.content.text).trim()].filter(Boolean);
  else {
    const body = bodyBlocks(message, ctx);
    out.body = body.length && role !== 'user' ? [...body, ...sourcesBlock(meta)] : body;
  }
  return out;
}

// ---------------------------------------------------------------- turns

function buildTurns(nodes, ctx) {
  const turns = [];
  for (const node of nodes) {
    const a = analyze(node.message, ctx);
    if (!a || !(a.reasoning.length || a.recap || a.body.length)) continue;
    const last = turns[turns.length - 1];
    if (last?.role !== a.role) turns.push(a);
    else {
      turns[turns.length - 1] = {
        role: a.role,
        reasoning: [...last.reasoning, ...a.reasoning],
        recap: a.recap ?? last.recap,
        body: [...last.body, ...a.body],
      };
    }
  }
  return turns;
}

function renderTurn(turn, level) {
  const heading = `${'#'.repeat(level)} ${turn.role === 'user' ? 'You' : 'ChatGPT'}`;
  const pieces = [heading];
  if (turn.reasoning.length) {
    const summary = escHtml(turn.recap ?? 'Reasoning');
    // '<' is escaped so thought text can neither close the block early nor inject tags.
    const thoughts = turn.reasoning.join('\n\n').replace(/</g, '&lt;');
    pieces.push(`<details><summary>${summary}</summary>\n\n${thoughts}\n\n</details>`);
  } else if (turn.recap) pieces.push(`*${esc(turn.recap)}*`);
  return [...pieces, ...turn.body].join('\n\n');
}

function renderTurns(nodes, ctx, level) {
  return buildTurns(nodes, ctx).map((t) => renderTurn(t, level)).join('\n\n');
}

function lastModel(nodes) {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const slug = nodes[i].message?.metadata?.model_slug;
    if (nodes[i].message?.author?.role === 'assistant' && typeof slug === 'string') return slug;
  }
  return null;
}

function header(c, opts, nodes) {
  const model = c.default_model_slug || lastModel(nodes);
  const lines = [
    fmtDate(c.create_time) && `- Created: ${fmtDate(c.create_time)}`,
    fmtDate(c.update_time) && `- Updated: ${fmtDate(c.update_time)}`,
    model && `- Model: ${model}`,
    opts.projectName && `- Project: ${esc(opts.projectName)}`,
    c.is_archived && '- Archived: yes',
    c.conversation_id && `- Link: https://chatgpt.com/c/${c.conversation_id}`,
  ].filter(Boolean);
  return [`# ${esc(c.title) || 'Untitled'}`, lines.join('\n')].filter(Boolean).join('\n\n');
}

function branchQuote(mapping, ids, index) {
  for (let i = index; i >= 0; i--) {
    const m = mapping[ids[i]]?.message;
    const text = m?.author?.role === 'system' ? '' : plainText(m);
    if (text) return text.slice(0, BRANCH_QUOTE_LEN).replace(/"/g, "'");
  }
  return 'start of chat';
}

const branches = (mapping, chain) => chain.some((id) => (mapping[id].children ?? []).length > 1);
const DEEPER_NOTE = 'Deeper alternatives are in the .json file.';

function otherVersions(c, ctx) {
  const mapping = c.mapping ?? {};
  const ids = pathIds(c);
  const onPath = new Set(ids);
  const versions = [];
  ids.forEach((id, index) => {
    for (const kid of mapping[id].children ?? []) {
      if (onPath.has(kid) || !mapping[kid]) continue;
      const chain = chainFrom(mapping, kid);
      const body = renderTurns(chain.map((i) => mapping[i]).filter((n) => n.message), ctx, 4);
      if (body) versions.push({ quote: branchQuote(mapping, ids, index), body, deeper: branches(mapping, chain) });
    }
  });
  if (!versions.length) return '';
  const sections = versions.map((v, i) => `### Version ${i + 1} (branched after: "${v.quote}")\n\n${v.body}`);
  const note = versions.some((v) => v.deeper) ? `${DEEPER_NOTE}\n\n` : '';
  return `## Other versions\n\n${note}${sections.join('\n\n')}`;
}

/**
 * @param {any} conversation raw GET /backend-api/conversation/{id}
 * @param {{ fileLinks?: Map<string, string>, projectName?: string|null, baseName?: string }} [opts]
 * @returns {string}
 */
export function renderChat(conversation, opts = {}) {
  const c = conversation ?? {};
  const ctx = { fileLinks: opts.fileLinks instanceof Map ? opts.fileLinks : new Map() };
  const nodes = mainPath(c);
  const parts = [header(c, opts, nodes), renderTurns(nodes, ctx, 3), otherVersions(c, ctx)];
  return `${parts.filter(Boolean).join('\n\n')}\n`;
}

// ---------------------------------------------------------------- INDEX.md

function projectNameOf(entry, projects) {
  if (entry.project_name) return entry.project_name;
  if (!entry.project_id) return null;
  return projects.find((p) => p?.id === entry.project_id)?.name ?? `Project ${entry.project_id}`;
}

function indexLine(e) {
  const files = (e.files ?? []).filter((f) => f?.status !== 'failed').length;
  const base = e.baseName ?? chatBaseName(e);
  const marks = [
    e.archived && 'archived',
    e.status === 'partial' && '⚠ partial',
    e.status === 'failed' && `✖ failed: ${esc(e.error) || 'unknown error'}`,
    e.status === 'skipped' && 'skipped',
  ].filter(Boolean);
  const cells = [`[${esc(e.title) || 'Untitled'}](chats/${enc(base)}.md)`, isoDay(e.create_time) ?? 'undated', plural(e.messageCount ?? 0, 'message'), plural(files, 'file'), ...marks];
  return `- ${cells.join(' · ')}`;
}

const byNewest = (a, b) => (toDate(b.create_time)?.getTime() ?? 0) - (toDate(a.create_time)?.getTime() ?? 0);

function projectSection(name, list) {
  const months = new Map();
  for (const e of [...list].sort(byNewest)) {
    const key = toDate(e.create_time)?.toISOString().slice(0, 7) ?? 'undated';
    months.set(key, [...(months.get(key) ?? []), e]);
  }
  const keys = [...months.keys()].sort((a, b) => (a === 'undated') - (b === 'undated') || b.localeCompare(a));
  return [`## ${esc(name)}`, ...keys.map((k) => `### ${k}\n\n${months.get(k).map(indexLine).join('\n')}`)].join('\n\n');
}

/**
 * @param {Record<string, any>|any[]} entries values of index.json "chats"
 * @param {{ projects?: {id: string, name: string}[], exportedAt?: string, account?: any }} [opts]
 * @returns {string}
 */
export function renderIndex(entries, { projects = [], exportedAt, account } = {}) {
  const list = (Array.isArray(entries) ? entries : Object.values(entries ?? {})).filter(Boolean);
  const count = (s) => list.filter((e) => e.status === s).length;
  const filesSaved = list.reduce((n, e) => n + (e.files ?? []).filter((f) => f?.status !== 'failed').length, 0);
  const groups = new Map();
  for (const e of list) {
    const name = projectNameOf(e, projects) ?? '';
    groups.set(name, [...(groups.get(name) ?? []), e]);
  }
  const names = [...groups.keys()].sort((a, b) => (a === '') - (b === '') || a.localeCompare(b));
  const top = [
    fmtDate(exportedAt) && `- Exported: ${fmtDate(exportedAt)}`,
    account?.planType && `- Plan: ${account.planType}`,
    account?.accountId && `- Account: ${account.accountId}`,
    `- Chats: ${list.length} (done ${count('done')}, partial ${count('partial')}, failed ${count('failed')}, skipped ${count('skipped')})`,
    `- Files saved: ${filesSaved}`,
  ].filter(Boolean);
  const sections = names.map((n) => projectSection(n || 'No project', groups.get(n)));
  return `${['# ChatGPT export', top.join('\n'), ...sections].join('\n\n')}\n`;
}

// ---------------------------------------------------------------- bundles

/** Contiguous split into n groups, each close to an even share of the characters left. */
function splitBalanced(items, n) {
  const sizes = items.map((c) => String(c.markdown ?? '').length);
  const groups = [];
  let i = 0;
  let remaining = sizes.reduce((a, b) => a + b, 0);
  for (let k = 0; k < n; k++) {
    const slots = n - k;
    if (slots === 1) {
      groups.push(items.slice(i));
      break;
    }
    const target = remaining / slots;
    const limit = items.length - (slots - 1);
    let end = i + 1;
    let sum = sizes[i];
    while (end < limit && Math.abs(sum + sizes[end] - target) < Math.abs(sum - target)) sum += sizes[end++];
    groups.push(items.slice(i, end));
    remaining -= sum;
    i = end;
  }
  return groups;
}

/** Push every heading outside code fences one level down so a bundle has a single H1. */
function demoteHeadings(markdown) {
  let open = null;
  return markdown.split('\n').map((line) => {
    const m = line.match(/^(`{3,}|~{3,})/);
    if (open) {
      if (m && m[1][0] === open[0] && m[1].length >= open.length && /^[`~]+\s*$/.test(line)) open = null;
      return line;
    }
    if (m) open = m[1];
    return !m && /^#{1,5} /.test(line) ? `#${line}` : line;
  }).join('\n');
}

const anchorOf = (c) => `chat-${c.baseName ?? chatBaseName({ id: c.title, title: c.title, create_time: c.create_time })}`;

function renderBundleChat(chat) {
  const md = String(chat.markdown ?? '');
  const body = md.startsWith('# ') ? demoteHeadings(md) : `## ${esc(chat.title) || 'Untitled'}\n\n${demoteHeadings(md)}`;
  return `<a id="${anchorOf(chat)}"></a>\n\n${body.trimEnd()}`;
}

function renderBundle(group, number, total) {
  const width = Math.max(2, String(total).length);
  const days = group.map((c) => isoDay(c.create_time)).filter(Boolean).sort();
  const range = days.length ? `${days[0]} to ${days[days.length - 1]}` : 'undated';
  const toc = group.map((c) => `- [${esc(c.title) || 'Untitled'}](#${anchorOf(c)}) (${isoDay(c.create_time) ?? 'undated'})`);
  const head = [
    `# Chats bundle ${String(number).padStart(width, '0')} of ${String(total).padStart(width, '0')}`,
    `Date range: ${range} · ${plural(group.length, 'chat')}`,
    `## Contents\n\n${toc.join('\n')}`,
  ].join('\n\n');
  return `${[head, ...group.map(renderBundleChat)].join('\n\n---\n\n')}\n`;
}

/**
 * @param {{ baseName: string, title: string, create_time: any, markdown: string }[]} chats oldest first
 * @param {number} [maxFiles]
 * @returns {{ name: string, content: string }[]}
 */
export function buildBundles(chats, maxFiles = 20) {
  const list = Array.isArray(chats) ? chats : [];
  if (!list.length) return [];
  const total = Math.max(1, Math.min(maxFiles, list.length));
  const width = Math.max(2, String(total).length);
  return splitBalanced(list, total).map((group, i) => ({
    name: `bundle-${String(i + 1).padStart(width, '0')}.md`,
    content: renderBundle(group, i + 1, total),
  }));
}

// ---------------------------------------------------------------- account pages

/**
 * @param {{ memories?: { content?: string, updated_at?: any }[] }|any[]|null} json
 * @returns {string}
 */
export function renderMemories(json) {
  const list = (Array.isArray(json) ? json : json?.memories ?? []).filter((m) => str(m?.content).trim());
  if (!list.length) return 'No saved memories.';
  const items = list.map((m) => {
    const day = isoDay(m.updated_at);
    const lines = m.content.trim().split('\n');
    return `- ${lines.join('\n  ')}${day ? ` (updated ${day})` : ''}`;
  });
  return `# Saved memories\n\n${items.join('\n')}\n`;
}

const INSTRUCTION_FIELDS = [
  ['name_user_message', 'Name'],
  ['role_user_message', 'Occupation'],
  ['about_user_message', 'What ChatGPT should know about you'],
  ['about_model_message', 'How ChatGPT should respond'],
  ['traits_model_message', 'Traits'],
  ['other_user_message', 'Anything else'],
  ['personality_type_selection', 'Personality'],
];

/**
 * @param {Record<string, any>|null} json raw custom instructions response
 * @returns {string}
 */
export function renderCustomInstructions(json) {
  const sections = INSTRUCTION_FIELDS
    .filter(([key]) => str(json?.[key]).trim())
    .map(([key, label]) => `## ${label}\n\n${json[key].trim()}`);
  if (!sections.length) return 'No custom instructions set.';
  const status = json.enabled === false ? ['Status: disabled'] : [];
  return `${['# Custom instructions', ...status, ...sections].join('\n\n')}\n`;
}

function projectSectionText(p) {
  const g = p?.gizmo?.gizmo ?? p?.gizmo ?? {};
  const files = p?.files ?? p?.gizmo?.files ?? [];
  const chats = Array.isArray(p?.conversationIds) ? p.conversationIds.length : 0;
  const facts = [
    g.id && `- ID: ${g.id}`,
    fmtDate(g.created_at) && `- Created: ${fmtDate(g.created_at)}`,
    `- Chats: ${plural(chats, 'chat')}`,
  ].filter(Boolean);
  const names = files.map((f) => oneLine(f?.name)).filter(Boolean).map((n) => `- ${esc(n)}`);
  return [
    `## ${esc(g.display?.name ?? g.name) || 'Untitled project'}`,
    facts.join('\n'),
    str(g.display?.description).trim(),
    str(g.instructions).trim() && `### Instructions\n\n${fence(g.instructions, 'text')}`,
    names.length && `### Files\n\n${names.join('\n')}`,
  ].filter(Boolean).join('\n\n');
}

/**
 * @param {any[]} projects `{ gizmo, files, conversationIds }` as stored by the engine
 * @returns {string}
 */
export function renderProjects(projects) {
  const list = Array.isArray(projects) ? projects.filter(Boolean) : [];
  if (!list.length) return 'No projects.';
  return `${['# Projects', ...list.map(projectSectionText)].join('\n\n')}\n`;
}

function gptSection(x) {
  const g = x?.gizmo ?? x ?? {};
  const tools = (x?.tools ?? g.tools ?? []).map((t) => oneLine(t?.type ?? t?.name ?? t)).filter(Boolean);
  return [
    `## ${esc(g.display?.name ?? g.name) || 'Untitled GPT'}`,
    g.id && `- ID: ${g.id}`,
    tools.length && `- Tools: ${tools.map(esc).join(', ')}`,
    str(g.display?.description).trim(),
    str(g.instructions).trim() && `### Instructions\n\n${fence(g.instructions, 'text')}`,
  ].filter(Boolean).join('\n\n');
}

/**
 * @param {any[]} gpts raw GET /backend-api/gizmos/{id} responses
 * @returns {string}
 */
export function renderGpts(gpts) {
  const list = Array.isArray(gpts) ? gpts.filter(Boolean) : [];
  if (!list.length) return 'No GPTs.';
  return `${['# GPTs', ...list.map(gptSection)].join('\n\n')}\n`;
}
