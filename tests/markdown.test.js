import { describe, expect, test } from 'bun:test';
import {
  buildBundles, mainPath, renderChat, renderCustomInstructions, renderGpts,
  renderIndex, renderMemories, renderProjects,
} from '../src/markdown.js';

const node = (id, parent, children, message = null) => ({ id, parent, children, message });
const msg = (role, content, extra = {}) => ({
  id: `m-${Math.random()}`, author: { role }, recipient: 'all', channel: null, content, metadata: {}, ...extra,
});
const text = (s) => ({ content_type: 'text', parts: [s] });
const conv = (mapping, current_node, extra = {}) => ({
  conversation_id: 'abcdef12-0000', title: 'My chat', create_time: 1792160509.36, update_time: 1792160517.38,
  current_node, gizmo_id: null, is_archived: false, default_model_slug: 'gpt-5', mapping, ...extra,
});

// root -> sys -> u1 -> a1 -> (u2 main | u2b alt) -> a2 -> ...
function branched() {
  return conv({
    root: node('root', null, ['sys']),
    sys: node('sys', 'root', ['u1'], msg('system', text('hidden system'))),
    u1: node('u1', 'sys', ['a1'], msg('user', text('Hello there'))),
    a1: node('a1', 'u1', ['u2', 'u2b'], msg('assistant', text('Hi!'), { channel: 'final' })),
    u2: node('u2', 'a1', ['a2'], msg('user', text('Original question'))),
    a2: node('a2', 'u2', [], msg('assistant', text('Original answer'))),
    u2b: node('u2b', 'a1', ['a2b'], msg('user', text('Edited question'))),
    a2b: node('a2b', 'u2b', [], msg('assistant', text('Edited answer'))),
  }, 'a2');
}

describe('mainPath', () => {
  test('walks root to current_node and skips message-less nodes', () => {
    expect(mainPath(branched()).map((n) => n.id)).toEqual(['sys', 'u1', 'a1', 'u2', 'a2']);
  });
  test('falls back to deepest leaf via last children when current_node missing', () => {
    const c = { ...branched(), current_node: undefined };
    expect(mainPath(c).map((n) => n.id)).toEqual(['sys', 'u1', 'a1', 'u2b', 'a2b']);
  });
  test('survives empty mapping, cycles and missing parents', () => {
    expect(mainPath({ mapping: {} })).toEqual([]);
    expect(mainPath({})).toEqual([]);
    const cyc = conv({ a: node('a', 'b', ['b'], msg('user', text('x'))), b: node('b', 'a', ['a'], msg('user', text('y'))) }, 'a');
    expect(mainPath(cyc).length).toBeLessThanOrEqual(2);
    const orphan = conv({ a: node('a', 'gone', [], msg('user', text('x'))) }, 'a');
    expect(mainPath(orphan).map((n) => n.id)).toEqual(['a']);
  });
});

