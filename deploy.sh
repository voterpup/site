#!/bin/bash
# Stamp a build version into the app + version.json, sync 404.html, validate JS, commit, push.
set -e
cd "$(dirname "$0")"
V=$(date -u +%Y%m%d%H%M%S)
sed -i "s/var APP_VERSION = \"[0-9a-z]*\";/var APP_VERSION = \"$V\";/" app.html
echo "{\"v\":\"$V\"}" > version.json
cp app.html 404.html && cp app.html index.html   # the root is the app: new visitor makes a pup, returning visitor gets the Pack
# real pages for the routes people share or type, so they answer 200 (chat apps only preview 200s); the app routes from there
for d in m join list issue pack groups mine wishes manage; do mkdir -p $d && cp app.html $d/index.html; done
# shared games and group invites get their own preview text
sed -i 's|<meta property="og:title" content="[^"]*">|<meta property="og:title" content="Guess the wish 🫣 Can you find mine?">|; s|<meta property="og:description" content="[^"]*">|<meta property="og:description" content="One of these answers is your friend'"'"'s. Guess which one. Free, no sign-up.">|' m/index.html
sed -i 's|<meta property="og:title" content="[^"]*">|<meta property="og:title" content="You'"'"'re invited to a VoterPup group 🐾">|; s|<meta property="og:description" content="[^"]*">|<meta property="og:description" content="Join, vote on topics together and chat. Free, anonymous, no account.">|' join/index.html
node -e "const fs=require('fs');const s=fs.readFileSync('app.html','utf8');[...s.matchAll(/<script>([\s\S]*?)<\/script>/g)].forEach(m=>new Function(m[1].replace('window.goatcounter','var _gc')));"
git add -A && git commit -q -m "${1:-deploy} [$V]" && git push -q origin main && echo "deployed $V"
