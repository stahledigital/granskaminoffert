/* FAQ only: no third-party connection until an explicit video choice. */
(function () {
  'use strict';
  document.querySelectorAll('[data-faq-video]').forEach(function (question) {
    var button = question.querySelector('.faq-play');
    var stage = question.querySelector('.faq-video-stage');
    var id = question.getAttribute('data-faq-video');
    if (!button || !stage || !/^[A-Za-z0-9_-]{11}$/.test(id)) return;
    var preview = Array.from(stage.childNodes);
    button.hidden = false;
    button.addEventListener('click', function () {
      if (stage.querySelector('iframe')) return;
      var frame = document.createElement('iframe');
      frame.src = 'https://www.youtube-nocookie.com/embed/' + id + '?rel=0';
      frame.title = button.getAttribute('aria-label').replace('Visa filmen: ', 'Instruktionsfilm: ');
      // YouTube requires the embedding origin; omit the page path and query string.
      frame.referrerPolicy = 'strict-origin-when-cross-origin';
      frame.allow = 'encrypted-media; picture-in-picture; fullscreen';
      frame.allowFullscreen = true;
      frame.tabIndex = 0;
      stage.replaceChildren(frame);
      frame.focus();
    });
    question.addEventListener('toggle', function () {
      // Remove the playing document so a collapsed answer cannot keep sounding.
      if (!question.open && stage.querySelector('iframe')) stage.replaceChildren.apply(stage, preview);
    });
  });
  function openLinkedQuestion() {
    var id;
    try { id = decodeURIComponent(location.hash.slice(1)); } catch (_) { return; }
    if (!id) return;
    var target = document.getElementById(id);
    if (target && target.matches('details.faq-question')) {
      target.open = true;
      target.scrollIntoView({ block: 'start' });
    }
  }
  addEventListener('hashchange', openLinkedQuestion);
  openLinkedQuestion();
})();