describe('renderChat', () => {
  test('header, turns, dropped system, other versions', () => {
    const c = branched();
    const before = JSON.stringify(c);
    const md = renderChat(c, { projectName: 'Proj' });
    expect(JSON.stringify(c)).toBe(before);
    expect(md.startsWith('# My chat')).toBe(true);
    expect(md).toContain('Created: 2026-10-16 14:21 UTC');
    expect(md).toContain('UTC');
    expect(md).toContain('gpt-5');
    expect(md).toContain('Proj');
    expect(md).toContain('https://chatgpt.com/c/abcdef12-0000');
    expect(md).toContain('### You');
    expect(md).toContain('### ChatGPT');
    expect(md).toContain('Original answer');
    expect(md).not.toContain('hidden system');
    expect(md).toContain('## Other versions');
    expect(md).toContain('### Version 1 (branched after: "Hi!")');
    expect(md).toContain('Edited question');
    expect(md).toContain('Edited answer');
  });
  test('no other versions section for linear chat', () => {
    const c = conv({
      u: node('u', null, ['a'], msg('user', text('q'))),
      a: node('a', 'u', [], msg('assistant', text('r'))),
    }, 'a');
    expect(renderChat(c)).not.toContain('Other versions');
  });
  test('archived flag and model fallback to message metadata', () => {
    const c = conv({
      u: node('u', null, ['a'], msg('user', text('q'))),
      a: node('a', 'u', [], msg('assistant', text('r'), { metadata: { model_slug: 'gpt-4o' } })),
    }, 'a', { is_archived: true, default_model_slug: null });
    const md = renderChat(c);
    expect(md).toContain('gpt-4o');
    expect(md).toMatch(/[Aa]rchived/);
  });
  test('missing current_node and empty mapping do not crash', () => {
    expect(renderChat({ ...branched(), current_node: null })).toContain('Edited answer');
    expect(renderChat({ title: 'Empty', mapping: {} })).toContain('# Empty');
    expect(renderChat({})).toContain('# Untitled');
  });
  test('drops hidden, empty and user_editable_context messages', () => {
    const c = conv({
      u: node('u', null, ['h'], msg('user', text('visible q'))),
      h: node('h', 'u', ['e'], msg('assistant', text('secret hidden'), { metadata: { is_visually_hidden_from_conversation: true } })),
      e: node('e', 'h', ['x'], msg('assistant', text('   '))),
      x: node('x', 'e', ['a'], msg('user', { content_type: 'user_editable_context', user_profile: 'PROFILE' })),
      a: node('a', 'x', [], msg('assistant', text('final answer'))),
    }, 'a');
    const md = renderChat(c);
    expect(md).not.toContain('secret hidden');
    expect(md).not.toContain('PROFILE');
    expect(md).toContain('visible q');
    expect(md).toContain('final answer');
  });
  test('strips citation markers and lists sources deduped', () => {
    const marker = 'citeturn0search0turn0search1';
    const c = conv({
      u: node('u', null, ['a'], msg('user', text('q'))),
      a: node('a', 'u', [], msg('assistant', text(`Fact${marker}. stray end`), {
        metadata: {
          content_references: [
            { type: 'webpage', url: 'https://ex.com/a', title: 'Ex A' },
            { type: 'webpage', url: 'https://ex.com/a', title: 'Ex A again' },
            { type: 'grouped_webpages', items: [{ url: 'https://ex.com/b', title: 'Ex B' }] },
            null, 'weird',
          ],
        },
      })),
    }, 'a');
    const md = renderChat(c);
    expect(md).not.toMatch(/[-]/);
    expect(md).not.toContain('turn0search0');
    expect(md).toContain('Fact');
    expect(md).toContain('Sources');
    expect(md).toContain('[Ex A](https://ex.com/a)');
    expect(md).toContain('[Ex B](https://ex.com/b)');
    expect(md.split('https://ex.com/a').length - 1).toBe(1);
  });
  test('thoughts and reasoning_recap go in a details block', () => {
    const c = conv({
      u: node('u', null, ['t'], msg('user', text('q'))),
      t: node('t', 'u', ['r'], msg('assistant', { content_type: 'thoughts', thoughts: [{ summary: 'Planning', content: 'think hard', finished: true }] })),
      r: node('r', 't', ['p'], msg('assistant', { content_type: 'reasoning_recap', content: 'Thought for 4s' })),
      p: node('p', 'r', ['a'], msg('assistant', text('thinking out loud'), { channel: 'commentary', metadata: { is_thinking_preamble_message: true } })),
      a: node('a', 'p', [], msg('assistant', text('answer'), { channel: 'final' })),
    }, 'a');
    const md = renderChat(c);
    expect(md).toContain('<details><summary>Thought for 4s</summary>');
    expect(md).toContain('**Planning**');
    expect(md).toContain('think hard');
    expect(md).toContain('thinking out loud');
    expect(md.indexOf('thinking out loud')).toBeLessThan(md.indexOf('</details>'));
    expect(md.indexOf('answer')).toBeGreaterThan(md.indexOf('</details>'));
    expect(md.match(/### ChatGPT/g).length).toBe(1);
  });
  test('plain Reasoning summary when no recap', () => {
    const c = conv({
      u: node('u', null, ['t'], msg('user', text('q'))),
      t: node('t', 'u', [], msg('assistant', { content_type: 'thoughts', thoughts: [{ summary: 'S', content: 'C' }] })),
    }, 't');
    expect(renderChat(c)).toContain('<details><summary>Reasoning</summary>');
  });
  test('python code, execution output, canvas create, other tool code', () => {
    const canvas = JSON.stringify({ name: 'Plan doc', type: 'document', content: 'Canvas body text' });
    const c = conv({
      u: node('u', null, ['c1'], msg('user', text('q'))),
      c1: node('c1', 'u', ['o1'], msg('assistant', { content_type: 'code', language: 'python', text: 'print(1)' }, { recipient: 'python' })),
      o1: node('o1', 'c1', ['c2'], msg('tool', { content_type: 'execution_output', text: '1\n' })),
      c2: node('c2', 'o1', ['c3'], msg('assistant', { content_type: 'code', language: 'json', text: canvas }, { recipient: 'abc123.create' })),
      c3: node('c3', 'c2', [], msg('assistant', { content_type: 'code', language: 'unknown', text: '{"a":1}' }, { recipient: 'api_tool.call_tool' })),
    }, 'c3');
    const md = renderChat(c);
    expect(md).toContain('*python*');
    expect(md).toContain('```python\nprint(1)\n```');
    expect(md).toContain('Output');
    expect(md).toContain('```text\n1\n```');
    expect(md).toContain('Plan doc');
    expect(md).toContain('Canvas body text');
    expect(md).toContain('api_tool.call_tool');
    expect(md.match(/### ChatGPT/g).length).toBe(1);
  });
  test('images with and without links, attachments', () => {
    const img = (ptr) => ({ content_type: 'image_asset_pointer', asset_pointer: ptr, size_bytes: 1, width: 1, height: 1, metadata: {} });
    const c = conv({
      u: node('u', null, ['a'], msg('user', { content_type: 'multimodal_text', parts: ['look', img('file-service://file-AAA')] }, {
        metadata: { attachments: [
          { id: 'file-AAA', name: 'photo.png', mime_type: 'image/png' },
          { id: 'file-BBB', name: 'doc.pdf', mime_type: 'application/pdf' },
          { id: 'file-CCC', name: 'sheet.csv', mime_type: 'text/csv' },
        ] },
      })),
      a: node('a', 'u', [], msg('tool', { content_type: 'multimodal_text', parts: [img('sediment://file_00ab'), img('sediment://file_00cd')] })),
    }, 'a');
    const fileLinks = new Map([['file-AAA', '../files/x/photo.png'], ['file-BBB', '../files/x/doc.pdf'], ['file_00ab', '../files/x/gen.png']]);
    const md = renderChat(c, { fileLinks });
    expect(md).toContain('![photo.png](../files/x/photo.png)');
    expect(md).toContain('[doc.pdf](../files/x/doc.pdf)');
    expect(md).toContain('sheet.csv');
    expect(md).toContain('not downloaded');
    expect(md).toContain('(../files/x/gen.png)');
    expect(md).toContain('*[image not downloaded: file_00cd]*');
    expect(md.match(/!\[photo\.png\]/g).length).toBe(1);
  });
  test('unknown content type renders truncated json', () => {
    const c = conv({
      u: node('u', null, ['a'], msg('user', text('q'))),
      a: node('a', 'u', [], msg('assistant', { content_type: 'tether_weird', blob: 'x'.repeat(5000) })),
    }, 'a');
    const md = renderChat(c);
    expect(md).toContain('```json');
    expect(md).toContain('tether_weird');
    expect(md.length).toBeLessThan(4000);
  });
});

describe('renderIndex', () => {
  const entries = {
    a: { id: 'a', title: 'Alpha [x]', create_time: '2026-10-13T04:27:16Z', project_name: null, archived: false, baseName: '2026-10-13_alpha_aaaa', status: 'done', messageCount: 4, files: [{ id: 'f', status: 'done' }] },
    b: { id: 'b', title: 'Beta', create_time: '2026-09-01T00:00:00Z', project_id: 'p1', project_name: 'Zed', archived: true, baseName: '2026-09-01_beta_bbbb', status: 'partial', messageCount: 2, files: [] },
    c: { id: 'c', title: 'Gamma', create_time: '2026-10-20T00:00:00Z', project_id: 'p1', project_name: 'Zed', baseName: '2026-10-20_gamma_cccc', status: 'failed', error: 'boom', messageCount: 0, files: [] },
    d: { id: 'd', title: 'Delta', create_time: '2026-10-21T00:00:00Z', baseName: '2026-10-21_delta_dddd', status: 'skipped', messageCount: 1, files: [] },
  };
  test('groups, orders, marks, escapes', () => {
    const before = JSON.stringify(entries);
    const md = renderIndex(entries, { projects: [{ id: 'p1', name: 'Zed' }], exportedAt: '2026-10-25T00:00:00Z', account: { planType: 'team' } });
    expect(JSON.stringify(entries)).toBe(before);
    expect(md).toContain('# ChatGPT export');
    expect(md).toContain('2026-10-25');
    expect(md).toContain('team');
    expect(md).toContain('[Alpha \\[x\\]](chats/2026-10-13_alpha_aaaa.md) · 2026-10-13 · 4 messages · 1 file');
    expect(md).toContain('archived');
    expect(md).toContain('⚠ partial');
    expect(md).toContain('✖ failed: boom');
    expect(md).toContain('skipped');
    expect(md.indexOf('## Zed')).toBeLessThan(md.indexOf('## No project'));
    const zed = md.slice(md.indexOf('## Zed'), md.indexOf('## No project'));
    expect(zed.indexOf('### 2026-10')).toBeLessThan(zed.indexOf('### 2026-09'));
  });
  test('accepts array and empty input', () => {
    expect(renderIndex([], {})).toContain('# ChatGPT export');
    expect(renderIndex(Object.values(entries), { projects: [] })).toContain('Alpha');
  });
});

describe('buildBundles', () => {
  const mk = (i, size) => ({ baseName: `c${i}`, title: `Chat ${i}`, create_time: `2026-10-${String(10 + i).padStart(2, '0')}T00:00:00Z`, markdown: `# Chat ${i}\n\n${'x'.repeat(size)}\n` });
  test('empty input', () => expect(buildBundles([])).toEqual([]));
  test('one chat per bundle when few', () => {
    const b = buildBundles([mk(1, 10), mk(2, 10), mk(3, 10)]);
    expect(b.map((x) => x.name)).toEqual(['bundle-01.md', 'bundle-02.md', 'bundle-03.md']);
    expect(b[0].content.startsWith('# Chats bundle 01 of 03')).toBe(true);
    expect(b[0].content).toContain('## Chat 1');
    expect(b[0].content.match(/^# /gm).length).toBe(1);
  });
  test('caps at maxFiles, keeps order, no splits, balanced', () => {
    const chats = Array.from({ length: 30 }, (_, i) => mk(i % 20 + 1, 100 + (i % 5) * 50));
    const b = buildBundles(chats, 4);
    expect(b.length).toBe(4);
    const joined = b.map((x) => x.content).join('\n');
    for (let i = 0; i < 30; i++) expect(joined.split(`${chats[i].markdown.split('\n')[2]}`).length).toBeGreaterThan(1);
    const sizes = b.map((x) => x.content.length);
    expect(Math.max(...sizes) / Math.min(...sizes)).toBeLessThan(2);
    expect(b[0].content).toMatch(/\[Chat/);
    expect(b[0].content).toContain('---');
  });
  test('every chat appears exactly once, in order', () => {
    const chats = Array.from({ length: 7 }, (_, i) => mk(i + 1, 200));
    const b = buildBundles(chats, 3);
    const titles = b.flatMap((x) => [...x.content.matchAll(/^## (Chat \d+)$/gm)].map((m) => m[1]));
    expect(titles).toEqual(chats.map((c) => c.title));
  });
});

describe('account renderers', () => {
  test('memories', () => {
    expect(renderMemories({ memories: [] })).toBe('No saved memories.');
    expect(renderMemories(null)).toBe('No saved memories.');
    const md = renderMemories({ memories: [{ content: 'Likes tea', updated_at: '2026-10-01T00:00:00Z' }, { content: 'Lives in X' }] });
    expect(md).toContain('- Likes tea');
    expect(md).toContain('- Lives in X');
  });
  test('custom instructions', () => {
    expect(renderCustomInstructions({ about_user_message: '', enabled: true })).toBe('No custom instructions set.');
    expect(renderCustomInstructions(null)).toBe('No custom instructions set.');
    const md = renderCustomInstructions({ about_user_message: 'I am a dev', about_model_message: 'Be terse', traits_model_message: '', name_user_message: 'G' });
    expect(md).toContain('I am a dev');
    expect(md).toContain('Be terse');
    expect(md).toContain('G');
    expect(md).not.toMatch(/traits/i);
  });
  test('projects accept both shapes', () => {
    const inner = { id: 'g-p-1', display: { name: 'Proj One', description: 'desc' }, instructions: 'Do X', created_at: '2026-01-01T00:00:00Z' };
    const a = renderProjects([{ gizmo: { gizmo: inner, files: [{ name: 'a.txt' }] }, files: [{ name: 'a.txt' }], conversationIds: ['1', '2'] }]);
    const b = renderProjects([{ gizmo: inner, files: [{ name: 'a.txt' }], conversationIds: ['1'] }]);
    for (const md of [a, b]) {
      expect(md).toContain('Proj One');
      expect(md).toContain('desc');
      expect(md).toContain('Do X');
      expect(md).toContain('a.txt');
    }
    expect(a).toMatch(/2 chats/);
    expect(renderProjects([])).toContain('No projects');
  });
  test('gpts', () => {
    const md = renderGpts([{ gizmo: { id: 'g-abc', display: { name: 'Helper', description: 'helps' }, instructions: 'Be nice' }, tools: [{ type: 'browser' }, { type: 'python' }] }, {}]);
    expect(md).toContain('Helper');
    expect(md).toContain('g-abc');
    expect(md).toContain('helps');
    expect(md).toContain('Be nice');
    expect(md).toContain('browser');
    expect(renderGpts([])).toContain('No GPTs');
  });
});

// ---------------------------------------------------------------- review fixes
const S = '';
const E = '';
const SEP = '';
const oneMsgChat = (assistantContent, extra = {}, title = 'T') => conv({
  u: node('u', null, ['a'], msg('user', text('q'))),
  a: node('a', 'u', [], msg('assistant', assistantContent, extra)),
}, 'a', { title });

describe('citation spans and entity markers', () => {
  test('entity span renders its display name, other spans vanish', () => {
    const t = `Visit ${S}entity${SEP}["city","Paris","capital"]${E} and ${S}cite${SEP}turn0search0${E}done ${S}navlist${SEP}x${SEP}turn1${E}.`;
    const md = renderChat(oneMsgChat(text(t)));
    expect(md).toContain('Visit Paris and done .');
    expect(md).not.toMatch(/[-]/);
    expect(md).not.toContain('turn0search0');
  });
  test('entity falls back to last string, tolerates malformed payloads', () => {
    const t = `${S}entity${SEP}["x",5]${E}|${S}entity${SEP}["only"]${E}|${S}entity${SEP}not json${E}|${S}entity${E}|${S}entity${SEP}["a","","d"]${E}`;
    const md = renderChat(oneMsgChat(text(t)));
    expect(md).toContain('x|only|||d');
  });
  test('filecite and image_group are removed, stray markers cleaned', () => {
    const md = renderChat(oneMsgChat(text(`A${S}filecite${SEP}turn0file0${E}B${S}image_group${SEP}{"q":1}${E}C${E}${SEP}D`)));
    expect(md).toContain('ABCD');
  });
});

describe('file link encoding', () => {
  test('encodes #, %, ?, spaces and parentheses per segment, keeps / and ../', () => {
    const files = [['f1', 'report #2.pdf'], ['f2', '100%.png'], ['f3', 'what?(1).txt']];
    const attachments = files.map(([id, name]) => ({ id, name, mime_type: 'application/pdf' }));
    const fileLinks = new Map(files.map(([id, name]) => [id, `../files/dir x/${name}`]));
    const md = renderChat(oneMsgChat({ content_type: 'text', parts: ['x'] }, { metadata: { attachments } }), { fileLinks });
    expect(md).toContain('](../files/dir%20x/report%20%232.pdf)');
    expect(md).toContain('](../files/dir%20x/100%25.png)');
    expect(md).toContain('](../files/dir%20x/what%3F%281%29.txt)');
  });
  test('source URLs are left as URLs', () => {
    const md = renderChat(oneMsgChat(text('x'), { metadata: { content_references: [{ url: 'https://ex.com/a?b=1#c', title: 'T' }] } }));
    expect(md).toContain('[T](https://ex.com/a?b=1#c)');
  });
});

describe('markdown and html injection in network-provided names', () => {
  const evil = '<img src=x onerror=alert(1)> & [x](y)';
  const neutral = (md) => {
    expect(md).not.toContain('<img');
    expect(md).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; \\[x\\](y)');
  };
  test('chat H1 and project line', () => {
    const md = renderChat(oneMsgChat(text('x'), {}, evil), { projectName: evil });
    neutral(md.split('\n')[0]);
    neutral(md.split('\n').find((l) => l.startsWith('- Project:')));
  });
  test('leading # in a title cannot form a heading', () => {
    expect(renderChat(oneMsgChat(text('x'), {}, '# Evil')).split('\n')[0]).toBe('# \\# Evil');
  });
  test('index link text and project heading', () => {
    const e = { id: 'a', title: evil, create_time: '2026-10-13T00:00:00Z', project_name: evil, baseName: 'b', status: 'done', messageCount: 1, files: [] };
    const md = renderIndex({ a: e });
    neutral(md.split('\n').find((l) => l.startsWith('## ')));
    neutral(md.split('\n').find((l) => l.startsWith('- [')));
  });
  test('bundle TOC and fallback heading', () => {
    const md = buildBundles([{ baseName: 'b', title: evil, create_time: '2026-10-13T00:00:00Z', markdown: 'body' }])[0].content;
    neutral(md.split('\n').find((l) => l.startsWith('- [')));
    neutral(md.split('\n').find((l) => l.startsWith('## ') && l !== '## Contents'));
  });
  test('project and GPT headings', () => {
    neutral(renderProjects([{ gizmo: { gizmo: { name: evil } } }]).split('\n').find((l) => l.startsWith('## ')));
    neutral(renderGpts([{ gizmo: { display: { name: evil } } }]).split('\n').find((l) => l.startsWith('## ')));
  });
});

describe('reasoning block safety', () => {
  test('thought text cannot close or inject inside the details block', () => {
    const c = conv({
      u: node('u', null, ['t'], msg('user', text('q'))),
      t: node('t', 'u', ['a'], msg('assistant', { content_type: 'thoughts', thoughts: [{ summary: 'S', content: 'x </details><img src=x onerror=1> </DETAILS>' }] })),
      a: node('a', 't', [], msg('assistant', text('answer'))),
    }, 'a');
    const md = renderChat(c);
    expect(md.match(/<\/details>/gi).length).toBe(1);
    expect(md).not.toContain('<img');
    expect(md).toContain('&lt;/details>');
  });
});

describe('other versions note', () => {
  const alt = (nested) => conv({
    u: node('u', null, ['a'], msg('user', text('q'))),
    a: node('a', 'u', ['m', 'b'], msg('assistant', text('hi'))),
    m: node('m', 'a', [], msg('user', text('main'))),
    b: node('b', 'a', nested ? ['c', 'd'] : ['c'], msg('user', text('alt'))),
    c: node('c', 'b', [], msg('assistant', text('alt answer'))),
    ...(nested ? { d: node('d', 'b', [], msg('assistant', text('deeper'))) } : {}),
  }, 'm');
  test('note appears only when an alternate version itself branches', () => {
    expect(renderChat(alt(true))).toContain('## Other versions\n\nDeeper alternatives are in the .json file.');
    expect(renderChat(alt(false))).toContain('## Other versions');
    expect(renderChat(alt(false))).not.toContain('Deeper alternatives');
  });
});
