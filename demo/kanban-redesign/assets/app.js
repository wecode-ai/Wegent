// Overlay manager for the kanban-redesign demo.
// Open via [data-open="<id>"], close via [data-close], ESC key, or backdrop click.
// URL hashes (#detail / #new-task / #start-task / #members / #new-project) auto-open
// the matching overlay on load, which also enables direct screenshot checks.
(function () {
  'use strict';

  function overlayFor(id) {
    return document.getElementById('overlay-' + id);
  }

  function open(id) {
    var el = overlayFor(id);
    if (el) el.classList.add('open');
  }

  function close(el) {
    el.classList.remove('open');
  }

  function closeTopmost() {
    var openOverlays = document.querySelectorAll('.overlay.open');
    if (openOverlays.length) close(openOverlays[openOverlays.length - 1]);
  }

  document.addEventListener('click', function (e) {
    var opener = e.target.closest('[data-open]');
    if (opener) {
      open(opener.getAttribute('data-open'));
      return;
    }
    var closer = e.target.closest('[data-close]');
    if (closer) {
      var host = closer.closest('.overlay');
      if (host) close(host);
      return;
    }
    // Backdrop click closes the overlay.
    if (e.target.classList && e.target.classList.contains('overlay')) {
      close(e.target);
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeTopmost();
  });

  function openFromHash() {
    var id = location.hash.replace(/^#/, '');
    if (id && overlayFor(id)) open(id);
  }

  window.addEventListener('hashchange', openFromHash);
  openFromHash();
})();
