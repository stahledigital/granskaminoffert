/* GMO core (D19): gemensam kärna för gratisgranskning, jämförelse och förkontroll i ETT dokument.
   Innehåller: hjälpfunktioner, API-anrop, config-service (singleflight + generation), mätning (slutna enum, prefix klient_),
   arbetsyta i minnet (File-referenser, aldrig lagring), router (history/fokus/titel) och uppgiftsregister.
   Ingen uppgift skapar order, anropar AI eller kassa av att monteras – bara aktiva handlingar gör det. */
(function () {
  'use strict';
  var G = window.GMO = window.GMO || {};

  // ---------- hjälpfunktioner ----------
  var H = location.hostname;
  G.LOCAL = (H === 'localhost' || H === '127.0.0.1');
  G.API_BASE = G.LOCAL ? (new URLSearchParams(location.search).get('api') || location.origin) : 'https://granskaminoffert-api.anders-316.workers.dev';
  G.SD_TEST = /[?&]sd-test=1(&|$)/.test(location.search);
  G.$ = function (id) { return document.getElementById(id); };
  var KR = new Intl.NumberFormat('sv-SE');
  G.kr = function (v) { return KR.format(Math.round(v)) + ' kr'; };
  G.el = function (tag, attrs) {
    var e = document.createElement(tag); attrs = attrs || {};
    for (var k in attrs) { if (k === 'text') e.textContent = attrs[k]; else if (k === 'class') e.className = attrs[k]; else e.setAttribute(k, attrs[k]); }
    for (var i = 2; i < arguments.length; i++) { var c = arguments[i]; if (c == null) continue; e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); }
    return e;
  };
  G.show = function (id, on) { var n = G.$(id); if (n) n.classList.toggle('hidden', !on); };
  G.store = function (k, v) { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { return null; } };
  G.escapeHtml = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  G.fileKb = function (f) { return Math.max(1, Math.round(f.size / 1024)); };
  G.readAsBase64 = function (file) { return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(String(r.result).split(',')[1] || ''); }; r.onerror = rej; r.readAsDataURL(file); }); };
  G.readAsText = function (file) { return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(String(r.result)); }; r.onerror = rej; r.readAsText(file); }); };
  G.b64bytes = function (b) { var bin = atob(b), u = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
  // Underlag -> API-nyttolast. Först vid aktiv start, en fil åt gången; originalfilen i minnet ändras aldrig.
  G.docPayload = async function (s) {
    if (s.text && s.text.trim()) return { kind: 'text', text: s.text };
    if (!s.file) return null;
    var f = s.file, nm = f.name.toLowerCase();
    if (f.type === 'application/pdf' || nm.endsWith('.pdf')) return { kind: 'pdf', dataBase64: await G.readAsBase64(f) };
    if (f.type.indexOf('image/') === 0) return { kind: 'image', mediaType: f.type, dataBase64: await G.readAsBase64(f) };
    if (nm.endsWith('.txt') || f.type === 'text/plain') return { kind: 'text', text: await G.readAsText(f) };
    return { bad: true };
  };

  G.api = async function (method, path, opt) {
    opt = opt || {}; var h = {};
    if (opt.token) h['x-order-token'] = opt.token;
    if (opt.body !== undefined) h['content-type'] = 'application/json';
    var r = await fetch(G.API_BASE.replace(/\/$/, '') + path, { method: method, headers: h, body: opt.body !== undefined ? JSON.stringify(opt.body) : undefined });
    var j = null; try { j = await r.json(); } catch (e) {}
    return { status: r.status, json: j || {} };
  };

  // ---------- config-service: singleflight, generation, tydliga lägen ----------
  // Lägen: idle | loading | ok | failed. "Stängt" är ett svar (ok) där servern uttryckligen säger enabled/accepting=false eller check.available=false –
  // aldrig ett nät-/HTTP-/JSON-/timeoutfel. Högst en pågående begäran. Ett sent svar från en äldre generation tillämpas aldrig.
  // Högst ETT automatiskt omförsök när webbläsaren kommer online efter ett anslutningsfel; inga automatiska order-/betalningsförsök.
  var CFG = G.config = { state: 'idle', cfg: null, gen: 0, inflight: null, onlineRetryUsed: false, subs: [], timeoutMs: 10000, reason: null };
  function cfgNotify() { CFG.subs.slice().forEach(function (f) { try { f(CFG); } catch (e) {} }); }
  CFG.subscribe = function (f) { CFG.subs.push(f); return function () { CFG.subs = CFG.subs.filter(function (x) { return x !== f; }); }; };
  CFG.load = function (opts) {
    opts = opts || {};
    if (CFG.inflight) return CFG.inflight;
    if (CFG.state === 'ok' && !opts.force) return Promise.resolve(CFG);
    var gen = ++CFG.gen;
    CFG.state = 'loading'; CFG.reason = null; cfgNotify();
    var ctl = (typeof AbortController === 'function') ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, CFG.timeoutMs);
    var p = (async function () {
      var out = { ok: false, reason: 'network', cfg: null };
      try {
        var r = await fetch(G.API_BASE.replace(/\/$/, '') + '/compare/config', { headers: { accept: 'application/json' }, signal: ctl ? ctl.signal : undefined });
        if (!r.ok) out.reason = 'server';
        else {
          var j = null; try { j = await r.json(); } catch (e) { out.reason = 'server'; }
          if (j && typeof j === 'object' && !Array.isArray(j)) { out.ok = true; out.cfg = j; } else if (out.reason !== 'server') out.reason = 'server';
        }
      } catch (e) { out.reason = (e && e.name === 'AbortError') ? 'timeout' : 'network'; }
      return out;
    })().then(function (out) {
      clearTimeout(timer);
      if (gen !== CFG.gen) return CFG; // ersatt av nyare begäran: svaret tillämpas aldrig
      CFG.inflight = null;
      if (out.ok) { CFG.cfg = out.cfg; CFG.state = 'ok'; CFG.reason = null; CFG.onlineRetryUsed = false; }
      else { CFG.state = 'failed'; CFG.reason = out.reason; }
      cfgNotify(); return CFG;
    });
    CFG.inflight = p;
    return p;
  };
  CFG.retry = function () { CFG.onlineRetryUsed = false; return CFG.load({ force: true }); };
  CFG.compareOpen = function () { var c = CFG.cfg; return !!(c && c.enabled && c.accepting); };
  CFG.checkOpen = function () { var c = CFG.cfg; return !!(c && c.check && c.check.available); };
  CFG.isP = function (c) { c = c || CFG.cfg; return !!(c && c.consent && c.consent.policy === 'P'); };
  window.addEventListener('online', function () {
    if (CFG.state === 'failed' && !CFG.onlineRetryUsed && (CFG.reason === 'network' || CFG.reason === 'timeout')) { CFG.onlineRetryUsed = true; CFG.load({ force: true }); }
  });

  // ---------- mätning (D19): slutna enum, prefix klient_, aldrig råa URL:er/ID/innehåll ----------
  var M = G.measure = { landed: false, seen: {}, qa: G.SD_TEST };
  // Roll finns bara i gratisuppgiften; jämförelse och förkontroll rapporterar 'okand' (ingen roll har valts där).
  function role() { if (G.current && G.current.name !== 'free' && G.current.name !== 'none') return 'okand'; return (G.ws && G.ws.free && G.ws.free.path === 'hantverkare') ? 'hantverkare' : (G.current && G.current.name === 'none' ? 'okand' : 'mottagare'); }
  M.send = function (ev) {
    try {
      var url = G.API_BASE.replace(/\/$/, '') + '/event';
      var body = JSON.stringify(Object.assign({ type: 'client', test: M.qa }, ev));
      if (navigator.sendBeacon) { navigator.sendBeacon(url, new Blob([body], { type: 'application/json' })); }
      else { fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true }).catch(function () {}); }
    } catch (e) {}
  };
  // Händelser bär demoflagga/entry/roll enligt kontraktet (worker/MATNING.md). Demo tystar aldrig efterföljande egen användning:
  // flaggan följer med bara de händelser som själva sker i demoläget.
  M.event = function (name, f) {
    f = f || {};
    var ev = { event: name, entry: G.ENTRY, role: role(), product: (G.current && G.current.name) || 'none' };
    for (var k in f) if (f[k] !== undefined && f[k] !== null) ev[k] = f[k];
    if (M.demoSeen && (name === 'submit' || name === 'result_view') && !ev.demo) ev.seen = true; // servern normaliserar till 'sett_exempel' (worker/MATNING.md); flaggan är bool
    M.send(ev);
  };
  // Gamla fria händelser (rapport_klar/export/kontakt_cta) behåller exakt format och räknas av servern som förut.
  M.legacy = function (ev) { if (G.ws && G.ws.free && G.ws.free.demoActive) return; M.send(Object.assign({ role: role() }, ev)); };

  // ---------- arbetsyta i minnet ----------
  // Utkast per uppgift med originalfiler (File/Blob) i minnet. Ingen lagring, inget nätverk. Fullreload/ny flik/Stripe lämnar utkastet.
  G.ws = {
    free: { file: null, text: '', path: 'mottagare', demoActive: false },
    compare: { n: 2, slots: [], samejob: false },
    check: { file: null, text: '', own: false },
    receipt: null
  };

  // ---------- statusrader (delade av gratis, jämförelse, förkontroll och exempel) ----------
  // Fem olika betydelser med olika ord OCH symbol: ok (kontrollerat stämmer), ask (förtydliga/fråga), bad (beräknad avvikelse),
  // stated (anges i offerten men är inte verifierat), unknown (ej bedömt). Färg förstärker bara; ord och symbol bär betydelsen.
  G.ST_WORD = { ok: 'Stämmer', ask: 'Förtydliga', bad: 'Avvikelse', stated: 'Anges, ej verifierat', unknown: 'Ej bedömt' };
  G.ST_MARK = { ok: '✓', ask: '!', bad: '×', stated: '○', unknown: '–' };
  // word (valfritt) ersätter standardordet när raden behöver ett mer exakt ord med samma symbol/betydelse (t.ex. 'Inom referens', 'Delvis bedömt').
  G.stRowHtml = function (st, label, text, word) {
    return '<li class="st-row" data-st="' + st + '"><span class="st-mark" aria-hidden="true">' + G.ST_MARK[st] + '</span><div class="st-main"><span class="st-label">' + G.escapeHtml(label) +
      '</span><span class="st-word">· ' + G.escapeHtml(word || G.ST_WORD[st]) + '</span>' + (text ? '<span class="st-text">' + G.escapeHtml(text) + '</span>' : '') + '</div></li>';
  };
  G.stRow = function (st, label, text, word) { var t = document.createElement('template'); t.innerHTML = G.stRowHtml(st, label, text, word); return t.content.firstChild; };

  // ---------- explicit överföring av eget underlag mellan uppgifter (A2) ----------
  // Endast efter aktivt klick, endast eget underlag (aldrig exemplet), endast till TOMT mål (en påbörjad order i målet skyddas av målet självt:
  // underlaget ligger kvar i minnet men visas inte och skriver aldrig över ordern). Returnerar kvitto som målet visar.
  G.hasStoredOrder = function () { try { var r = JSON.parse(localStorage.getItem('jamfor_order') || 'null'); return !!(r && r.id); } catch (e) { return false; } };
  G.transfer = function (to, doc, o) {
    o = o || {};
    var r = { to: to, from: o.from || 'free', status: 'none', what: '' };
    if (!doc || (!doc.file && !(doc.text && doc.text.trim()))) return r;
    r.what = doc.file ? doc.file.name : 'text';
    if (to === 'compare') {
      var w = G.ws.compare, s0 = w.slots[0];
      if (s0 && (s0.file || (s0.text && s0.text.trim()))) { r.status = 'occupied'; r.why = 'draft'; return r; }
      w.slots[0] = { label: (s0 && s0.label) || '', file: doc.file || null, text: doc.file ? '' : doc.text, name: '', from: r.from };
      if (!w.n || w.n < 2) w.n = 2;
      r.status = 'copied'; return r;
    }
    if (to === 'check') {
      var k = G.ws.check;
      if (k.file || (k.text && k.text.trim())) { r.status = 'occupied'; r.why = 'draft'; return r; }
      k.file = doc.file || null; k.text = doc.file ? '' : doc.text; k.from = r.from;
      r.status = 'copied'; return r;
    }
    return r;
  };

  // ---------- uppgiftsregister och router ----------
  var TASKS = G.tasks = {};          // namn -> { factory, title, ... } (registreras av modulerna)
  G.registerTask = function (name, def) { TASKS[name] = def; };
  var cur = G.current = { name: 'none', inst: null, gen: 0 };
  G.busy = { n: 0, why: '' };
  G.setBusy = function (on, why) { if (on) { G.busy.n++; G.busy.why = why || G.busy.why; } else { G.busy.n = Math.max(0, G.busy.n - 1); if (!G.busy.n) G.busy.why = ''; } };

  var TITLES = {
    none: 'Granska din hantverkaroffert – bygg, renovering och installation',
    free: 'Granska en offert gratis – Granska min offert',
    compare: 'Jämför mina offerter – Granska min offert',
    check: 'Förkontroll av min offert – Granska min offert'
  };
  G.TITLES = TITLES;
  function routeOf(loc) {
    var p = loc.pathname.replace(/\/index\.html$/, '/');
    if (/^\/jamfor\/?$/.test(p)) return 'compare';
    if (/^\/forkontroll\/?$/.test(p)) return 'check';
    if (p === '/' && /(^|[#&])gratis(&|$)/.test(loc.hash)) return 'free';
    return 'none';
  }
  G.routeOf = routeOf;
  G.urlOf = function (name) { return name === 'compare' ? '/jamfor/' : name === 'check' ? '/forkontroll/' : name === 'free' ? '/#gratis' : '/'; };

  G.notice = function (msg) {
    var n = G.$('gmo-notice'); if (!n) return;
    n.textContent = msg || ''; n.classList.toggle('hidden', !msg);
  };

  // Byter uppgift. opts: push (history.pushState), focus, reason ('history'|'user'|'init'), keepHash.
  G.go = async function (name, opts) {
    opts = opts || {};
    if (!TASKS[name] && name !== 'none') return false;
    if (name === cur.name && cur.inst && !opts.force) return true;
    if (G.busy.n > 0 && cur.name !== 'none') {
      G.notice('Vänta tills pågående steg är klart (' + (G.busy.why || 'filerna skickas') + ') innan du byter uppgift. Inget har gått förlorat.');
      if (opts.reason === 'history') { try { history.pushState({ gmo: 1, task: cur.name }, '', G.urlOf(cur.name)); } catch (e) {} }
      return false;
    }
    G.notice('');
    var from = cur.name;
    if (cur.inst && cur.inst.unmount) { try { cur.inst.unmount(); } catch (e) {} }
    cur.inst = null; cur.gen++;
    var gen = cur.gen;
    cur.name = name;
    var app = G.$('app'); if (app) app.setAttribute('data-task', name);
    document.title = TITLES[name] || TITLES.none;
    if (opts.push) { try { history.pushState({ gmo: 1, task: name }, '', opts.url || G.urlOf(name)); } catch (e) {} }
    else if (opts.replace) { try { history.replaceState({ gmo: 1, task: name }, '', opts.url || G.urlOf(name)); } catch (e) {} }
    var root = G.$('task-root'); if (root) root.textContent = '';
    if (G.shell && G.shell.render) G.shell.render(name, from, opts);
    if (name !== 'none') {
      var def = TASKS[name];
      cur.inst = def.mount(G.$('task-root'), { task: name, gen: gen, from: from, reason: opts.reason || 'user', hash: location.hash });
    } else if (G.shell && G.shell.renderChooser) G.shell.renderChooser();
    if (opts.reason === 'history') { if (name !== 'none') M.event('view_return', { product: name, reason: 'history' }); }
    else if (from !== name && opts.reason === 'user' && name !== 'none') M.event('task_change', { from: from === 'none' ? 'none' : from, to: name });
    if (opts.focus !== false) {
      var h = G.$('task-heading'); if (h) { h.setAttribute('tabindex', '-1'); try { h.focus({ preventScroll: true }); } catch (e) {} }
      if (opts.reason !== 'init') { try { window.scrollTo(0, 0); } catch (e) {} }
    }
    return true;
  };

  window.addEventListener('popstate', function () {
    // Ankar inom sidan (t.ex. #om) är inte uppgiftsbyten: en ankarnavigering på rotsidan lämnar aktuell uppgift orörd.
    if (location.pathname.replace(/\/index\.html$/, '/') === '/' && location.hash && !/(^|[#&])gratis(&|$)/.test(location.hash)) return;
    G.go(routeOf(location), { reason: 'history', force: false });
  });

  // Interna länkar med data-gmo-task byter uppgift i samma dokument (progressivt: utan skript är de vanliga länkar).
  document.addEventListener('click', function (ev) {
    var a = ev.target && ev.target.closest && ev.target.closest('a[data-gmo-task]');
    if (!a || ev.defaultPrevented || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button === 1) return;
    ev.preventDefault();
    G.go(a.getAttribute('data-gmo-task'), { push: true, reason: 'user' });
  });
})();
