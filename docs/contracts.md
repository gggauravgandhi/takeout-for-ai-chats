# Module contracts

Source of truth for how modules talk to each other. Design rationale lives in
`docs/superpowers/specs/2026-10-25-chatgpt-takeout-design.md`. Read both.

Rules for all code: plain JavaScript ES modules (`.js`, `export function`), no build step, no
dependencies, JSDoc on exported functions, no mutation of inputs, no `console.log` in `src/`
(the engine reports through `onState`/`onLog`). Tests: `bun test`, files in `tests/`,
named `<module>.test.js`. Modules in `src/` must not touch `chrome.*` or the DOM, except
`src/folder.js` (File System Access + IndexedDB) and the page scripts (`popup.js`,
`exporter.js`).

## Real data shapes (verified on a live Team account, 2026-10-25)

Conversation (`GET /backend-api/conversation/{id}`), relevant fields:
```
{ conversation_id, title, create_time: 1792160509.36 (epoch seconds, float),
  update_time: 1792160517.38, current_node: "<node id>", gizmo_id: null | "g-p-..." | "g-...",
  is_archived, default_model_slug, mapping: { "<node id>": { id, parent: id|null,
  children: [id...], message: null | Message } } }
```
List item (`/backend-api/conversations`): same ids, but `create_time`/`update_time` are ISO
strings (`"2026-10-13T04:27:16.535268Z"`), `mapping: null`.

Message:
```
{ id, author: { role: "user"|"assistant"|"tool"|"system", name }, create_time, recipient: "all" | "<tool>",
  channel: null | "final" | "commentary", content: Content,
  metadata: { is_visually_hidden_from_conversation?: true, attachments?: [{ id, name, mime_type, size, width, height }],
              model_slug?, content_references?: [...], is_thinking_preamble_message?, finished_duration_sec?, ... } }
```
Content variants seen (content_type → fields):
- `text` → `parts: [string]`. May contain private citation markers: `` ... ``
  (with `` separators inside), e.g. `citeturn0search0`. Strip them.
- `multimodal_text` → `parts: [string | { content_type: "image_asset_pointer", asset_pointer:
  "sediment://file_<hex>" | "file-service://file-<id>", size_bytes, width, height, mime_type?,
  metadata: { dalle?: { gen_id, prompt } , generation? } }]`. Tool messages with this type
  carry generated images.
- `thoughts` → `thoughts: [{ summary, content, finished }]` (reasoning).
- `reasoning_recap` → `content: "Thought for 4s"`.
- `code` → `language, text`; `recipient` is the tool (`python`, `container.exec`,
  `<hash>.create` = canvas create, `api_tool.call_tool`, `web.run` ...).
- `execution_output` → `text`.
- Others may appear (`tether_browsing_display`, `tether_quote`, `system_error`,
  `user_editable_context`, `sonic_webpage`...). Render unknown types as a short fenced JSON
  of `content`, never crash.

## src/names.js (written)

- `toDate(t)`: epoch seconds | ISO string | null → `Date | null`.
- `slugify(text, max = 60)`: lowercase ascii slug, `untitled` when empty.
- `chatBaseName({ id, title, create_time })` → `"YYYY-MM-DD_<slug>_<first 8 chars of id>"` (UTC date).
- `safeFileName(name, max = 120)`: strips path separators and characters illegal on
  Windows/macOS, keeps extension, never empty. Windows device names (`CON`, `PRN`, `AUX`, `NUL`,
  `COM1-9`, `LPT1-9`, any case, any extension) get `_` appended to the stem.
- `uniqueName(name, taken: Set<string>)` → name, or `"stem (2).ext"`, ... not in `taken`.
  Comparison is case-insensitive; the returned name keeps its own case.
- `isSafeBaseName(name)` → true for names `chatBaseName` could produce. Used on values read back
  from `index.json`. `chatBaseName` replaces id characters outside `[A-Za-z0-9_-]` with `_`.

## src/extract.js (written)

- `fileIdFromPointer(ptr)` → `"file_..."` / `"file-..."` | null.
- `extractFileRefs(conversation)` → `FileRef[]`, unique by id, in tree order:
  `{ id, name: string|null, mime: string|null, size: number|null, source: "attachment"|"pointer", generated: boolean }`.
  Attachment metadata (name, mime) wins over pointer data for the same id.

## src/markdown.js (agent: markdown)

- `mainPath(conversation)` → `Node[]` root→current_node (skips nodes without message).
- `renderChat(conversation, { fileLinks, projectName, baseName })` → string.
  `fileLinks: Map<fileId, string>` relative path from the `chats/` folder, e.g.
  `../files/<conversation-id>/photo.jpg`. Missing id → render the file name with "(not downloaded)".
- `renderIndex(entries, { projects, exportedAt, account })` → string (`INDEX.md`).
  `entries`: the values of `index.json.chats` (see engine). `projects`: `[{ id, name }]`.
- `buildBundles(chats, maxFiles = 20)` → `[{ name: "bundle-01.md", content }]`.
  `chats`: `[{ baseName, title, create_time, markdown }]` oldest first. Every chat in exactly
  one bundle, bundles balanced by character count, a chat never split, each bundle starts
  with a table of contents.
- `renderMemories(json)`, `renderCustomInstructions(json)`, `renderProjects(projects)`,
  `renderGpts(gpts)` → string. Inputs are the raw API responses (`projects`: array of
  `{ gizmo, files, conversationIds }` as built by the engine).

## src/api.js (agent: api)

`createApi({ fetch = globalThis.fetch, base = "https://chatgpt.com", sleep, delayMs = 600, maxRetries = 5, now = Date.now })` → object:

