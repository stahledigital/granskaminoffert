// D19: sidornas källa är nu bootstrap-HTML + gmo.css + gmo-*.js. Statiska källtester läser allt som en sammanhängande text
// (radbrytningar/indrag borttagna så minifierade regex mot CSS fortsatt träffar).
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SPA = new Set(["index.html", "jamfor/index.html", "forkontroll/index.html"]);
export function pageSource(f) {
  const html = readFileSync(ROOT + f, "utf8");
  if (!SPA.has(f)) return html;
  const assets = readdirSync(ROOT + "assets").filter((n) => /^gmo.*\.(css|js)$/.test(n)).sort();
  const all = html + "\n" + assets.map((n) => readFileSync(ROOT + "assets/" + n, "utf8")).join("\n");
  return all.replace(/\n\s*/g, "");
}
