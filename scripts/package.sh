#!/usr/bin/env bash
# Builds dist/takeout-for-ai-chats.zip: everything Chrome runs, nothing it does not
# (tests, docs, build scripts, git). Excluding is safer than listing: new runtime files are never missed.
set -euo pipefail
cd "$(dirname "$0")/.."
bun test
rm -rf dist && mkdir -p dist
zip -q -r dist/takeout-for-ai-chats.zip . \
  -x '.git/*' 'dist/*' 'tests/*' 'docs/*' 'scripts/*' 'node_modules/*' \
     '.gitignore' 'README.md' 'icons/icon.svg' '*.DS_Store'
# Every file a page or the manifest points at must be in the zip.
for ref in $(grep -ohE '(href|src)="[^"#:]+"' ./*.html | sed -E 's/.*="(.*)"/\1/') \
           $(grep -ohE '"icons/[^"]+"' manifest.json | tr -d '"'); do
  unzip -l dist/takeout-for-ai-chats.zip "$ref" >/dev/null || { echo "Missing from zip: $ref"; exit 1; }
done
echo "Built dist/takeout-for-ai-chats.zip ($(du -h dist/takeout-for-ai-chats.zip | cut -f1))"
