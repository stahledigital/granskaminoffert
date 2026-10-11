// Ren Worker-PDF-skrivare (inga beroenden, inga providerresurser). Bygger ett vanligt PDF 1.4-dokument med standardtypsnitten Helvetica/Courier (WinAnsi, svenska tecken),
// A4, radbrytning, tabeller med upprepad rubrikrad, sidfot "Sida x av y" och klickbara länkar (https://… och e-postadresser blir /Link-annoteringar).
// Deterministiskt: samma indata ⇒ samma byte (inga tidsstämplar), så att mejlets fryst begäran/hash är stabil vid omförsök. Innehållsströmmarna är okomprimerade (granskningsbara).
// Block: {t:"h1"|"h2"|"h3"|"p"|"b"(fet)|"li"|"kv"|"pre"|"hr"|"space"|"pagebreak"|"table"} – se renderPdf.

const PAGE_W = 595, PAGE_H = 842, MX = 52, MT = 56, MB = 58;
const TEXT_W = PAGE_W - 2 * MX;

// Helvetica AFM-bredder (tecken 32–126), 1000 enheter/em.
const HW = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015,
  667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333,
  556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const HB = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975,
  722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333,
  556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584]; // Helvetica-Bold
const BASE = { å: "a", ä: "a", á: "a", à: "a", â: "a", ã: "a", Å: "A", Ä: "A", Á: "A", À: "A", Â: "A", ö: "o", ó: "o", ò: "o", ô: "o", õ: "o", Ö: "O", Ó: "O", Ô: "O", é: "e", è: "e", ê: "e", ë: "e", É: "E", ü: "u", ú: "u", û: "u", Ü: "U", í: "i", ï: "i", ç: "c", ñ: "n" };
const SPECIAL = { "–": 0x96, "—": 0x97, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "…": 0x85, "€": 0x80, "™": 0x99 };
const REPL = { "⇒": "->", "→": "->", "←": "<-", "✓": "ja", "✗": "nej", "≥": ">=", "≤": "<=", "−": "-", "×": "x", " ": " ", " ": " ", " ": " ", "\t": " " };

export function normText(s) {
  let out = "";
  for (const ch of String(s)) {
    if (REPL[ch] !== undefined) { out += REPL[ch]; continue; }
    if (ch === "\n" || ch === "\r") { out += " "; continue; }
    const c = ch.codePointAt(0);
    if (c >= 32 && c <= 126) out += ch;
    else if (SPECIAL[ch] !== undefined) out += ch;
    else if (c >= 0xa1 && c <= 0xff) out += ch;
    else out += "?";
  }
  return out;
}
function code(ch) { const c = ch.codePointAt(0); return SPECIAL[ch] !== undefined ? SPECIAL[ch] : c; }
function cw(ch, font) {
  if (font === "F3") return 600;
  const b = BASE[ch] || ch; const c = b.charCodeAt(0);
  let w = c >= 32 && c <= 126 ? (font === "F2" ? HB : HW)[c - 32] : 556;
  if (SPECIAL[ch] !== undefined) w = ch === "•" ? 350 : ch === "…" ? 1000 : ch === "€" ? 556 : 556;
  return w;
}
function strW(s, font, size) { let w = 0; for (const ch of s) w += cw(ch, font); return (w * size) / 1000; }
function pdfStr(s) { // ren ASCII: högteckenbytes som oktala escapes
  let o = "(";
  for (const ch of s) {
    const c = code(ch);
    if (ch === "(" || ch === ")" || ch === "\\") o += "\\" + ch;
    else if (c < 32 || c > 126) o += "\\" + c.toString(8).padStart(3, "0");
    else o += ch;
  }
  return o + ")";
}
const URL_RE = /^(https?:\/\/[^\s]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})$/;
function linkOf(word) {
  const w = word.replace(/[.,;:!?)\]]+$/, "");
  if (!URL_RE.test(w)) return null;
  return /^https?:/.test(w) ? w : "mailto:" + w;
}
const n2 = (x) => (Math.round(x * 100) / 100).toString();

