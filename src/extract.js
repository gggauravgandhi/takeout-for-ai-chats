// Finds every file a conversation references: uploads (attachments) and images in message parts.

const POINTER = /^(?:sediment|file-service):\/\/(file[-_][A-Za-z0-9]+)/;

/**
 * @param {string|null|undefined} ptr e.g. "sediment://file_00ab" or "file-service://file-XyZ"
 * @returns {string|null}
 */
export function fileIdFromPointer(ptr) {
  const m = typeof ptr === 'string' ? ptr.match(POINTER) : null;
  return m ? m[1] : null;
}

/** Depth-first from the root so files come out in conversation order. */
function nodesInTreeOrder(mapping) {
  const nodes = Object.values(mapping ?? {});
  const roots = nodes.filter((n) => !n.parent || !mapping[n.parent]);
  const out = [];
  const stack = [...roots].reverse();
  const seen = new Set();
  while (stack.length) {
    const node = stack.pop();
    if (!node || seen.has(node.id)) continue;
    seen.add(node.id);
    out.push(node);
    for (const child of [...(node.children ?? [])].reverse()) stack.push(mapping[child]);
  }
  return out;
}

/**
 * @typedef {{ id: string, name: string|null, mime: string|null, size: number|null,
 *   source: 'attachment'|'pointer', generated: boolean }} FileRef
 * @param {{ mapping?: Record<string, any> }} conversation
 * @returns {FileRef[]}
 */
export function extractFileRefs(conversation) {
  const byId = new Map();
  // Attachment metadata (real file name) wins when the same id was seen as a pointer first.
  const add = (ref) => {
    const prev = byId.get(ref.id);
    if (!prev) return byId.set(ref.id, ref);
    byId.set(ref.id, {
      ...prev,
      name: prev.name ?? ref.name,
      mime: prev.mime ?? ref.mime,
      size: prev.size ?? ref.size,
      source: prev.source === 'attachment' || ref.source === 'attachment' ? 'attachment' : 'pointer',
      generated: prev.generated || ref.generated,
    });
  };

  for (const node of nodesInTreeOrder(conversation?.mapping)) {
    const msg = node.message;
    if (!msg) continue;
    for (const a of msg.metadata?.attachments ?? []) {
      if (!a?.id) continue;
      add({ id: a.id, name: a.name ?? null, mime: a.mime_type ?? null, size: a.size ?? null, source: 'attachment', generated: false });
    }
    for (const part of msg.content?.parts ?? []) {
      const id = fileIdFromPointer(part?.asset_pointer);
      if (!id) continue;
      const generated = msg.author?.role !== 'user' || Boolean(part.metadata?.dalle || part.metadata?.generation);
      add({ id, name: null, mime: part.mime_type ?? null, size: part.size_bytes ?? null, source: 'pointer', generated });
    }
  }
  return [...byId.values()];
}
