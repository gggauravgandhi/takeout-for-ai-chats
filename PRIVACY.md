# Privacy policy: Takeout for AI Chats

Date: 2026-10-25

Takeout for AI Chats is a Chrome extension that saves your own ChatGPT data to a folder on your computer. It currently supports ChatGPT only. This page explains what the extension accesses and where that data goes.

## What the extension accesses

Using the login you already have in your browser, it reads from chatgpt.com:

- your conversations (including archived chats and project chats)
- files and images attached to or generated in those conversations
- your memory, custom instructions, and projects
- your account profile and basic account details (account id, plan type)

It checks that you are logged in (it reads `/api/auth/session`) when you open the exporter tab, and reads your data when you start an export (Start, Resume or Retry).

## What is written to your folder

Besides your chats and files, the export folder contains personal details:

- `account/me.json` is the raw profile response from ChatGPT, which can include your email, name and possibly phone number.
- `index.json` and `INDEX.md` include your account id.

Treat the folder as sensitive and store or share it accordingly.

## Where that data goes

Only to the folder you choose on your computer. Nothing is sent to the developer, to any server we run, or to any third party. The extension connects only to chatgpt.com and to the file download links chatgpt.com returns for your own files (these can be on other OpenAI storage hosts). Your login token and cookies are never sent to those links. It only reads your own data.

## What we do not do

- No analytics, telemetry, crash reporting or tracking of any kind.
- No advertising and no selling or sharing of data.
- No remote code: everything the extension runs ships inside the extension package.
- No account, sign-up, or password: it never sees or stores your password.

## What is stored in your browser

- `chrome.storage.local`: export progress only (counts, the current chat title, failed chats and their error messages), so the toolbar popup can show progress.
- IndexedDB: a reference to the folder you chose, so you can resume later without choosing it again. Chrome may ask you to re-confirm access to that folder.

## How to delete everything

- Remove the extension in `chrome://extensions`. This deletes the progress state and the folder reference.
- Delete the export folder from your computer. That removes every file the extension wrote.

## Permissions

- `storage`: save export progress (above).
- `https://chatgpt.com/*`: read your own ChatGPT data with your existing login.

## Contact and changes

If this policy changes, the date above will change with it. Questions or reports: open an issue at https://github.com/gggauravgandhi/takeout-for-ai-chats/issues.

Not affiliated with OpenAI. ChatGPT is a trademark of OpenAI.
