// File naming. Names must be stable across runs so resume can find earlier output.

const ILLEGAL = /[\u0000-\u001f<>:"/\\|?*\u007f]/g;
// Windows device names are reserved with any extension ("con.tar.gz"), in any case.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?=\.|$)/i;

/**
 * @param {number|string|null|undefined} t epoch seconds or ISO string
 * @returns {Date|null}
 */
export function toDate(t) {
  if (t === null || t === undefined || t === '') return null;
  const d = typeof t === 'number' ? new Date(t * 1000) : new Date(t);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * @param {string|null|undefined} text
 * @param {number} [max]
 * @returns {string}
 */
export function slugify(text, max = 60) {
  const slug = String(text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');
  return slug || 'untitled';
}

/**
 * @param {{ id: string, title?: string|null, create_time?: number|string|null }} chat
 * @returns {string} "YYYY-MM-DD_<slug>_<id8>"
 */
export function chatBaseName({ id, title, create_time }) {
  const d = toDate(create_time);
  const day = d ? d.toISOString().slice(0, 10) : 'undated';
  const idPart = String(id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 8);
  return `${day}_${slugify(title)}_${idPart}`;
}

/**
 * True for names this module could have generated. Use on values read back from index.json.
 * @param {unknown} name
 * @returns {boolean}
 */
export function isSafeBaseName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9._ -]+$/.test(name) && !name.includes('..');
}

/**
 * @param {string|null|undefined} name
 * @param {number} [max]
 * @returns {string}
 */
export function safeFileName(name, max = 120) {
  const stripped = String(name ?? '').replace(ILLEGAL, '_').replace(/^[\s.]+|[\s.]+$/g, '');
  if (!stripped) return 'file';
  const cleaned = stripped.replace(WINDOWS_RESERVED, '$&_');
  if (cleaned.length <= max) return cleaned;
  const dot = cleaned.lastIndexOf('.');
  const ext = dot > 0 && cleaned.length - dot <= 10 ? cleaned.slice(dot) : '';
  return cleaned.slice(0, max - ext.length) + ext;
}

/**
 * @param {string} name
 * @param {Set<string>} taken
 * @returns {string}
 */
export function uniqueName(name, taken) {
  // Case-insensitive: macOS and Windows treat Photo.png and photo.png as one file.
  const lower = new Set([...taken].map((n) => n.toLowerCase()));
  if (!lower.has(name.toLowerCase())) return name;
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let i = 2; ; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
}
