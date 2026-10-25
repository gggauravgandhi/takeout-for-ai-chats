# Takeout for AI Chats

Export your ChatGPT chats to your computer: every chat as readable Markdown and raw JSON, the images and files in them, plus your memory, custom instructions and projects.

Works with personal accounts and with Team/Business workspaces, where ChatGPT's built-in export is not available. Everything is written to a folder you choose. Nothing is sent anywhere else.

Not affiliated with OpenAI. ChatGPT is a trademark of OpenAI.

## Install (before it is on the Chrome Web Store)

1. Download **[takeout-for-ai-chats.zip](https://github.com/gggauravgandhi/takeout-for-ai-chats/releases/latest/download/takeout-for-ai-chats.zip)** from the latest release.
2. Unzip it somewhere permanent, for example `Documents/takeout-for-ai-chats`. Chrome loads the extension from this folder, so do not delete it.
3. Open `chrome://extensions` (Chrome 122 or newer).
4. Turn on **Developer mode** (top right).
5. Click **Load unpacked** and select the unzipped folder (the one that contains `manifest.json`).
6. Pin the extension: click the puzzle icon in the toolbar, then the pin next to Takeout for AI Chats.

Chrome may show a "developer mode extensions" notice from time to time. That is normal for extensions installed this way.

**Updating:** download the new zip, replace the contents of the same folder, then click the reload arrow on the extension card in `chrome://extensions`. Your exports are not affected.

## Use

1. Log in to chatgpt.com in the same browser. If you have more than one workspace, switch to the one you want to export.
2. Click the extension icon, then **Open exporter**.
3. **Choose a folder** (an empty one), then **Start export**.
4. Keep the tab open until you see **Export complete**. You can pause, resume, or close the tab and continue later.

Run it again on the same folder at any time: it only fetches chats that are new or changed. Use a separate folder for each workspace.

## What you get

```
INDEX.md                               every chat, grouped by project and month, with links
chats/<date>_<title>_<id>.md           readable copy of each chat (edits and regenerations included)
chats/<date>_<title>_<id>.json         raw data, unchanged
files/<chat-id>/...                    images and files from each chat
bundles/bundle-NN.md                   all chats merged into at most 20 files, for search or upload
account/                               memory, custom instructions, projects, GPTs used
index.json                             export progress, used to resume
```

## If something goes wrong

- **Some chats failed or are partial:** use **Retry failed** in the exporter. Very old images can be gone on ChatGPT's side; those chats stay partial.
- **"Rate limiting" pause:** ChatGPT asked to slow down. Wait a few minutes and press **Resume**.
- **Logged out:** log in at chatgpt.com, then press **Resume**.
- **"ChatGPT changed how it returns data":** ChatGPT changed something this version does not understand. Please [open an issue](https://github.com/gggauravgandhi/takeout-for-ai-chats/issues).

## Limitations

- It uses the same undocumented requests as the ChatGPT website, so it can break when ChatGPT changes. It stops with a clear message instead of writing empty files.
- Best effort: project files, GPT definitions and code interpreter output files.
- Chrome only. It exports your own data only.
- Exported Markdown contains chat text as written, including links from web content. Open it in a viewer you trust.

## Privacy

Data goes from chatgpt.com (and the file links it returns for your own files) to your folder, and nowhere else. No analytics, no tracking, no remote code. Details: [PRIVACY.md](PRIVACY.md).

## Development

```
bun test                 # run the tests
scripts/package.sh       # build dist/takeout-for-ai-chats.zip
```

To run from source, use **Load unpacked** on this repository folder. Design notes: `docs/`.

## License

[MIT](LICENSE)
