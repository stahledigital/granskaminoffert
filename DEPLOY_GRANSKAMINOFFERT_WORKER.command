#!/bin/bash
# Dubbelklicka: publicerar Granskaminoffert-workern (worker/src/index.js) till Cloudflare.
# Kräver att "npx wrangler login" gjorts en gång på den här datorn (gjort 2026-09-17).
cd "$(dirname "$0")/worker" || exit 1
echo "== Granskaminoffert-worker: publicering =="
# Prov före publicering (gmo-api-v17): ingenting publiceras om proven inte är gröna.
# Med Miniflare (MINIFLARE_DIR, eller verktygskopian nedan om den finns) körs hela sviten.
# Utan Miniflare körs hela sviten utom filerna som kräver workerd-harnesset (worker/dev/compare_harness.mjs);
# regel-, referens- och rabattproven ingår alltid. Röda prov, saknade provfiler eller saknad Node = stopp.
echo "Kör proven före publicering..."
if ! command -v node >/dev/null 2>&1; then
  echo "STOPP: Node.js saknas, så proven kan inte köras. Ingenting har publicerats."
  read -r -p "Tryck Enter för att stänga."; exit 1
fi
for KRAVFIL in test/referens.test.mjs test/rabatt.test.mjs test/rules.test.mjs test/rules_d03.test.mjs; do
  if [ ! -f "$KRAVFIL" ]; then
    echo "STOPP: provfilen $KRAVFIL saknas. Ingenting har publicerats."
    read -r -p "Tryck Enter för att stänga."; exit 1
  fi
done
MF_STANDARD="$HOME/Projekt/Ståhle Digital/ARBETSKOPIOR/claude-code-mottagning-20261021/tools/mf/node_modules/miniflare"
if [ -z "$MINIFLARE_DIR" ] && [ -d "$MF_STANDARD" ]; then export MINIFLARE_DIR="$MF_STANDARD"; fi
if [ -n "$MINIFLARE_DIR" ] && [ -f "$MINIFLARE_DIR/dist/src/index.js" ] && [ -f "$MINIFLARE_DIR/../esbuild/lib/main.js" ]; then
  PROVFILER=$(ls test/*.test.mjs)
  OMFANG="hela sviten, med Miniflare"
else
  unset MINIFLARE_DIR
  PROVFILER=$(grep -L "compare_harness" test/*.test.mjs)
  OMFANG="hela sviten utom workerd-harnesset (Miniflare saknas)"
fi
PROVLOGG=$(mktemp "${TMPDIR:-/tmp}/gmo-prov.XXXXXX") || { echo "STOPP: kunde inte skapa provloggen. Ingenting har publicerats."; read -r -p "Tryck Enter för att stänga."; exit 1; }
node --test --test-reporter=spec $PROVFILER >"$PROVLOGG" 2>&1
PROVSTATUS=$?
grep -E '^ℹ (tests|pass|fail|cancelled|skipped) ' "$PROVLOGG"
PROVPASS=$(grep -E '^ℹ pass ' "$PROVLOGG" | awk '{print $3}')
PROVFAIL=$(grep -E '^ℹ fail ' "$PROVLOGG" | awk '{print $3}')
if [ "$PROVSTATUS" -ne 0 ] || [ -z "$PROVPASS" ] || [ "$PROVPASS" -eq 0 ] || [ "$PROVFAIL" != "0" ]; then
  echo
  echo "Röda prov:"
  grep -E '^✖ ' "$PROVLOGG" | grep -v '^✖ failing tests' | sort -u | head -40
  echo
  echo "STOPP: proven gick inte igenom ($OMFANG). Ingenting har publicerats."
  echo "Hela provutskriften finns i $PROVLOGG. Ta en skärmbild av texten ovan och skicka i chatten."
  read -r -p "Tryck Enter för att stänga."; exit 1
fi
echo "OK: proven gröna ($OMFANG)."
echo
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