- `session()` → `{ accessToken, accountId, planType, email }`; throws `ApiError(kind "auth")` when logged out
  (no token, or 401/403 from `/api/auth/session`).
- `listConversations({ archived = false })` → `ListItem[]` (pages `offset`/`limit=100` until `items` empty or offset ≥ total).
- `listProjects()` → raw sidebar items, paged by `cursor` until null.
- `getProject(gizmoId)` → raw `{ gizmo, files, ... }`.
- `listProjectConversations(gizmoId)` → `ListItem[]` (paged by `cursor`).
- `getConversation(id)` → raw conversation; throws `ApiError(kind "shape")` when `mapping` missing.
- `downloadFile(fileId, { conversationId, gizmoId })` → `{ blob, fileName, mime }`. Uses
  `/backend-api/files/download/{id}?conversation_id=...&inline=false` (or `gizmo_id=` for project
  files), checks `status === "success"`, then fetches `download_url` (may be relative: resolve
  against `base`; must be `https:`, otherwise `notfound` and nothing is fetched). Throws
  `ApiError(kind "notfound")` on 404/`status != success`, and on 401/403/404 from a download host
  other than `base` (expired signed link). The token is only sent to the exact `base` origin.
- `getMemories()`, `getCustomInstructions()`, `getMe()`, `getGizmo(id)`, `getGizmosBootstrap()` → raw JSON.

Every `/backend-api` request sends `Authorization: Bearer` + `ChatGPT-Account-Id`. Token comes from
`session()` lazily on first call. One request at a time, `delayMs` between requests.
429/5xx/network error: wait `Retry-After` seconds if present, else `2^attempt` seconds (via `sleep`),
up to `maxRetries`, then throw `kind "rate"` / `"http"` / `"network"`. 401 on a token-bearing request:
refresh the session once and retry; second 401 throws `kind "auth"`. 403 is never `auth`: it is
`kind "http"` (one item the account cannot read, e.g. another workspace's GPT). Unexpected shapes
throw `kind "shape"`.

`export class ApiError extends Error { constructor(kind, message, { status, url } = {}) }`
kinds: `auth | notfound | rate | http | network | shape`.

## Writer interface (src/folder.js, agent: engine)

```
writer.writeText(path, text)     // path like "chats/x.md"; creates folders
writer.writeJson(path, value)    // pretty JSON, 2 spaces
writer.writeBlob(path, blob)
writer.readText(path)            // → string | null when missing
writer.exists(path)              // → boolean
```
`createFolderWriter(dirHandle)` (File System Access), `createMemoryWriter()` (for tests,
exposes `.files: Map<path, string|Blob>`). Plus `saveHandle(handle)`, `loadHandle()` (IndexedDB),
`ensurePermission(handle, { request })` → `"granted" | "prompt" | "denied"`.

## src/engine.js (agent: engine)

`createEngine({ api, writer, onState = () => {}, onLog = () => {} })` → `{ run({ mode }), pause(), resume(), stop(), skip(chatId), getState() }`.
`mode`: `"all"` (default) or `"retry-failed"`. `run` resolves when finished, stopped, or failed fatally.

State (sent to `onState` after every change, also what popup shows):
```
{ phase: "idle"|"account"|"listing"|"chats"|"finishing"|"done"|"paused"|"stopped"|"error",
  total, done, partial, failed, skipped, filesSaved, current: { id, title } | null,
  failures: [{ id, title, error }], error: string | null, errorKind: string | null,
  startedAt, finishedAt }
```
`total`, the counts and `failures` always cover every chat known (index.json entries plus the
current listing), in every mode including `retry-failed`. `skip()` on an idle engine also emits state.
After 3 consecutive chats fail with `rate` or `network`, the engine pauses itself: `phase "paused"`,
`errorKind "rate"`, `error` = a human message; the chat that hit the limit is left pending (not
failed) and `resume()` retries it and clears `error`.

`index.json`:
```
{ version: 1, exportedAt, account: { planType, accountId },
  chats: { [id]: { id, title, create_time, update_time, project_id, project_name, archived, baseName,
                   status: "done"|"partial"|"failed"|"skipped", error, messageCount,
                   mdChars?: number (length of the chat .md, used to plan bundles),
                   files: [{ id, name, path, status: "done"|"failed", error }] } } }
```
Times in `index.json` are ISO strings. Written at most every 25 chats or 5 seconds, and always on
pause, stop, error and finish. `baseName` read back from it is recomputed if not `isSafeBaseName`.
Bundles are planned from `mdChars` (at most 20, contiguous) and rendered one at a time.

Flow and failure rules: exactly as the spec's "Engine, resume and failures" section. Fatal
(stop the run, phase "error"): `auth` after refresh, `shape`. Per-chat: anything else →
chat `failed`, continue. Per-file: any error → file `failed`, chat `partial`, continue.

## Pages (agent: ui)

`exporter.html` + `exporter.js` own the engine. They persist state to
`chrome.storage.local` key `"state"` and listen on `chrome.runtime.onMessage` for
`{ cmd: "start" | "pause" | "resume" | "stop" | "retry-failed" | "skip", id? }`.
`popup.html` + `popup.js` read/watch `"state"`, send commands, and open/focus the exporter tab
(`chrome.runtime.getContexts({ contextTypes: ["TAB"], documentUrls: [chrome.runtime.getURL("exporter.html")] })`
then `chrome.tabs.update(tabId, { active: true })` + `chrome.windows.update(windowId, { focused: true })`,
else `chrome.tabs.create`). Badge: `chrome.action.setBadgeText` from the exporter.
