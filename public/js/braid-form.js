/* Braid form — shape-language toggle (desktop/web twin of Haven-Mobile's
   ThemeManager.braidForm()). Applies before first paint so there is no flash.
   Off by default; the switch lives in the theme popup. */
(function () {
  var KEY = 'braid_form';
  var root = document.documentElement;
  function on() { return localStorage.getItem(KEY) === '1'; }
  function paintOwn() {
    var id = null;
    try { id = (JSON.parse(localStorage.getItem('haven_user') || 'null') || {}).id; } catch (e) {}
    var el = document.getElementById('braid-form-own');
    if (!id) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('style'); el.id = 'braid-form-own'; document.head.appendChild(el); }
    var sel = 'html[data-braid-form="1"] .message[data-user-id="' + id + '"]>.message-row>.message-body,'
      + 'html[data-braid-form="1"] .message-compact[data-user-id="' + id + '"]>.message-body';
    el.textContent = sel + '{background:var(--braid-me);border-color:var(--braid-me-line)}'
      + sel.split(',').map(function (s) { return s + ':hover'; }).join(',')
      + '{background:color-mix(in srgb,var(--accent) 18%,var(--bg-secondary))}';
  }
  /* Run position for the merged cards. This used to be pure CSS
     (:has(+ .message-compact)), which is correct but pathological: Chromium
     re-runs :has() invalidation on every sibling insert, so loading a long
     channel went quadratic — 600 inserts measured 622ms with the form on vs
     80ms off. Marking runs here is O(n) per batch and drops the :has()
     browser requirement entirely. */
  function runOf(first, last) { return first ? (last ? 'solo' : 'start') : (last ? 'end' : 'mid'); }
  function markMessages() {
    var nodes = document.querySelectorAll('.messages > .message, .messages > .message-compact');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i], next = el.nextElementSibling;
      var isStart = el.classList.contains('message');
      var isEnd = !next || !next.classList.contains('message-compact');
      var v = runOf(isStart, isEnd);
      if (el.getAttribute('data-braid-run') !== v) el.setAttribute('data-braid-run', v);
    }
  }
  function markChannels() {
    var nodes = document.querySelectorAll('.channel-item');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i], prev = el.previousElementSibling, next = el.nextElementSibling;
      var isStart = !prev || !prev.classList.contains('channel-item');
      var isEnd = !next || !next.classList.contains('channel-item');
      var v = runOf(isStart, isEnd);
      if (el.getAttribute('data-braid-run') !== v) el.setAttribute('data-braid-run', v);
    }
  }
  var queued = false;
  function mark() {
    if (queued || !on()) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; markMessages(); markChannels(); });
  }
  var observer = null;
  function watch() {
    if (observer || !window.MutationObserver) return;
    observer = new MutationObserver(mark);
    observer.observe(document.body, { childList: true, subtree: true });
  }
  function unwatch() {
    if (!observer) return;
    observer.disconnect();
    observer = null;
  }
  function apply(state) {
    if (state) root.setAttribute('data-braid-form', '1');
    else root.removeAttribute('data-braid-form');
    paintOwn();
    if (!document.body) return;
    if (state) { mark(); watch(); } else unwatch();
  }
  window.BraidForm = {
    isOn: on,
    set: function (state) { localStorage.setItem(KEY, state ? '1' : '0'); apply(state); },
    toggle: function () { var next = !on(); window.BraidForm.set(next); return next; },
    refresh: paintOwn
  };
  apply(on());
  document.addEventListener('DOMContentLoaded', function () {
    paintOwn();
    if (on()) { mark(); watch(); }
    var btn = document.getElementById('braid-form-toggle');
    if (!btn) return;
    var sync = function () { btn.classList.toggle('active', on()); btn.setAttribute('aria-pressed', on() ? 'true' : 'false'); };
    btn.addEventListener('click', function () { window.BraidForm.toggle(); sync(); });
    sync();
  });
})();
