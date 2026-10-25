# Takeout for AI Chats

A Chrome extension that saves your ChatGPT chats to a folder on your computer: every chat as Markdown and JSON, with its images and files, plus your memory, custom instructions and projects. Works with Team and Business workspaces too.

Supports ChatGPT today. Other AI chat apps are coming.

## Install

It is not on the Chrome Web Store yet, so you load it as an unpacked extension:

1. Download [takeout-for-ai-chats.zip](https://github.com/gggauravgandhi/takeout-for-ai-chats/releases/latest/download/takeout-for-ai-chats.zip) and unzip it somewhere you will keep it.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and pick the unzipped folder.

To update, replace the folder's contents with the new zip and click the reload arrow on the extension.

## Use

1. Log in to chatgpt.com.
2. Click the extension icon, then **Open exporter**.
3. **Choose a folder**, then **Start export**.
4. Keep the tab open until you see **Export complete**.

Run it again on the same folder later to pick up new and changed chats.

Team users: switch to the workspace you want in ChatGPT first, and use a separate folder for each workspace.

## Your folder

```
INDEX.md         list of every chat, with links
chats/           each chat as .md (readable) and .json (raw)
files/           images and files, one folder per chat
bundles/         all chats merged into up to 20 files
account/         memory, custom instructions, projects
index.json       progress, used to resume
```

## Good to know

- You can pause, resume, or close the tab and continue later. Failed chats can be retried or skipped.
- If ChatGPT slows the export down or you get logged out, it pauses. Fix that, then press **Resume**.
- Some things may no longer exist on ChatGPT's side (very old images, project files, code interpreter output). Those chats are marked partial.
- It uses the same requests as the ChatGPT website, so a ChatGPT update can break it. If it stops with "ChatGPT changed how it returns data", please [open an issue](https://github.com/gggauravgandhi/takeout-for-ai-chats/issues).
- Exported Markdown contains chat text exactly as written, including links. Open it in a viewer you trust.

## Privacy

Everything stays on your computer. Nothing is sent to the developer or anyone else, and there is no analytics or tracking. Details in [PRIVACY.md](PRIVACY.md).

## Development

```
bun test             # run the tests
scripts/package.sh   # build dist/takeout-for-ai-chats.zip
```

To run from source, use **Load unpacked** on this repository folder. Design notes are in `docs/`.

---

MIT license. Not affiliated with OpenAI. ChatGPT is a trademark of OpenAI.
