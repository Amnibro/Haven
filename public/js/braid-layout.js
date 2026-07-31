(function () {
  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
    else fn();
  }
  function qs(s, r) { return (r || document).querySelector(s); }
  function qsa(s, r) { return Array.from((r || document).querySelectorAll(s)); }
  function foldServersIntoSidebar() {
    const bar = document.getElementById('server-bar');
    const sidebar = qs('.sidebar');
    if (!bar || !sidebar || bar.dataset.braidFolded === '1') return;
    let strip = qs('.braid-server-strip', sidebar);
    if (!strip) {
      strip = document.createElement('div');
      strip.className = 'braid-server-strip';
      strip.id = 'braid-server-strip';
      const header = qs('.sidebar-header', sidebar);
      if (header) sidebar.insertBefore(strip, header);
      else sidebar.prepend(strip);
    }
    while (bar.firstChild) strip.appendChild(bar.firstChild);
    bar.dataset.braidFolded = '1';
    bar.setAttribute('aria-hidden', 'true');
  }
  function collapseJoinCreate() {
    try {
      if (localStorage.getItem('haven_join_collapsed') === null) localStorage.setItem('haven_join_collapsed', '1');
      if (localStorage.getItem('haven_create_collapsed') === null) localStorage.setItem('haven_create_collapsed', '1');
    } catch {}
    qsa('#join-section-body, #create-section-body').forEach((el) => el.classList.add('collapsed'));
    qsa('#join-section-arrow, #create-section-arrow').forEach((el) => el.classList.add('collapsed'));
    qsa('.sidebar-section[data-mod-id="join"], #admin-controls').forEach((s) => s.classList.add('braid-collapsed'));
  }
  function hideEdgeChrome() {
    ['desktop-app-banner', 'android-beta-banner', 'update-banner', 'status-bar', 'status-bar-toggle', 'sidebar-toggle-btn', 'soundboard-sidebar'].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.style.display = 'none';
      el.setAttribute('hidden', '');
    });
    qsa('.status-bar-toggle-tab, .sidebar-collapse-btn, .soundboard-sidebar').forEach((el) => {
      el.style.display = 'none';
      el.setAttribute('hidden', '');
    });
    const right = document.getElementById('right-sidebar');
    if (right) {
      right.classList.add('collapsed');
      right.style.display = 'none';
    }
    try {
      localStorage.setItem('haven_hide_desktop_banner', '1');
      localStorage.setItem('haven_hide_android_banner', '1');
      localStorage.setItem('haven_members_collapsed', '1');
    } catch {}
  }
  function setPeopleOpen(open) {
    document.documentElement.classList.toggle('braid-people-open', !!open);
    const right = document.getElementById('right-sidebar');
    if (!right) return;
    if (open) {
      right.classList.remove('collapsed');
      right.style.display = '';
      right.style.width = '';
      right.style.opacity = '';
      right.style.pointerEvents = '';
    } else {
      right.classList.add('collapsed');
      right.style.display = 'none';
    }
  }
  function buildMoreMenu() {
    const header = qs('.channel-header');
    if (!header || qs('.braid-more-wrap', header)) return;
    const wrap = document.createElement('div');
    wrap.className = 'braid-more-wrap';
    wrap.innerHTML =
      '<button type="button" class="braid-more-btn" id="braid-more-btn" title="More" aria-label="More">' +
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">' +
      '<circle cx="12" cy="5" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="12" cy="19" r="1.2"/></svg></button>' +
      '<div class="braid-more-menu" id="braid-more-menu" role="menu"></div>';
    const voice = qs('.voice-controls', header);
    if (voice) header.insertBefore(wrap, voice);
    else header.appendChild(wrap);
    const menu = qs('#braid-more-menu', wrap);
    const btn = qs('#braid-more-btn', wrap);
    const addItem = (label, onClick, muted) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = muted ? `${label} <span class="muted">${muted}</span>` : label;
      b.addEventListener('click', () => { menu.classList.remove('open'); onClick(); });
      menu.appendChild(b);
    };
    addItem('People & voice', () => setPeopleOpen(!document.documentElement.classList.contains('braid-people-open')), 'right panel');
    [
      { id: 'search-toggle-btn', label: 'Search messages' },
      { id: 'pinned-toggle-btn', label: 'Pinned messages' },
      { id: 'gallery-toggle-btn', label: 'Files & media' },
      { id: 'copy-code-btn', label: 'Copy channel code' },
      { id: 'channel-code-settings-btn', label: 'Channel code settings' },
      { id: 'e2e-menu-btn', label: 'Encryption' },
    ].forEach((it) => {
      const src = document.getElementById(it.id);
      if (!src) return;
      addItem(it.label, () => src.click());
    });
    addItem('Apps & downloads', () => openAppsDrawer(), 'desktop · android');
    addItem('Settings', () => {
      document.getElementById('open-settings-btn')?.click();
      document.getElementById('mobile-settings-btn')?.click();
    });
    const peopleHdr = document.getElementById('mobile-users-btn');
    if (peopleHdr) {
      peopleHdr.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        setPeopleOpen(!document.documentElement.classList.contains('braid-people-open'));
      }, true);
    }
    const sideMembers = document.getElementById('sidebar-members-btn');
    if (sideMembers) {
      sideMembers.style.display = '';
      sideMembers.addEventListener('click', (e) => {
        e.preventDefault();
        setPeopleOpen(!document.documentElement.classList.contains('braid-people-open'));
      });
    }
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.classList.toggle('open');
    });
    document.addEventListener('click', (e) => {
      if (!wrap.contains(e.target)) menu.classList.remove('open');
    });
  }
  function openAppsDrawer() {
    let drawer = document.getElementById('braid-apps-drawer');
    if (!drawer) {
      drawer = document.createElement('div');
      drawer.id = 'braid-apps-drawer';
      drawer.innerHTML =
        '<div class="sheet" role="dialog" aria-label="Apps">' +
        '<h3>Apps & extras</h3>' +
        '<p class="sub">Parked here so the chat chrome stays on two edges only.</p>' +
        '<div class="grid">' +
        '<button type="button" class="tile" data-act="desktop"><b>Desktop app</b><span>Native client</span></button>' +
        '<button type="button" class="tile" data-act="android"><b>Android app</b><span>Mobile client</span></button>' +
        '<button type="button" class="tile" data-act="theme"><b>Theme</b><span>Colors & effects</span></button>' +
        '<button type="button" class="tile" data-act="people"><b>People</b><span>Members & voice</span></button>' +
        '</div><div class="close-row"><button type="button" class="btn-sm" id="braid-apps-close">Close</button></div></div>';
      document.body.appendChild(drawer);
      drawer.addEventListener('click', (e) => { if (e.target === drawer) drawer.classList.remove('open'); });
      drawer.querySelector('#braid-apps-close')?.addEventListener('click', () => drawer.classList.remove('open'));
      drawer.querySelectorAll('.tile').forEach((t) => {
        t.addEventListener('click', () => {
          const act = t.getAttribute('data-act');
          drawer.classList.remove('open');
          if (act === 'desktop') window.open('https://ancsemi.github.io/Haven/#download', '_blank', 'noopener');
          else if (act === 'android') document.getElementById('android-beta-banner')?.click();
          else if (act === 'theme') document.getElementById('theme-popup-toggle')?.click();
          else if (act === 'people') setPeopleOpen(true);
        });
      });
    }
    drawer.classList.add('open');
  }
  function quietChips() {
    const vc = qs('.voice-controls');
    if (!vc) return;
    qsa('button, .pill, .chip, span, div', vc).forEach((el) => {
      const t = (el.textContent || '').toLowerCase();
      if (t.includes('get the desktop') || t.includes('android app')) {
        el.style.display = 'none';
      }
    });
  }
  function boot() {
    document.documentElement.setAttribute('data-braid-layout', '1');
    foldServersIntoSidebar();
    collapseJoinCreate();
    hideEdgeChrome();
    setPeopleOpen(false);
    buildMoreMenu();
    quietChips();
    const obs = new MutationObserver(() => {
      hideEdgeChrome();
      quietChips();
      foldServersIntoSidebar();
      if (!document.documentElement.classList.contains('braid-people-open')) {
        const right = document.getElementById('right-sidebar');
        if (right && !right.classList.contains('collapsed')) {
          right.classList.add('collapsed');
          right.style.display = 'none';
        }
      }
    });
    const body = document.getElementById('app-body') || document.body;
    obs.observe(body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
  }
  ready(boot);
})();
