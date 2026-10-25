import { describe, expect, test } from 'bun:test';
import { extractFileRefs, fileIdFromPointer } from '../src/extract.js';

const node = (id, parent, children, message) => ({ id, parent, children, message });
const img = (ptr, extra = {}) => ({ content_type: 'image_asset_pointer', asset_pointer: ptr, size_bytes: 10, width: 1, height: 1, metadata: {}, ...extra });

describe('fileIdFromPointer', () => {
  test('reads both pointer schemes', () => {
    expect(fileIdFromPointer('sediment://file_00000000e9d081fa')).toBe('file_00000000e9d081fa');
    expect(fileIdFromPointer('file-service://file-AbC123')).toBe('file-AbC123');
  });
  test('ignores anything else', () => {
    expect(fileIdFromPointer('https://x/y')).toBeNull();
    expect(fileIdFromPointer(undefined)).toBeNull();
  });
});

describe('extractFileRefs', () => {
  const conversation = {
    mapping: {
      root: node('root', null, ['u1'], null),
      u1: node('u1', 'root', ['t1'], {
        author: { role: 'user' },
        content: { content_type: 'multimodal_text', parts: [img('sediment://file_A'), 'look at this'] },
        metadata: { attachments: [{ id: 'file_A', name: 'photo.jpg', mime_type: 'image/jpeg', size: 99 }, { id: 'file-doc', name: 'notes.pdf', mime_type: 'application/pdf', size: 5 }] },
      }),
      t1: node('t1', 'u1', ['a1', 'a2'], {
        author: { role: 'tool' },
        content: { content_type: 'multimodal_text', parts: [img('sediment://file_GEN', { mime_type: 'image/png', metadata: { dalle: { gen_id: 'g' } } })] },
        metadata: {},
      }),
      a1: node('a1', 't1', [], { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['done'] }, metadata: {} }),
      // a branch repeating the same generated image must not duplicate it
      a2: node('a2', 't1', [], { author: { role: 'tool' }, content: { content_type: 'multimodal_text', parts: [img('sediment://file_GEN')] }, metadata: {} }),
    },
  };

  test('finds uploads and generated images once each, in conversation order', () => {
    const refs = extractFileRefs(conversation);
    expect(refs.map((r) => r.id)).toEqual(['file_A', 'file-doc', 'file_GEN']);
  });

  test('attachment metadata wins and generated flag is set for tool images', () => {
    const [photo, doc, gen] = extractFileRefs(conversation);
    expect(photo).toEqual({ id: 'file_A', name: 'photo.jpg', mime: 'image/jpeg', size: 99, source: 'attachment', generated: false });
    expect(doc.name).toBe('notes.pdf');
    expect(gen).toMatchObject({ id: 'file_GEN', name: null, mime: 'image/png', generated: true });
  });

  test('pointer seen before its attachment still gets the attachment name', () => {
    const c = {
      mapping: {
        r: node('r', null, ['x', 'y'], null),
        x: node('x', 'r', [], { author: { role: 'user' }, content: { content_type: 'multimodal_text', parts: [img('sediment://file_Z')] }, metadata: {} }),
        y: node('y', 'r', [], { author: { role: 'user' }, content: { content_type: 'text', parts: [''] }, metadata: { attachments: [{ id: 'file_Z', name: 'z.png' }] } }),
      },
    };
    expect(extractFileRefs(c)).toEqual([{ id: 'file_Z', name: 'z.png', mime: null, size: 10, source: 'attachment', generated: false }]);
  });

  test('empty or missing mapping gives no refs', () => {
    expect(extractFileRefs({ mapping: {} })).toEqual([]);
    expect(extractFileRefs({})).toEqual([]);
  });
});
