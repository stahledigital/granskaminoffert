/* GMO shell (D19 + trust-viewport): rubrik/ingress per uppgift, compare-first startsida och start.
   Bootstrap-sidorna (/, /jamfor/, /forkontroll/) laddar samma skript;
   GMO_ENTRY anger bara vilken ingång sidan är (anonym volym i mätningen), inte vilken uppgift som är aktiv efter att kunden valt. */
(function () {
  'use strict';
  var G = window.GMO, $ = G.$, el = G.el;
  G.ENTRY = window.GMO_ENTRY || 'root';

  var INTRO = {
    none: { hd: 'Granska min offert', link: ['Ståhle Digital', 'https://stahledigital.se/verkstaden', false],
      h1: ['Jämför offerterna', 'innan du skriver på.'],
      lead: 'För villaägare med två eller fler hantverkarofferter. Se vad som skiljer i omfattning, pris och villkor – innan du bestämmer dig.' },
    free: { hd: 'Granska min offert', link: ['Ståhle Digital', 'https://stahledigital.se/verkstaden', false],
      h1: ['Granska en offert', 'innan ni skriver på.'],
      lead: 'För bygg, renovering och installation i hemmet. Hitta det som är oklart i en enda offert.' },
    compare: { hd: 'Jämför mina offerter', link: ['Till startsidan', '/', false],
      h1: ['Jämför 2–4 hantverkarofferter', 'för samma arbete.'],
      lead: 'Lägg in två till fyra offerter på samma jobb. Se skillnader i omfattning, pris och villkor sida vid sida.' },
    check: { hd: 'Förkontroll av min offert', link: ['Till startsidan', '/', false],
      h1: ['Kolla din egen offert', 'innan du skickar den.'],
      lead: 'För dig som ska skicka en hantverkaroffert: se vad en kund kommer att fråga om innan du skickar den.' }
  };

  function skeleton() {
    var app = $('app');
    app.textContent = '';
    var intro = el('div', { class: 'intro', id: 'intro' },
      el('header', {}, el('span', { id: 'hd-title' }), el('a', { id: 'hd-link', href: '#' })),
      el('h1', { id: 'task-heading', tabindex: '-1' }),
      el('p', { class: 'lead', id: 'lead' }));
    app.appendChild(intro);
    app.appendChild(el('div', { id: 'gmo-notice', class: 'warnbox hidden', role: 'status', 'aria-live': 'polite' }));
    app.appendChild(el('div', { id: 'chooser', class: 'hidden' }));
    app.appendChild(el('div', { id: 'task-root' }));
  }

  function setIntro(name) {
    var d = INTRO[name] || INTRO.none;
    $('hd-title').textContent = d.hd;
    var a = $('hd-link'); a.textContent = d.link[0]; a.setAttribute('href', d.link[1]);
    if (d.link[2]) a.setAttribute('data-gmo-task', d.link[2]); else a.removeAttribute('data-gmo-task');
    var h = $('task-heading'); h.textContent = '';
    h.appendChild(document.createTextNode(d.h1[0]));
    if (d.h1[1]) { h.appendChild(document.createElement('br')); h.appendChild(el('em', { text: d.h1[1] })); }
    $('lead').textContent = d.lead;
    var intro = $('intro');
    if (intro) intro.classList.toggle('intro-home', name === 'none');
  }

  function clarityDemo() {
    return el('div', { class: 'clarity', 'aria-label': 'Exempel: oklar offert rad blir konkret fråga' },
      el('div', { class: 'clarity-panel clarity-before' },
        el('span', { class: 'clarity-label', text: 'Oklar rad' }),
        el('p', { class: 'clarity-line', text: 'Rivning och återställning, 28 000 kr' })),
      el('div', { class: 'clarity-arrow', 'aria-hidden': 'true' }, el('span', { text: '→' })),
      el('div', { class: 'clarity-panel clarity-after' },
        el('span', { class: 'clarity-label', text: 'Konkret fråga' }),
        el('p', { class: 'clarity-line', text: 'Vilka ytor rivs – och ingår bortforsling och ytskikt?' })));
  }

  function primaryCompare(priceLabel) {
    return el('a', { class: 'hero-cta', href: '/jamfor/', 'data-gmo-task': 'compare', 'data-task-card': 'compare' },
      el('span', { class: 'hero-cta-kicker', text: 'Huvudvägen' }),
      el('strong', { text: 'Jämför 2–4 offerter' }),
      el('span', { class: 'hero-cta-meta', text: priceLabel }),
      el('span', { class: 'hero-cta-btn', text: 'Börja jämföra' }));
  }

  function sideLink(task, title, meta, cta) {
    return el('a', { class: 'side-link', href: G.urlOf(task), 'data-gmo-task': task, 'data-task-card': task },
      el('b', { text: title }),
      el('span', { class: 'side-meta', text: meta }),
      el('span', { class: 'side-cta', text: cta }));
  }

  function trustLine() {
    return el('p', { class: 'trustline', id: 'trustline' },
      'Offerten används bara för granskningen och raderas därefter. Inget konto. AI-läsning via Anthropic Claude – dölj personnummer och adress om du kan.');
  }

  function freeGateNote(host) {
    var note = el('p', { class: 'gate-note', id: 'free-gate-note', hidden: true, role: 'status' });
    host.appendChild(note);
    var url = (G.API_BASE || '').replace(/\/$/, '') + '/health';
    fetch(url, { headers: { accept: 'application/json' } }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
      if (!j || !j.freeGate) return;
      var open = !!j.freeGate.open;
      var state = String(j.freeGate.state || '');
      var freeCard = host.querySelector('[data-task-card="free"]');
      if (open) {
        note.hidden = true;
        if (freeCard) freeCard.classList.remove('is-paused');
        return;
      }
      note.hidden = false;
      note.textContent = state === 'utgangen'
        ? 'Gratisgranskningen är just nu stängd (pilotpott slut). Jämförelsen är huvudvägen – vi öppnar inte gratis igen utan ett nytt, tydligt steg.'
        : 'Gratisgranskningen är just nu stängd. Jämförelsen är huvudvägen.';
      if (freeCard) {
        freeCard.classList.add('is-paused');
        var meta = freeCard.querySelector('.side-meta');
        if (meta) meta.textContent = 'Just nu stängd · ingen ny gratisomgång utan beslut';
        var cta = freeCard.querySelector('.side-cta');
        if (cta) cta.textContent = 'Se status';
      }
    }).catch(function () { /* ärlig tystnad: saknad health ska inte låtsas öppna gratis */ });
  }

  function priceFromConfig(cfg) {
    try {
      var p = cfg && (cfg.priceLabel || cfg.priceText);
      if (typeof p === 'string' && p.trim()) return p.trim();
      var sek = cfg && (cfg.priceSek || cfg.amountSek || (cfg.pricing && cfg.pricing.compareSek));
      if (typeof sek === 'number' && isFinite(sek) && sek > 0) return Math.round(sek) + ' kr totalt, inkl. moms';
    } catch (e) {}
    return 'Engångsköp · inkl. moms';
  }

  G.shell = {
    render: function (name) {
      setIntro(name);
      $('chooser').classList.toggle('hidden', name !== 'none');
    },
    renderChooser: function () {
      var c = $('chooser'); c.textContent = '';
      var stage = el('div', { class: 'home-stage' });
      stage.appendChild(clarityDemo());
      stage.appendChild(trustLine());
      var priceLabel = 'Engångsköp · inkl. moms';
      var primary = primaryCompare(priceLabel);
      stage.appendChild(primary);
      var sides = el('div', { class: 'side-links', role: 'group', 'aria-label': 'Andra vägar' },
        sideLink('free', 'Granska en offert', 'Gratis när potten är öppen – betet, inte produkten', 'Granska en'),
        sideLink('check', 'Förkontrollera egen offert', 'För dig som ska skicka offerten', 'Förkontrollera'));
      stage.appendChild(sides);
      freeGateNote(stage);
      c.appendChild(stage);
      c.appendChild(el('p', { class: 'foot' }, document.createTextNode('Ett verktyg från '), el('a', { href: 'https://stahledigital.se/verkstaden', text: 'Ståhle Digital' }), document.createTextNode(' · '),
          el('a', { href: '/foretagsuppgifter/', text: 'Företagsuppgifter' }), document.createTextNode(' · '),
          el('a', { href: '/jamfor/angra/', text: 'Ångra ett köp' }), document.createTextNode(' · '),
          el('a', { href: 'mailto:hej@stahledigital.se', text: 'hej@stahledigital.se' })));

      if (G.config && G.config.load) {
        G.config.load().then(function (state) {
          var label = priceFromConfig(state && state.cfg);
          var meta = primary.querySelector('.hero-cta-meta');
          if (meta) meta.textContent = label;
          var closed = state && state.state === 'ok' && G.config.compareOpen && !G.config.compareOpen();
          if (closed) {
            var btn = primary.querySelector('.hero-cta-btn');
            if (btn) btn.textContent = 'Öppna jämförelse';
            primary.classList.add('is-draft');
          }
        }).catch(function () {});
      }
    }
  };

  function bootMode() {
    // Anonym, grov typ av ankomst (aldrig id/token): läsande resultatlänk, återupptagning eller ny.
    var h = new URLSearchParams(location.hash.replace(/^#/, ''));
    if (h.get('o') && h.get('r')) return 'readonly';
    if (h.get('o') && h.get('t')) return 'resume';
    var q = new URLSearchParams(location.search);
    if (/^o_[0-9a-f]{32}$/.test(q.get('order') || '')) return 'resume';
    return 'new';
  }

  function start() {
    skeleton();
    var name = G.routeOf(location);
    var mode = bootMode();
    G.measure.event('landing', { product: name, mode: mode });
    G.go(name, { reason: 'init', focus: false });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
