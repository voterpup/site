#!/bin/bash
# Stamp a build version into the app + version.json, sync 404.html, validate JS, commit, push.
set -e
cd "$(dirname "$0")"
V=$(date -u +%Y%m%d%H%M%S)
sed -i "s/var APP_VERSION = \"[0-9a-z]*\";/var APP_VERSION = \"$V\";/" app.html
echo "{\"v\":\"$V\"}" > version.json
cp app.html 404.html
node -e "const fs=require('fs');const s=fs.readFileSync('app.html','utf8');[...s.matchAll(/<script>([\s\S]*?)<\/script>/g)].forEach(m=>new Function(m[1].replace('window.goatcounter','var _gc')));"
git add -A && git commit -q -m "${1:-deploy} [$V]" && git push -q origin main && echo "deployed $V"
