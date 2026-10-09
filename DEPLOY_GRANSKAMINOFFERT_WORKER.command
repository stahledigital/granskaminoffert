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
# Bygg-id (commit) skickas med som variabel och visas i /health: då går live-versionen att
# jämföra mot en exakt commit, och en rollback till en känd commit går att bekräfta.
BUILD_ID=$(git -C .. rev-parse --short=12 HEAD 2>/dev/null || echo "okand")
if ! git -C .. diff --quiet 2>/dev/null; then BUILD_ID="${BUILD_ID}-osparat"; fi
echo "Bygg-id: $BUILD_ID"
npx -y wrangler deploy --var "BUILD_ID:$BUILD_ID" || { echo; echo "Publiceringen misslyckades – ta en skärmbild av texten ovan och skicka i chatten."; read -r -p "Tryck Enter för att stänga."; exit 1; }
echo
echo "Kontrollerar /health:"
sleep 3
HEALTH=$(curl -s https://granskaminoffert-api.anders-316.workers.dev/health); echo "$HEALTH"
echo
WANT=$(grep -o 'WORKER_VERSION = "[^"]*"' src/index.js | cut -d'"' -f2)
echo "$HEALTH" | grep -q "\"version\":\"$WANT\"" && echo "OK: version $WANT" || echo "AVVIKELSE: /health visar inte version $WANT"
echo "$HEALTH" | grep -q "\"build\":\"$BUILD_ID\"" && echo "OK: bygg $BUILD_ID" || echo "AVVIKELSE: /health visar inte bygg $BUILD_ID"
echo
echo "Klart. Spara raden ovan (version, build, model, referenceVersion) som rollbackunderlag."
read -r -p "Tryck Enter för att stänga."
