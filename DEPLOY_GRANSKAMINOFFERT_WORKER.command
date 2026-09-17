#!/bin/bash
# Dubbelklicka: publicerar Granskaminoffert-workern (worker/src/index.js) till Cloudflare.
# Kräver att "npx wrangler login" gjorts en gång på den här datorn (gjort 2026-09-17).
cd "$(dirname "$0")/worker" || exit 1
echo "== Granskaminoffert-worker: publicering =="
TOML=wrangler.toml
if grep -q 'REPLACE_AFTER_WRANGLER_KV_NAMESPACE_CREATE' "$TOML"; then
  echo "Letar upp KV-namespace på kontot..."
  KVID=$(npx -y wrangler kv namespace list 2>/dev/null | python3 -c '
import sys,json
try:
    d=json.load(sys.stdin)
except Exception:
    d=[]
c=[n for n in d if "REVIEWS" in n.get("title","").upper()]
print(c[0]["id"] if c else "")')
  if [ -z "$KVID" ]; then
    echo "Hittade inget KV-namespace med REVIEWS i namnet. Skriv i chatten: 'kv saknas' så löser Donatello det."
    read -r -p "Tryck Enter för att stänga."; exit 1
  fi
  sed -i '' "s/REPLACE_AFTER_WRANGLER_KV_NAMESPACE_CREATE/$KVID/" "$TOML"
  echo "KV-id inlagt: $KVID"
fi
npx -y wrangler deploy || { echo; echo "Publiceringen misslyckades – ta en skärmbild av texten ovan och skicka i chatten."; read -r -p "Tryck Enter för att stänga."; exit 1; }
echo
echo "Kontrollerar /health:"
sleep 3
curl -s https://granskaminoffert-api.anders-316.workers.dev/health; echo
echo
echo "Klart. Versionen ovan ska vara samma som i worker/src/index.js (WORKER_VERSION)."
read -r -p "Tryck Enter för att stänga."