// Radbryt till rader av delar {text, url}; ord som är bredare än raden delas på tecken (varje del behåller sin länk).
function wrap(text, font, size, maxW) {
  const words = normText(text).split(" ").filter((w) => w.length);
  const lines = []; let cur = [], curW = 0;
  const sp = strW(" ", font, size);
  const push = () => { lines.push(cur); cur = []; curW = 0; };
  for (const word of words) {
    const url = linkOf(word);
    let rest = word;
    while (rest.length) {
      const ww = strW(rest, font, size);
      const need = (cur.length ? sp : 0) + ww;
      if (curW + need <= maxW) { cur.push({ text: rest, url, sp: cur.length ? sp : 0 }); curW += need; rest = ""; break; }
      if (cur.length) { push(); continue; }
      // ensam för bred: dela på tecken
      let k = 1, acc = 0; const chars = [...rest];
      while (k <= chars.length && acc + strW(chars[k - 1], font, size) <= maxW) { acc += strW(chars[k - 1], font, size); k++; }
      k = Math.max(1, k - 1);
      cur.push({ text: chars.slice(0, k).join(""), url, sp: 0 }); curW = strW(chars.slice(0, k).join(""), font, size); push();
      rest = chars.slice(k).join("");
    }
  }
  if (cur.length) push();
  return lines.length ? lines : [[]];
}

const STY = {
  h1: { font: "F2", size: 17, lead: 21, before: 0, after: 8 },
  h2: { font: "F2", size: 13, lead: 17, before: 12, after: 4 },
  h3: { font: "F2", size: 11, lead: 14, before: 8, after: 2 },
  p: { font: "F1", size: 10, lead: 13.5, before: 0, after: 4 },
  b: { font: "F2", size: 10, lead: 13.5, before: 0, after: 4 },
  li: { font: "F1", size: 10, lead: 13.5, before: 0, after: 2 },
  kv: { font: "F1", size: 10, lead: 13.5, before: 0, after: 1 },
  pre: { font: "F3", size: 9, lead: 12, before: 0, after: 0 },
  small: { font: "F1", size: 8.5, lead: 11.5, before: 0, after: 3 },
};

