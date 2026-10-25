# ChatGPT Takeout: design

Date: 2026-10-25. Status: draft for review.

## Goal

A Chrome extension that exports everything a logged-in user can reach in their ChatGPT
account (Team workspaces included, which have no official export) into a folder on disk:
one raw JSON and one readable Markdown file per chat, every downloadable file and image,
and account data (memory, custom instructions, projects). It must survive failures,
resume where it stopped, and be publishable on the Chrome Web Store. Chrome only.

Out of scope: importing into another account, other browsers, a zip download.

## Facts verified on a real Team account (2026-10-25)

- `GET /api/auth/session` (cookies) returns `accessToken` and `account.id`.
- Every `/backend-api/*` call needs `Authorization: Bearer <token>` and
  `ChatGPT-Account-Id: <account.id>`. Without the header a Team user sees only the 2
  personal chats instead of the 7 workspace chats.
- `GET /backend-api/conversations?offset&limit=100&order=updated` lists chats, project
  chats included (`gizmo_id` starts with `g-p-`). `&is_archived=true` lists archived ones.
- `GET /backend-api/conversation/{id}` returns the full tree: `mapping`, `current_node`,
  model, timestamps, tool calls, reasoning.
- Files appear as `asset_pointer: "sediment://file_..."` (or `file-service://file-...`)
  in message parts, and as `metadata.attachments[].id` with name, mime and size.
- `GET /backend-api/files/download/{fileId}?conversation_id={id}&inline=false` returns
  `{status, download_url, file_name, mime_type}`. Fetching `download_url` returns the bytes.
  Works for uploads and generated images.
- `GET /backend-api/gizmos/snorlax/sidebar` lists projects (paged by `cursor`).
  `GET /backend-api/gizmos/{g-p-id}` returns the project (instructions, `files`).
  `GET /backend-api/gizmos/{g-p-id}/conversations?cursor=0` lists its chats.
- `GET /backend-api/memories?include_memory_entries=true`, `/backend-api/user_system_messages`
  (custom instructions), `/backend-api/me` all return 200.
- An extension page with `host_permissions: https://chatgpt.com/*` can make all of the
  calls above and write files with `showDirectoryPicker()` (probe run by the user).

Unverified, best effort: project file downloads (test project had none), GPTs the user
created (no listing endpoint found; we save GPTs used in chats instead), code interpreter
output files, list paging beyond 100 chats.

## Architecture

No build step, no dependencies. Plain ES modules loaded by extension pages and by `bun test`.

```
manifest.json        MV3; permissions: storage; host_permissions: https://chatgpt.com/*
popup.html/.js/.css  control panel: reads state, sends commands, opens the Exporter tab
exporter.html/.js    the Exporter tab: picks the folder, runs the engine, shows detail
src/api.js           ChatGPT client: auth, paging, retry/backoff, token refresh
src/engine.js        the export loop; takes injected api + writer; owns resume and state
src/extract.js       finds file references in a conversation
src/markdown.js      chat -> Markdown, INDEX.md, bundles, account pages
src/names.js         safe, stable file names
src/folder.js        writer over a FileSystemDirectoryHandle; handle kept in IndexedDB
tests/*.test.js      bun test, with synthetic fixtures shaped like the real responses
```

Why the work runs in an extension tab, not the popup or the service worker: the popup
closes when it loses focus, and Chrome stops an idle service worker, which would kill a
multi-hour export. A tab lives as long as it is open. No background service worker at
all: the popup finds the Exporter tab with `chrome.runtime.getContexts` and focuses it with
`chrome.tabs.update`, which needs no `tabs` permission.

## Output folder

```
INDEX.md                               every chat grouped by project, then month; links
index.json                             export state (see Resume) plus per-chat metadata
chats/<YYYY-MM-DD>_<slug>_<id8>.json   raw conversation response, unchanged
chats/<YYYY-MM-DD>_<slug>_<id8>.md     readable copy
files/<conversation-id>/<file-name>    uploads and generated images
bundles/bundle-NN.md                   all chats merged into at most 20 files, oldest first
account/memories.json + .md
account/custom-instructions.json + .md
account/me.json
account/projects.json + .md            projects, instructions, chat ids per project
account/projects/<slug>/files/...      project files (best effort)
account/gpts.json + .md                GPTs used in chats (definitions)
```

