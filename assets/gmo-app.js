/* GMO shell (D19): rubrik/ingress per uppgift, uppgiftsval och start. Bootstrap-sidorna (/, /jamfor/, /forkontroll/) laddar samma skript;
   GMO_ENTRY anger bara vilken ingång sidan är (anonym volym i mätningen), inte vilken uppgift som är aktiv efter att kunden valt. */
(function () {
  'use strict';
  var G = window.GMO, $ = G.$, el = G.el;
  G.ENTRY = window.GMO_ENTRY || 'root';

  var INTRO = {
    none: { hd: 'Granska min offert', link: ['Ståhle Digital', 'https://stahledigital.se/verkstaden', false],
      h1: ['Granska din hantverkaroffert.'], lead: 'För bygg, renovering och installation i hemmet. Välj vad du vill göra med din offert.' },
    free: { hd: 'Granska min offert', link: ['Ståhle Digital', 'https://stahledigital.se/verkstaden', false],
      h1: ['Granska din hantverkaroffert.'], lead: 'För bygg, renovering och installation i hemmet. Hitta det som är oklart innan ni skriver på.' },
    compare: { hd: 'Jämför mina offerter', link: ['Granska en offert gratis', '/#gratis', 'free'],
      h1: ['Jämför 2–4 hantverkarofferter för samma arbete.', 'Se vad som skiljer.'],
      lead: 'För bygg, renovering och installation i hemmet. Lägg in två till fyra hantverkarofferter på samma arbete.' },
    check: { hd: 'Förkontroll av min offert', link: ['Granska en offert gratis', '/#gratis', 'free'],
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
  }

  function chooserCard(task, title, price, text, cta) {
    var href = G.urlOf(task);
    return el('a', { class: 'taskcard', href: href, 'data-gmo-task': task, 'data-task-card': task },
      el('b', { text: title }), el('span', { class: 'tk-price', text: price }), el('span', { class: 'tk-text', text: text }), el('span', { class: 'tk-cta', text: cta }));
  }

  G.shell = {
    render: function (name) {
      setIntro(name);
      $('chooser').classList.toggle('hidden', name !== 'none');
    },
    renderChooser: function () {
      var c = $('chooser'); c.textContent = '';
      c.appendChild(el('div', { class: 'tasks', role: 'group', 'aria-label': 'Välj vad du vill göra' },
        chooserCard('free', 'Granska en offert', 'Gratis', 'Kontrollerade delar, det som behöver förtydligas och frågor att ta vidare.', 'Granska gratis'),
        chooserCard('compare', 'Jämför 2–4 offerter', '49 kr totalt, inkl. moms', 'Skillnader i prisjämförbarhet, omfattning och villkor sida vid sida samt individuella frågor.', 'Jämför offerter'),
        chooserCard('check', 'Förkontrollera min offert', '49 kr per offert, inkl. moms', 'Din egen offert kontrollerad före utskick, med egna bekräftelser och tillägg/PDF till kunden.', 'Förkontrollera')));
      c.appendChild(el('p', { class: 'foot' }, document.createTextNode('Ett verktyg från '), el('a', { href: 'https://stahledigital.se/verkstaden', text: 'Ståhle Digital' }), document.createTextNode(' · '),
          el('a', { href: '/foretagsuppgifter/', text: 'Företagsuppgifter' }), document.createTextNode(' · '), el('a', { href: '/jamfor/angra/', text: 'Ångra ett köp' }), document.createTextNode(' · '),
          el('a', { href: 'mailto:hej@stahledigital.se', text: 'hej@stahledigital.se' })));
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