export function renderPdf({ title, subject = "", author = "", footer = "", blocks }) {
  const pages = []; let page = null, y = 0;
  const newPage = () => { page = { items: [], links: [] }; pages.push(page); y = PAGE_H - MT; };
  newPage();
  const ensure = (h) => { if (y - h < MB) newPage(); };
  const putLines = (lines, st, x0, maxW, opts = {}) => {
    for (const ln of lines) {
      ensure(st.lead);
      const base = y - st.size; let x = x0;
      for (const pc of ln) {
        x += pc.sp;
        const w = strW(pc.text, st.font, st.size);
        page.items.push({ x, y: base, font: st.font, size: st.size, text: pc.text, gray: opts.gray });
        if (pc.url) page.links.push({ x1: x, y1: base - 2, x2: x + w, y2: base + st.size, url: pc.url });
        x += w;
      }
      y -= st.lead;
    }
  };
  for (const b of blocks) {
    if (b.t === "space") { y -= b.h || 8; continue; }
    if (b.t === "pagebreak") { newPage(); continue; }
    if (b.t === "hr") { ensure(10); page.items.push({ rule: true, x1: MX, x2: PAGE_W - MX, y: y - 4 }); y -= 10; continue; }
    if (b.t === "table") { renderTable(b); continue; }
    if (b.t === "kv") {
      const st = STY.kv, kw = b.kw || 150;
      const kl = wrap(b.k, "F2", st.size, kw - 6), vl = wrap(b.v, "F1", st.size, TEXT_W - kw);
      const h = Math.max(kl.length, vl.length) * st.lead; ensure(Math.min(h, 200)); const y0 = y;
      putLines(kl, { ...st, font: "F2" }, MX, kw - 6); const y1 = y; y = y0; putLines(vl, st, MX + kw, TEXT_W - kw); y = Math.min(y, y1) - st.after;
      continue;
    }
    const st = STY[b.t] || STY.p;
    const indent = b.t === "li" ? 14 : 0;
    y -= st.before;
    if (b.t === "h1" || b.t === "h2" || b.t === "h3") ensure(st.lead + (b.t === "h3" ? 50 : 80)); // håll rubriken ihop med nästa stycke
    if (b.t === "li") { ensure(st.lead); page.items.push({ x: MX + 3, y: y - st.size, font: "F1", size: st.size, text: "•" }); }
    if (b.t === "pre") { for (const raw of String(b.text).split("\n")) { putLines(wrap(raw === "" ? " " : raw, st.font, st.size, TEXT_W), st, MX, TEXT_W); } }
    else putLines(wrap(b.text, st.font, st.size, TEXT_W - indent), st, MX + indent, TEXT_W - indent, { gray: b.gray });
    y -= st.after;
  }
  function renderTable(tb) {
    const fr = tb.cols, sumF = fr.reduce((a, c) => a + c, 0), pad = 4, size = 8.5, lead = 11;
    const ws = fr.map((f) => (f / sumF) * TEXT_W); const xs = []; let ax = MX; for (const w of ws) { xs.push(ax); ax += w; }
    const cellLines = (row, bold) => row.map((c, i) => wrap(String(c == null ? "" : c), bold ? "F2" : "F1", size, ws[i] - 2 * pad));
    const drawRow = (row, bold, shade) => {
      const cl = cellLines(row, bold); const hmax = Math.max(...cl.map((l) => l.length)) * lead + 2 * pad - 2;
      let k = 0; // en rad som är högre än en sida delas på radnivå
      let remaining = cl.map((l) => l.slice());
      while (remaining.some((l) => l.length)) {
        const avail = Math.floor((y - MB - 2 * pad + 2) / lead);
        if (avail < 2) { newPage(); if (tb.head && !bold) drawRow(tb.head, true, true); continue; }
        const take = Math.min(avail, Math.max(...remaining.map((l) => l.length)));
        const hh = take * lead + 2 * pad - 2;
        if (shade) page.items.push({ rect: true, x: MX, y: y - hh, w: TEXT_W, h: hh });
        remaining = remaining.map((l, i) => {
          const part = l.slice(0, take); const yy = y;
          const st = { font: bold ? "F2" : "F1", size, lead };
          const saveY = y; y = yy - pad + 2; // lokal skrivning utan sidbyte (take rymmer)
          for (const ln of part) { let x = xs[i] + pad; const base = y - size; for (const pc of ln) { x += pc.sp; const w = strW(pc.text, st.font, size); page.items.push({ x, y: base, font: st.font, size, text: pc.text }); if (pc.url) page.links.push({ x1: x, y1: base - 2, x2: x + w, y2: base + size, url: pc.url }); x += w; } y -= lead; }
          y = saveY; return l.slice(take);
        });
        page.items.push({ rule: true, x1: MX, x2: PAGE_W - MX, y: y - hh });
        y -= hh; k++;
        if (remaining.some((l) => l.length)) { newPage(); if (tb.head && !bold) drawRow(tb.head, true, true); }
      }
      void hmax;
    };
    if (tb.head) drawRow(tb.head, true, true);
    for (const r of tb.rows) drawRow(r, false, false);
    y -= 6;
  }

  // ---- serialisera ----
  const N = pages.length; const objs = []; // objs[i] = sträng för objekt i+1
  const add = (s) => { objs.push(s); return objs.length; };
  add("<< /Type /Catalog /Pages 2 0 R /Lang (sv-SE) /ViewerPreferences << /DisplayDocTitle true >> >>");
  add(""); // Pages, fylls sist
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>");
  add(`<< /Title ${pdfStr(normText(title))} /Subject ${pdfStr(normText(subject))} /Author ${pdfStr(normText(author))} /Producer (Jamfor Worker PDF 1) >>`);
  const kids = [];
  pages.forEach((pg, i) => {
    const ops = [];
    for (const it of pg.items) {
      if (it.rule) ops.push(`0.75 G 0.5 w ${n2(it.x1)} ${n2(it.y)} m ${n2(it.x2)} ${n2(it.y)} l S 0 G`);
      else if (it.rect) ops.push(`0.93 g ${n2(it.x)} ${n2(it.y)} ${n2(it.w)} ${n2(it.h)} re f 0 g`);
      else ops.push(`BT ${it.gray ? "0.35 g " : ""}/${it.font} ${n2(it.size)} Tf ${n2(it.x)} ${n2(it.y)} Td ${pdfStr(it.text)} Tj ${it.gray ? "0 g " : ""}ET`);
    }
    const ft = `${footer ? normText(footer) + "   " : ""}Sida ${i + 1} av ${N}`;
    ops.push(`BT 0.35 g /F1 8 Tf ${MX} 30 Td ${pdfStr(ft)} Tj 0 g ET`);
    const stream = ops.join("\n");
    const contentId = objs.length + 2, pageId = objs.length + 1;
    const annIds = pg.links.map((_, k) => objs.length + 3 + k);
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${contentId} 0 R${annIds.length ? ` /Annots [${annIds.map((a) => `${a} 0 R`).join(" ")}]` : ""} >>`);
    add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    for (const l of pg.links) add(`<< /Type /Annot /Subtype /Link /Rect [${n2(l.x1)} ${n2(l.y1)} ${n2(l.x2)} ${n2(l.y2)}] /Border [0 0 0] /A << /S /URI /URI ${pdfStr(l.url)} >> >>`);
    kids.push(pageId);
  });
  objs[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${N} >>`;
  let out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n"; const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff; // innehållet är ren ASCII utom binärmarkören
  return bytes;
}

export function b64Bytes(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