The date in file names is the chat's creation date, so names stay the same across runs.

## Markdown copy of a chat

- Header: title, created and updated dates, model, project, archived flag, link to
  `https://chatgpt.com/c/<id>`.
- Body: the branch the user last saw (walk from `current_node` up to the root). Each turn
  labelled You / ChatGPT. Code blocks kept. Images embedded with relative links to
  `files/`; other attachments linked by name. Reasoning summaries in a collapsed
  `<details>` block. Hidden system messages and empty tool messages dropped. ChatGPT's
  private citation markers stripped.
- "Other versions" at the end: each edited or regenerated branch that is not on the main
  path, rendered from where it splits off.

## Popup and Exporter tab

Popup (always a mirror of state saved in `chrome.storage.local`, updated live):
- One main button that follows the state: Start export, Pause, Resume, Retry failed (N),
  Open Exporter.
- Progress bar with counts: chats done / total, files saved, failed, skipped. The chat
  being exported now.
- Failure list: chat title + reason, with Retry and Skip per item.
- A warning line when not logged in to chatgpt.com, with a link to log in.

Exporter tab: the same controls, plus the folder picker and a running log. Picking the
folder happens here because the browser only opens it on a click in that page.

Toolbar badge shows the percent while running, `!` when stopped by an error.

## Engine, resume and failures

1. Load or create `index.json` in the chosen folder.
2. Fetch account data (memory, instructions, me, projects, GPTs). Failures here are
   recorded and do not stop the chats.
3. List all chats (normal, archived, project chats; de-duplicated by id).
4. For each chat, oldest first: skip if `done` and `update_time` is unchanged; otherwise
   fetch, write JSON, download its files, write Markdown, mark `done` (or `partial` if any
   file failed). Write `index.json` after each chat.
5. Write `INDEX.md`, bundles and account pages at the end (regenerated every run).

States per chat: `done`, `partial`, `failed`, `skipped`. Resume = run again on the same
folder. "Retry failed" re-runs only `failed` and `partial`. Skip marks a chat `skipped`
so later runs leave it alone.

Pause takes effect between requests. Requests run one at a time with a short pause
between them (constant in `api.js`).

Failures:
- 429 or 5xx: wait for `Retry-After` if given, else back off exponentially, up to 5 tries.
- 401: fetch a new token from `/api/auth/session` once, retry; if still 401, stop the
  run with "Log in to chatgpt.com, then Resume".
- 404 on a file or `status != success`: record on the chat as an expired file, continue.
- Unexpected response shape (list without `items`, chat without `mapping`): stop the run
  with "ChatGPT changed how it returns data; this version can't read it" and a link to
  report it. Never write empty files.
- Folder permission lost on reopen: the Resume click calls `requestPermission()`.

## Chrome Web Store readiness

- Manifest V3, no remote code, default CSP, no third-party code.
- Permissions: `storage` and `https://chatgpt.com/*` only.
- `PRIVACY.md`: data goes only to the folder the user picks; nothing is sent elsewhere;
  no analytics. Data usage form in the dashboard must match.
- Name not led by "ChatGPT", own icon, no OpenAI marks. Working name: "Takeout for
  ChatGPT". Icons 16/32/48/128, listing text, screenshots 1280x800.
- Listing and README state: uses the same internal requests as the ChatGPT website,
  exports your own data only, can break when ChatGPT changes.

Publishing itself (developer account, upload, review) is done by the user.

## Testing

Written before the code, run with `bun test`:
- `extract`: finds asset pointers and attachments, de-duplicates.
- `markdown`: main branch order, other versions, image links, citation stripping,
  hidden messages dropped.
- `names`: unsafe characters, long titles, empty titles, stability.
- `engine`: with a fake API and an in-memory writer: full run, resume skips done chats,
  re-exports changed chats, retry-failed, 429 backoff, 401 refresh, file 404 makes
  `partial`, bad shape stops the run, pause.
- bundles: no more than 20 files, every chat appears exactly once.

Manual end to end on the user's Team account: full export of 7 chats, then a run
stopped midway and resumed, then checking the folder by hand.
