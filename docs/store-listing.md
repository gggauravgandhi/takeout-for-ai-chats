# Chrome Web Store listing

## Name
Takeout for AI Chats

## Short description (max 132 characters)
Export your ChatGPT chats, images and settings to a folder on your computer.

## Category
Productivity

## Detailed description

Takeout for AI Chats saves your ChatGPT chats, files and settings to a folder on your computer. It also works for Team/Business workspaces, where ChatGPT's built-in export is not available.

Supported today: ChatGPT. Support for other major AI chat apps is coming soon.

What you get:
- Every chat as a readable Markdown file and as raw JSON, including archived chats and chats in projects
- Uploaded files and generated images, saved next to their chat
- Your memory, custom instructions, projects, and GPTs used in your chats
- INDEX.md and bundle files that merge everything into a few big Markdown files for search or backup

Built for long exports (keep the exporter tab open and the computer awake; closing the tab pauses the export and Resume continues):
- Progress bar and live status in the toolbar popup
- Pause, resume and stop at any time
- Failed chats are listed with Retry and Skip, and finished chats are re-exported only if they changed in ChatGPT
- Rate limits are handled by waiting and retrying

Private by design: your chats go from chatgpt.com (and the file download links it returns for your own files) to the folder you choose. Your login token and cookies are never sent to those links. Nothing is sent to the developer or any third party. No analytics, no tracking, no remote code.

How to use: log in to chatgpt.com, click the extension icon, open the exporter, choose a folder, click Start export, and keep the tab open until it shows Export complete.

Please note: the extension uses the same internal requests as the ChatGPT website, exports your own data only, and may stop working if ChatGPT changes. Project files, GPT definitions and code interpreter output files are best effort.

Not affiliated with OpenAI. ChatGPT is a trademark of OpenAI.

## Single purpose statement
Export the signed-in user's own ChatGPT chats, files, images and account settings to a folder the user chooses on their computer.

## Permission justifications

- `storage`: stores export progress (counts, current chat, failed chats) so the toolbar popup can show progress and the export can resume. The browser also keeps a reference to the chosen folder (IndexedDB) so you can resume. Nothing else is stored.
- `https://chatgpt.com/*`: the extension reads the user's own conversations, files, memory, custom instructions and projects from chatgpt.com using the user's existing login. It also downloads files from the signed download links chatgpt.com returns for the user's own files, which may be on other OpenAI storage hosts. The login token and cookies are never sent to those links.

No remote code is used. All code ships inside the package.

## Data usage disclosure (Privacy practices tab)

Matches [PRIVACY.md](../PRIVACY.md).

- Data types the extension handles: Personally identifiable information (email and name from the account profile, written to account/me.json), Personal communications (chat content), Website content (chat files and images), Authentication information (it reads the login session token from chatgpt.com to make requests; the token is never stored or sent anywhere else). Tick only what the form lists and applies. All of it stays local: handled to write to the user's chosen folder, not transmitted to the developer.
- Collected and transmitted off the user's device: none. All data is written only to a folder on the user's computer.
- Certify: data is not sold to third parties; not used or transferred for purposes unrelated to the single purpose; not used for creditworthiness or lending.
- Privacy policy URL: https://github.com/gggauravgandhi/takeout-for-ai-chats/blob/main/PRIVACY.md

## Naming

The name avoids the ChatGPT mark (Chrome Web Store impersonation policy, OpenAI brand guidelines). ChatGPT is named only in the description, as the supported service.

## Images

| Store field | File | Status |
|---|---|---|
| Store icon (128x128, 96px art + 16px padding) | `icons/icon128.png` (inside the zip) | ready |
| Small promo tile (440x280, required) | `store/promo-small-440x280.png` | ready |
| Marquee promo (1400x560, optional) | `store/marquee-1400x560.png` | ready |
| Screenshots (1280x800, 1 to 5, at least 1 required) | capture yourself, see below | to do |

Regenerate the promo images with `swift scripts/store-assets.swift` and the icons with `bun scripts/make-icons.js`.

Screenshots must show the real extension, full bleed, 1280x800, PNG or JPEG without transparency. Suggested set:

1. Exporter tab during an export: big percent, progress bar, counts.
2. The "Export complete" dialog.
3. The popup during an export, placed on a plain 1280x800 background.
4. An exported chat open in a Markdown viewer, with an image inline.
5. INDEX.md open, showing chats grouped by project and month.

Avoid showing private chat titles: use a test account or blur them.

## Publish checklist

- [ ] Register a Chrome Web Store developer account (one-time $5 fee).
- [ ] Turn on 2-step verification for the Google account.
- [x] Privacy policy is public at https://github.com/gggauravgandhi/takeout-for-ai-chats/blob/main/PRIVACY.md
- [ ] Run `bun test` and a full manual export on a real account.
- [ ] Build the zip: `scripts/package.sh` (runs the tests, writes `dist/takeout-for-ai-chats.zip`).
- [ ] Check the zip contains no tests, docs or scripts: `unzip -l dist/takeout-for-ai-chats.zip`.
- [ ] Upload the zip in the developer dashboard, fill the listing text above, add screenshots and the promo tile.
- [ ] Fill Privacy practices (answers above), single purpose, permission justifications, and the privacy policy URL.
- [ ] Submit for review.
