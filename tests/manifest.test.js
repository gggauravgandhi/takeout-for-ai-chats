import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));

// Every html/js/css file that ships in the extension (tests, docs, probe, scripts do not ship).
function extensionFiles() {
  const top = readdirSync(root).filter((f) => /\.(html|js|css)$/.test(f));
  const src = readdirSync(join(root, 'src')).filter((f) => /\.(js|css)$/.test(f)).map((f) => `src/${f}`);
  return [...top, ...src].map((path) => ({ path, text: readFileSync(join(root, path), 'utf8') }));
}
const files = extensionFiles();
const htmlFiles = files.filter((f) => f.path.endsWith('.html'));

describe('manifest', () => {
  test('is Manifest V3 with the single-purpose name and a short description', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.name).toBe('Takeout for AI Chats');
    expect(manifest.version).toBe('1.0.0');
    expect(manifest.description.length).toBeLessThanOrEqual(132);
    expect(Number(manifest.minimum_chrome_version)).toBeGreaterThanOrEqual(122);
  });

  test('asks for exactly storage and chatgpt.com', () => {
    expect(manifest.permissions).toEqual(['storage']);
    expect(manifest.host_permissions).toEqual(['https://chatgpt.com/*']);
    expect(manifest.optional_permissions).toBeUndefined();
  });

  test('has no background worker, content scripts, or custom CSP', () => {
    expect(manifest.background).toBeUndefined();
    expect(manifest.content_scripts).toBeUndefined();
    expect(manifest.content_security_policy).toBeUndefined();
  });

  test('every referenced file exists', () => {
    const icons = [...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)];
    for (const path of [manifest.action.default_popup, ...icons]) {
      expect(existsSync(join(root, path))).toBe(true);
    }
    expect(Object.keys(manifest.icons).sort()).toEqual(['128', '16', '32', '48']);
  });
});

describe('no remote or dynamic code', () => {
  test('no eval, new Function, or innerHTML assignment', () => {
    for (const { path, text } of files) {
      expect({ path, bad: /\beval\(|new Function\(|\.innerHTML\s*[+]?=/.test(text) }).toEqual({ path, bad: false });
    }
  });

  test('no http:// script, stylesheet, or import references', () => {
    const remote = /(src|href)\s*=\s*["']http:\/\/|from\s+["']https?:|import\(\s*["']https?:|@import\s+(url\()?["']?https?:/;
    for (const { path, text } of files) {
      expect({ path, bad: remote.test(text) }).toEqual({ path, bad: false });
    }
  });

  test('no https CDN scripts or stylesheets either', () => {
    const remote = /<(script|link)\b[^>]*(src|href)\s*=\s*["']https?:/i;
    for (const { path, text } of htmlFiles) {
      expect({ path, bad: remote.test(text) }).toEqual({ path, bad: false });
    }
  });
});

describe('html pages', () => {
  test('there are a popup and an exporter page', () => {
    expect(htmlFiles.map((f) => f.path).sort()).toEqual(['exporter.html', 'popup.html']);
  });

  test('scripts are local ES modules with a src, never inline', () => {
    for (const { path, text } of htmlFiles) {
      const tags = [...text.matchAll(/<script\b([^>]*)>/gi)].map((m) => m[1]);
      expect(tags.length).toBeGreaterThan(0);
      for (const attrs of tags) {
        expect({ path, attrs, ok: /type="module"/.test(attrs) && /src="(?!\w+:|\/\/)[^"]+"/.test(attrs) }).toEqual({
          path,
          attrs,
          ok: true,
        });
      }
    }
  });

  test('every local script and stylesheet a page references exists', () => {
    for (const { text } of htmlFiles) {
      const refs = [...text.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="([^"#]+)"/gi)].map((m) => m[1]);
      for (const ref of refs) expect(existsSync(join(root, ref))).toBe(true);
    }
  });
});

describe('copy', () => {
  test('no em dashes in shipped files or user-facing docs', () => {
    const docs = ['PRIVACY.md', 'README.md', 'docs/store-listing.md'].map((path) => ({
      path,
      text: readFileSync(join(root, path), 'utf8'),
    }));
    for (const { path, text } of [...files, ...docs]) {
      expect({ path, bad: text.includes('\u2014') }).toEqual({ path, bad: false });
    }
  });
});
