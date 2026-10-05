/**
 * @name Chrome Layout
 * @description Compacted sidebar chrome: moves channel creation to a header + menu, docks direct messages and people into the footer, places voice controls on each channel row, and provides a quick settings menu on the home server icon.
 * @author Amnibro
 * @version 1.0.0
 */
class ChromeLayout {
  constructor() {
    this._started = false;
    this._stopping = false;
    this._transitioning = false;
    this._engaged = false;
    this._blocked = false;
    this._suspended = false;
    this._permListeners = [];
    this._listeners = [];
    this._injectedElements = new Set();
    this._modifiedClasses = new Map();
  }

  start() {
    if (this._started) return;
    this._started = true;
    this._stopping = false;
    this._transitioning = false;
    this._engaged = false;
    this._blocked = false;
    this._suspended = typeof document !== 'undefined'
      && Boolean(document.documentElement?.hasAttribute?.('data-haven-layout-editing'));

    try {
      // Shortcut Ctrl+Alt+S (and Ctrl+Shift+S) to toggle layout
      const kd = (e) => {
        if (e.ctrlKey && (e.altKey || e.shiftKey) && (e.key === 'S' || e.key === 's')) {
          e.preventDefault();
          this._toggle();
        }
      };
      this._listenPerm(document, 'keydown', kd, true);

      // Mod Mode layout editing hooks
      this._listenPerm(document, 'haven:layout-editing', (event) => {
        if (this._stopping) return;
        const active = event.detail?.active === true;
        if (active) {
          if (this._engaged && !this._suspended) this._suspend();
          return;
        }
        if (this._getSavedLayoutOn() === '0') return;
        if (event.detail?.owner && event.detail.owner !== 'ChromeLayout') return;
        if (this._engaged) this._resume();
        else this._engage(false);
      });

      // Layout owner transitions
      this._listenPerm(document, 'haven:layout-owner-change', (event) => {
        if (event.detail?.owner) {
          if (event.detail.owner !== 'ChromeLayout' && this._engaged) {
            this._disengage(false);
          }
          return;
        }
        if (this._stopping || this._transitioning
            || document.documentElement?.hasAttribute?.('data-haven-layout-editing')) return;
        if (this._getSavedLayoutOn() === '0') return;
        if (this._engaged && this._suspended) this._resume();
        else if (!this._engaged) this._engage(false);
      });

      const layoutOn = this._getSavedLayoutOn() !== '0';
      if (layoutOn && !this._suspended) {
        this._engage(false);
      }
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  stop() {
    if (!this._started) return;
    this._started = false;
    this._stopping = true;
    try {
      this._disengage(false);
    } finally {
      for (const [target, type, fn, opts] of this._permListeners || []) {
        target.removeEventListener?.(type, fn, opts);
      }
      this._permListeners = [];
      this._stopping = false;
    }
  }

  _toggle() {
    this._engaged ? this._disengage() : this._engage();
  }

  _getSavedLayoutOn() {
    try {
      const api = typeof HavenApi !== 'undefined' ? HavenApi.Data : window.HavenApi?.Data;
      return api?.load('ChromeLayout', 'layoutOn', '1') ?? '1';
    } catch {
      return '1';
    }
  }

  _saveLayoutOn(value) {
    const api = typeof HavenApi !== 'undefined' ? HavenApi.Data : window.HavenApi?.Data;
    api?.save('ChromeLayout', 'layoutOn', value);
  }

  _engage(persist = true) {
    if (this._engaged) return;
    if (typeof document !== 'undefined' && document.documentElement?.hasAttribute?.('data-haven-layout-editing')) return;

    const layoutApi = typeof HavenApi !== 'undefined' ? HavenApi.Layout : window.HavenApi?.Layout;
    if (layoutApi && !layoutApi.acquire('ChromeLayout')) {
      this._blocked = true;
      return;
    }

    this._blocked = false;
    this._engaged = true;
    this._suspended = false;
    this._transitioning = true;

    try {
      if (persist) this._saveLayoutOn('1');
      if (typeof document !== 'undefined') {
        document.documentElement?.setAttribute('data-chrome-layout', '1');
      }

      const domApi = typeof HavenApi !== 'undefined' ? HavenApi.DOM : window.HavenApi?.DOM;
      domApi?.addStyle('ChromeLayout', ChromeLayout.CSS);

      this._applyChrome();
      this._startObserver();
      this._dispatch('haven:chrome-layout', { on: true });
    } catch (error) {
      this._engaged = false;
      try {
        this._restoreChrome();
      } finally {
        if (typeof document !== 'undefined') {
          document.documentElement?.removeAttribute('data-chrome-layout');
        }
        const domApi = typeof HavenApi !== 'undefined' ? HavenApi.DOM : window.HavenApi?.DOM;
        domApi?.removeStyle('ChromeLayout');
        const layoutApi = typeof HavenApi !== 'undefined' ? HavenApi.Layout : window.HavenApi?.Layout;
        layoutApi?.release('ChromeLayout');
      }
      throw error;
    } finally {
      this._transitioning = false;
    }
  }

  _disengage(persist = true) {
    if (!this._engaged) return;
    this._engaged = false;
    this._transitioning = true;

    try {
      this._stopObserver();
      this._restoreChrome();

      if (typeof document !== 'undefined') {
        document.documentElement?.removeAttribute('data-chrome-layout');
        document.documentElement?.classList.remove('dms-open');
        document.querySelector('.sidebar')?.classList.remove('dms-open');
      }

      const domApi = typeof HavenApi !== 'undefined' ? HavenApi.DOM : window.HavenApi?.DOM;
      domApi?.removeStyle('ChromeLayout');

      if (persist) {
        try {
          this._saveLayoutOn('0');
        } catch (err) {
          // The layout is already off on screen; only the saved choice is lost.
          console.warn('[ChromeLayout] could not save the layout choice', err);
        }
      }

      const layoutApi = typeof HavenApi !== 'undefined' ? HavenApi.Layout : window.HavenApi?.Layout;
      layoutApi?.release('ChromeLayout');

      this._blocked = Boolean(
        layoutApi?.owner && layoutApi.owner !== 'ChromeLayout'
      );
      this._dispatch('haven:chrome-layout', { on: false });
    } finally {
      this._transitioning = false;
    }
  }

  _suspend() {
    if (!this._engaged || this._suspended) return;
    this._suspended = true;
    this._transitioning = true;

    try {
      this._stopObserver();
      this._restoreChrome();

      if (typeof document !== 'undefined') {
        document.documentElement?.removeAttribute('data-chrome-layout');
        document.documentElement?.classList.remove('dms-open');
        document.querySelector('.sidebar')?.classList.remove('dms-open');
      }

      const domApi = typeof HavenApi !== 'undefined' ? HavenApi.DOM : window.HavenApi?.DOM;
      domApi?.removeStyle('ChromeLayout');

      const layoutApi = typeof HavenApi !== 'undefined' ? HavenApi.Layout : window.HavenApi?.Layout;
      layoutApi?.release('ChromeLayout');
    } finally {
      this._transitioning = false;
    }
  }

  _resume() {
    if (!this._engaged || !this._suspended) return;
    if (typeof document !== 'undefined' && document.documentElement?.hasAttribute?.('data-haven-layout-editing')) return;

    const layoutApi = typeof HavenApi !== 'undefined' ? HavenApi.Layout : window.HavenApi?.Layout;
    if (layoutApi && !layoutApi.acquire('ChromeLayout')) {
      this._blocked = true;
      return;
    }

    this._blocked = false;
    this._suspended = false;
    this._transitioning = true;

    try {
      if (typeof document !== 'undefined') {
        document.documentElement?.setAttribute('data-chrome-layout', '1');
      }
      const domApi = typeof HavenApi !== 'undefined' ? HavenApi.DOM : window.HavenApi?.DOM;
      domApi?.addStyle('ChromeLayout', ChromeLayout.CSS);

      this._applyChrome();
      this._startObserver();
    } finally {
      this._transitioning = false;
    }
  }

  _listenPerm(target, type, fn, opts) {
    if (!target?.addEventListener) return;
    target.addEventListener(type, fn, opts);
    this._permListeners.push([target, type, fn, opts]);
  }

  _listen(target, type, fn, opts) {
    if (!target?.addEventListener) return;
    target.addEventListener(type, fn, opts);
    this._listeners.push([target, type, fn, opts]);
  }

  _dispatch(type, detail) {
    if (typeof document === 'undefined') return;
    const event = typeof CustomEvent === 'function'
      ? new CustomEvent(type, { detail })
      : { type, detail };
    document.dispatchEvent(event);
  }

  // ── DOM Transformations ─────────────────────────────────

  _applyChrome() {
    if (typeof document === 'undefined') return;

    this._setupChannelHeader();
    this._setupBottomDock();
    this._setupHomeServerMenu();
    this._setupChannelVoiceButtons();
    this._setupThreadMentionsBadge();
  }

  _restoreChrome() {
    for (const [target, type, fn, opts] of this._listeners || []) {
      target.removeEventListener?.(type, fn, opts);
    }
    this._listeners = [];

    // Remove classes added
    if (this._modifiedClasses) {
      for (const [el, classes] of this._modifiedClasses.entries()) {
        if (el?.classList) {
          for (const cls of classes) el.classList.remove(cls);
        }
      }
      this._modifiedClasses.clear();
    }

    // Put Haven's DM badge back before the dock button holding it goes away
    this._returnDmBadge();

    // Remove injected elements
    if (this._injectedElements) {
      for (const el of this._injectedElements) {
        el.remove?.();
      }
      this._injectedElements.clear();
    }

    // Clean up channel row voice buttons
    if (typeof document !== 'undefined') {
      document.querySelectorAll?.('.channel-join-voice')?.forEach(el => el.remove?.());
      const home = document.getElementById('home-server');
      if (home) delete home.dataset.homeMenuBound;
    }
  }

  _addClass(el, cls) {
    if (!el?.classList) return;
    el.classList.add(cls);
    if (!this._modifiedClasses.has(el)) this._modifiedClasses.set(el, new Set());
    this._modifiedClasses.get(el).add(cls);
  }

  _createInjected(tag, id, className, html = '') {
    const el = document.createElement(tag);
    if (id) el.id = id;
    if (className) el.className = className;
    if (html) el.innerHTML = html;
    this._injectedElements.add(el);
    return el;
  }

  // 1. Channel Header: + Button and Sheet Menu
  _setupChannelHeader() {
    const channelsToggle = document.getElementById('channels-toggle')
      || document.querySelector('[data-haven-region="channels"] h5')
      || document.querySelector('.channels-toggle');
    if (!channelsToggle) return;

    // Subtle styling on utility buttons
    const subBtn = document.getElementById('sub-channel-panel-btn');
    const orgBtn = document.getElementById('organize-channels-btn');
    if (subBtn) this._addClass(subBtn, 'channel-header-util');
    if (orgBtn) this._addClass(orgBtn, 'channel-header-util');

    // Add prominent + button if not already present
    let addBtn = document.getElementById('channel-actions-btn');
    if (!addBtn) {
      addBtn = this._createInjected('button', 'channel-actions-btn', 'icon-btn small channel-actions-add-btn chrome-chip', `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true">
          <path d="M12 5v14M5 12h14"/>
        </svg>
      `);
      addBtn.type = 'button';
      addBtn.title = 'Join or create a channel';
      addBtn.setAttribute('aria-haspopup', 'menu');
      addBtn.setAttribute('aria-expanded', 'false');
      addBtn.style.position = 'relative';
      addBtn.style.zIndex = '2';
      channelsToggle.appendChild(addBtn);
    }

    // Add sheet menu
    let menu = document.getElementById('channel-actions-menu');
    if (!menu) {
      menu = this._createInjected('span', 'channel-actions-menu', 'channel-actions-menu', `
        <button type="button" role="menuitem" data-action="join">Join channel</button>
        <button type="button" role="menuitem" data-action="create">Create channel</button>
        <button type="button" role="menuitem" data-action="temp">Temporary channel</button>
      `);
      menu.hidden = true;
      menu.setAttribute('role', 'menu');
      channelsToggle.appendChild(menu);
    }

    // Bind + button toggle
    const toggleMenu = (e) => {
      e?.stopPropagation?.();
      const willOpen = menu.hidden;
      this._setChannelActionsMenu(!willOpen);
    };
    this._listen(addBtn, 'click', toggleMenu);

    // Refresh permissions on actions
    const app = typeof window !== 'undefined' ? window.app : null;
    const canCreate = !!(app?.user?.isAdmin || app?._hasGlobalPerm?.('create_channel'));
    const canCreateTemp = !!(app?.user?.isAdmin || app?._hasPerm?.('create_temp_channel') || canCreate);

    const createItem = menu.querySelector?.('[data-action="create"]');
    if (createItem) {
      createItem.classList.toggle('is-disabled', !canCreate);
      createItem.setAttribute('aria-disabled', canCreate ? 'false' : 'true');
    }
    const tempItem = menu.querySelector?.('[data-action="temp"]');
    if (tempItem) {
      tempItem.classList.toggle('is-disabled', !canCreateTemp);
      tempItem.setAttribute('aria-disabled', canCreateTemp ? 'false' : 'true');
    }

    // Handle menu item selection
    const onMenuClick = (e) => {
      e.stopPropagation();
      const item = e.target.closest?.('[data-action]');
      if (!item || item.classList.contains('is-disabled')) return;
      const action = item.dataset.action;
      this._setChannelActionsMenu(false);
      this._handleChannelAction(action, canCreate);
    };
    this._listen(menu, 'click', onMenuClick);

    // Outside click & Escape to dismiss
    this._listen(document, 'pointerdown', (e) => {
      if (!menu.hidden && !menu.contains(e.target) && !addBtn.contains(e.target)) {
        this._setChannelActionsMenu(false);
      }
    }, true);
    this._listen(document, 'keydown', (e) => {
      if (e.key === 'Escape' && !menu.hidden) {
        this._setChannelActionsMenu(false);
      }
    });
  }

  _setChannelActionsMenu(open) {
    const menu = document.getElementById('channel-actions-menu');
    const btn = document.getElementById('channel-actions-btn');
    if (menu) menu.hidden = !open;
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  // Opens a collapsed Join or Create section through Haven's own header
  // toggle, so the layout leaves no inline styles behind and Haven remembers
  // the section as open the same way it does for a click.
  _expandSection(name) {
    const body = document.getElementById(`${name}-section-body`);
    if (body?.classList?.contains('collapsed')) {
      document.getElementById(`${name}-section-toggle`)?.click?.();
    }
  }

  _handleChannelAction(action, canCreate) {
    const app = typeof window !== 'undefined' ? window.app : null;
    if (action === 'join') {
      this._expandSection('join');
      document.getElementById('channel-code-input')?.focus();
      return;
    }
    if (action === 'temp' && !canCreate) {
      // Without create_channel Haven hides the create form, so ask for a name.
      app?._showPromptModal?.('Temporary Channel', 'Enter a name for the auto-expiring channel:').then((name) => {
        if (name?.trim() && app.socket) {
          app.socket.emit('create-temp-channel', { name: name.trim() });
        }
      });
      return;
    }
    if (action !== 'create' && action !== 'temp') return;
    // Haven itself shows the create form to everyone who may create channels.
    this._expandSection('create');
    const tmp = document.getElementById('new-channel-temporary');
    if (tmp) {
      tmp.checked = action === 'temp';
      tmp.dispatchEvent?.(new Event('change'));
    }
    document.getElementById('new-channel-name')?.focus();
  }

  // 2. Footer Dock: People & Direct Messages
  _setupBottomDock() {
    const bottomBar = document.querySelector('.sidebar-bottom-bar')
      || document.querySelector('[data-haven-region="sidebar-actions"]');
    if (!bottomBar) return;

    let peopleBtn = document.getElementById('people-dock-btn');
    if (!peopleBtn) {
      peopleBtn = this._createInjected('button', 'people-dock-btn', 'sidebar-bottom-btn chrome-chip', `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
          <circle cx="9" cy="7" r="4"/>
          <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
          <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
        </svg>
      `);
      peopleBtn.type = 'button';
      peopleBtn.title = 'People';
      peopleBtn.setAttribute('aria-pressed', 'false');
      bottomBar.prepend(peopleBtn);
    }

    let dmBtn = document.getElementById('dm-dock-btn');
    if (!dmBtn) {
      dmBtn = this._createInjected('button', 'dm-dock-btn', 'sidebar-bottom-btn chrome-chip', `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M21 15a3.2 3.2 0 0 1-3.2 3.2H8.4L4 21.5V6.2A3.2 3.2 0 0 1 7.2 3h10.6A3.2 3.2 0 0 1 21 6.2Z"/>
        </svg>
      `);
      dmBtn.type = 'button';
      dmBtn.title = 'Direct messages';
      dmBtn.setAttribute('aria-pressed', 'false');
      bottomBar.insertBefore(dmBtn, peopleBtn.nextSibling);
    }
    this._adoptDmBadge(dmBtn);

    // Toggle the People panel with Haven's own panel toggle, which also
    // remembers the choice, and keep the dock button's pressed state in step
    // however the panel is toggled.
    const panelToggle = document.getElementById('sidebar-toggle-btn');
    const syncPeoplePressed = () => {
      const right = document.getElementById('right-sidebar');
      const open = Boolean(right && !right.classList.contains('collapsed'));
      peopleBtn.setAttribute('aria-pressed', open ? 'true' : 'false');
    };
    syncPeoplePressed();
    this._listen(panelToggle, 'click', syncPeoplePressed);
    this._listen(peopleBtn, 'click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      panelToggle?.click?.();
    });

    // Toggle DM pane drawer
    this._listen(dmBtn, 'click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._toggleDmDock();
    });

    // Outside click & Escape to close DM dock
    this._listen(document, 'pointerdown', (e) => {
      if (document.documentElement.classList.contains('dms-open')) {
        if (!e.target.closest('#dm-pane, #dm-dock-btn, #people-dock-btn')) {
          this._setDmDockOpen(false);
        }
      }
    }, true);
    this._listen(document, 'keydown', (e) => {
      if (e.key === 'Escape' && document.documentElement.classList.contains('dms-open')) {
        this._setDmDockOpen(false);
      }
    });

    // In the drawer, clicking the DM header closes the drawer. It is caught
    // on the way down so Haven's own handler does not also collapse the DM
    // list and save that, which would leave the list collapsed in Original.
    this._listen(document, 'click', (e) => {
      const dmHeader = document.getElementById('dm-toggle-header');
      if (!dmHeader?.contains(e.target) || e.target?.closest?.('button')) return;
      e.stopPropagation();
      this._setDmDockOpen(false);
    }, true);
  }

  _toggleDmDock() {
    const isOpen = document.documentElement.classList.contains('dms-open');
    this._setDmDockOpen(!isOpen);
  }

  _setDmDockOpen(open) {
    if (typeof document === 'undefined') return;
    document.documentElement.classList.toggle('dms-open', !!open);
    const sidebar = document.querySelector('.sidebar');
    sidebar?.classList.toggle('dms-open', !!open);
    const btn = document.getElementById('dm-dock-btn');
    if (btn) btn.setAttribute('aria-pressed', open ? 'true' : 'false');
  }

  // Haven keeps its DM unread badge up to date by id, and that badge sits in
  // the DM header, which is hidden while the drawer is closed. Moving the one
  // real badge onto the dock button (and back on disengage) keeps it live
  // without a second element carrying the same id.
  _adoptDmBadge(dmBtn) {
    const badge = document.getElementById('dm-unread-badge');
    if (!badge || !dmBtn || badge.parentNode === dmBtn) return;
    if (!this._dmBadgeHome) {
      this._dmBadgeHome = { parent: badge.parentNode, next: badge.nextSibling };
    }
    dmBtn.appendChild(badge);
  }

  _returnDmBadge() {
    const home = this._dmBadgeHome;
    this._dmBadgeHome = null;
    const badge = typeof document !== 'undefined' ? document.getElementById('dm-unread-badge') : null;
    if (!home?.parent || !badge) return;
    const next = home.next?.parentNode === home.parent ? home.next : null;
    home.parent.insertBefore(badge, next);
  }

  // 3. Home Server Menu
  _setupHomeServerMenu() {
    const homeBtn = document.getElementById('home-server');
    if (!homeBtn || homeBtn.dataset.homeMenuBound === '1') return;
    homeBtn.dataset.homeMenuBound = '1';

    let menu = document.getElementById('home-server-menu');
    if (!menu) {
      menu = this._createInjected('div', 'home-server-menu', 'home-server-menu', `
        <button type="button" data-home-action="add-server">➕ Add Server</button>
        <button type="button" data-home-action="manage-servers">⚙️ Manage Servers</button>
        <button type="button" data-home-action="sync-servers">🔄 Sync Servers</button>
        <button type="button" data-home-action="server-settings">🛠️ Server Settings</button>
        <button type="button" data-home-action="app-settings">🔧 App Settings</button>
      `);
      menu.hidden = true;
      document.body.appendChild(menu);
    }

    const place = () => {
      const r = homeBtn.getBoundingClientRect?.() || { left: 0, bottom: 40 };
      menu.style.left = `${Math.max(8, Math.min(r.left, (window.innerWidth || 1200) - 200))}px`;
      menu.style.top = `${r.bottom + 6}px`;
    };

    const toggle = (e) => {
      e?.preventDefault?.();
      e?.stopPropagation?.();
      menu.hidden = !menu.hidden;
      homeBtn.setAttribute('aria-expanded', (!menu.hidden).toString());
      if (!menu.hidden) {
        const app = typeof window !== 'undefined' ? window.app : null;
        const serverItem = menu.querySelector?.('[data-home-action="server-settings"]');
        if (serverItem) serverItem.hidden = !app?._hasAnyAdminSettingsAccess?.();
        place();
      }
    };
    this._listen(homeBtn, 'click', toggle);

    this._listen(menu, 'click', (e) => {
      const item = e.target.closest?.('[data-home-action]');
      if (!item) return;
      menu.hidden = true;
      homeBtn.setAttribute('aria-expanded', 'false');
      const action = item.dataset.homeAction;
      const app = typeof window !== 'undefined' ? window.app : null;
      if (action === 'add-server') document.getElementById('add-server-btn')?.click();
      else if (action === 'manage-servers') document.getElementById('manage-servers-btn')?.click();
      else if (action === 'sync-servers') document.getElementById('sync-servers-btn')?.click();
      else if (action === 'server-settings' || action === 'app-settings') {
        // Open Settings through Haven's own button (it always opens on the
        // User tab), then switch tabs for Server Settings.
        document.getElementById('open-settings-btn')?.click();
        if (action === 'server-settings') app?._switchSettingsTab?.('admin');
      }
    });

    this._listen(document, 'click', (e) => {
      if (!menu.hidden && !menu.contains(e.target) && !homeBtn.contains(e.target)) {
        menu.hidden = true;
        homeBtn.setAttribute('aria-expanded', 'false');
      }
    });
    this._listen(window, 'resize', () => { if (!menu.hidden) place(); });
  }

  // 4. Channel Rows: Join/Leave Voice Button
  _setupChannelVoiceButtons() {
    if (typeof document === 'undefined') return;
    const app = typeof window !== 'undefined' ? window.app : null;
    const canUseVoice = !!(app?.user?.isAdmin || app?.user?.isGuest || app?._hasPerm?.('use_voice') || !app?.user);
    const inVoice = !!(app?.voice && app.voice.inVoice);
    const currentChannel = app?.voice?.currentChannel;

    const channelRows = document.querySelectorAll?.('#channel-list .channel-item');
    if (!channelRows?.length) return;

    channelRows.forEach((row) => {
      // Core tags each channel row with data-code.
      const code = row.dataset?.code;
      if (!code) return;
      const ch = app?.channels?.find?.(c => c.code === code);
      if (ch?.is_dm || ch?.voice_enabled === 0 || !canUseVoice) return;

      let btn = row.querySelector?.('.channel-join-voice');
      const inThisVoice = inVoice && currentChannel === code;

      if (!btn) {
        btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'channel-join-voice';
        btn.dataset.joinVoice = code;
        this._renderVoiceButton(btn, inThisVoice);

        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (app?.voice?.inVoice && app.voice.currentChannel === code) {
            if (app._leaveVoice) app._leaveVoice();
            else if (app.voice.leaveVoice) app.voice.leaveVoice();
          } else if (app?.switchChannel && app._joinVoice) {
            // Core's _joinVoice joins the channel being viewed, so open this
            // row's channel first, the same way double-clicking a row does.
            app.switchChannel(code);
            setTimeout(() => app._joinVoice(), 300);
          }
        });

        const moreBtn = row.querySelector?.('.channel-more-btn');
        if (moreBtn) row.insertBefore(btn, moreBtn);
        else row.appendChild(btn);
      } else {
        this._renderVoiceButton(btn, inThisVoice);
      }
    });
  }

  // Writes the button only when its state flips. Rewriting innerHTML on every
  // pass is itself a mutation inside #channel-list, which retriggered the
  // observer and redrew the buttons on every animation frame.
  _renderVoiceButton(btn, inThisVoice) {
    const state = inThisVoice ? 'leave' : 'join';
    if (btn.dataset.voiceState === state) return;
    btn.dataset.voiceState = state;
    btn.classList.toggle('is-live', inThisVoice);
    btn.classList.toggle('is-leave', inThisVoice);
    btn.innerHTML = inThisVoice ? ChromeLayout._LEAVE_SVG : '🎤';
    btn.title = inThisVoice ? 'Disconnect Voice' : 'Join Voice';
    btn.setAttribute('aria-label', btn.title);
  }

  // 5. Thread Mentions Badge
  _setupThreadMentionsBadge() {
    const threadBtn = document.getElementById('threads-toggle-btn');
    if (!threadBtn) return;
    this._addClass(threadBtn, 'header-icon-with-badge');
    let badge = document.getElementById('threads-toggle-badge');
    if (!badge) {
      badge = this._createInjected('span', 'threads-toggle-badge', 'header-icon-badge');
      badge.hidden = true;
      threadBtn.appendChild(badge);
    }
  }

  // ── Observer for dynamic updates ─────────────────────────
  _startObserver() {
    if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return;
    this._stopObserver();
    let scheduled = false;
    this._obs = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        if (!this._engaged || this._suspended) return;
        this._setupChannelVoiceButtons();
      });
    });
    const target = document.getElementById('channel-list') || document.body;
    if (target?.nodeType) {
      this._obs.observe(target, { childList: true, subtree: true });
    }
  }

  _stopObserver() {
    if (this._obs) {
      this._obs.disconnect();
      this._obs = null;
    }
  }
}

ChromeLayout._LEAVE_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';

ChromeLayout.CSS = `
/* ── Chrome Layout Plugin CSS ────────────────────────────── */

/* Category group dividers */
html[data-chrome-layout="1"] .category-label {
  border-top: 1px solid var(--border);
  margin-top: 0.625rem;
  padding-top: 0.5rem;
}
html[data-chrome-layout="1"] .category-label:first-child {
  border-top: none;
  margin-top: 0;
  padding-top: 0;
}

/* Primary + Button in channel header */
html[data-chrome-layout="1"] .channels-toggle {
  overflow: visible;
}
html[data-chrome-layout="1"] .channels-toggle .channel-actions-add-btn {
  width: 1.875rem;
  height: 1.875rem;
  border-radius: var(--radius-sm, 6px);
  background: var(--bg-modifier-selected, rgba(255, 255, 255, 0.08));
  border: 1px solid var(--border);
  color: var(--text-primary);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease, transform 0.1s ease;
}
html[data-chrome-layout="1"] .channels-toggle .channel-actions-add-btn:hover {
  background: var(--bg-hover);
  color: var(--accent);
  border-color: var(--accent);
}

/* Subtle utility buttons */
html[data-chrome-layout="1"] .channels-toggle .channel-header-util {
  width: 1.5rem;
  height: 1.5rem;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-sm, 6px);
  color: var(--text-muted);
  opacity: 0.65;
  cursor: pointer;
  transition: opacity 0.15s ease, background 0.15s ease, color 0.15s ease;
}
html[data-chrome-layout="1"] .channels-toggle .channel-header-util:hover {
  opacity: 1;
  color: var(--text-primary);
  background: var(--bg-modifier-hover, rgba(255, 255, 255, 0.05));
}

/* Channel Action Sheet Menu */
html[data-chrome-layout="1"] .channel-actions-menu {
  position: absolute;
  right: 0;
  top: calc(100% + 0.25rem);
  z-index: 32;
  min-width: 11.5rem;
  padding: 0.25rem;
  background: var(--bg-card, var(--bg-secondary));
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
}
html[data-chrome-layout="1"] .channel-actions-menu button {
  display: block;
  width: 100%;
  text-align: left;
  background: transparent;
  border: 0;
  border-radius: 0.375rem;
  color: var(--text-primary);
  cursor: pointer;
  font: inherit;
  font-size: 0.8125rem;
  padding: 0.4rem 0.55rem;
}
html[data-chrome-layout="1"] .channel-actions-menu button:hover {
  background: var(--bg-hover);
}
html[data-chrome-layout="1"] .channel-actions-menu button.is-disabled {
  opacity: 0.45;
  color: var(--text-muted);
  cursor: not-allowed;
}
html[data-chrome-layout="1"] .channel-actions-menu button.is-disabled:hover {
  background: transparent;
}

/* Chrome chips & Footer dock */
html[data-chrome-layout="1"] .chrome-chip {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.125rem;
  height: 2.125rem;
  padding: 0;
  box-sizing: border-box;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  color: var(--text-secondary);
  opacity: 1;
  line-height: 1;
  overflow: visible;
}
html[data-chrome-layout="1"] .chrome-chip:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
  border-color: var(--accent);
}
html[data-chrome-layout="1"] #people-dock-btn,
html[data-chrome-layout="1"] #dm-dock-btn {
  position: relative;
  width: 2.125rem;
  height: 2.125rem;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  overflow: visible;
}
html[data-chrome-layout="1"] #people-dock-btn[aria-pressed="true"],
html[data-chrome-layout="1"] #dm-dock-btn[aria-pressed="true"],
html[data-chrome-layout="1"].dms-open #dm-dock-btn,
html[data-chrome-layout="1"] .sidebar.dms-open #dm-dock-btn {
  background: var(--bg-active, var(--bg-hover));
  color: var(--text-primary);
  border-color: var(--accent);
}

/* DM unread badge */
html[data-chrome-layout="1"] #dm-dock-btn #dm-unread-badge {
  display: inline-flex;
  position: absolute;
  top: -0.35rem;
  right: -0.35rem;
  margin-left: 0;
  min-width: 1.05rem;
  height: 1.05rem;
  padding: 0 0.28rem;
  border-radius: 999px;
  background: var(--danger, #ed4245);
  color: var(--danger-text, #fff);
  font-size: 0.625rem;
  font-weight: 700;
  line-height: 1.05rem;
  text-align: center;
  pointer-events: none;
  box-shadow: 0 0 0 2px var(--bg-secondary);
  align-items: center;
  justify-content: center;
}

/* Hide split handle and expand channel section */
html[data-chrome-layout="1"] .sidebar-split-handle,
html[data-chrome-layout="1"] .sidebar-split-handle:hover,
html[data-chrome-layout="1"] .sidebar-split-handle.dragging {
  display: none !important;
}
html[data-chrome-layout="1"] .sidebar-split .channel-section {
  flex: 1 1 100% !important;
}

/* DM drawer with smooth collapse */
html[data-chrome-layout="1"] .sidebar-split .dm-section-pane {
  display: flex !important;
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: min(58%, 22rem);
  z-index: 20;
  background: var(--bg-secondary);
  border-top: 1px solid var(--border);
  box-shadow: 0 -10px 28px rgba(0, 0, 0, 0.22);
  padding: 0.35rem 0.65rem 0.5rem;
  flex: none;
  min-height: 0;
  overflow: hidden;
  flex-direction: column;
  border-bottom: none;
  transform: translateY(100%);
  opacity: 0;
  pointer-events: none;
  visibility: hidden;
  transition: transform 0.22s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.18s ease-out, visibility 0.22s;
}
html[data-chrome-layout="1"].dms-open .sidebar-split .dm-section-pane,
html[data-chrome-layout="1"] .sidebar.dms-open .sidebar-split .dm-section-pane {
  transform: translateY(0);
  opacity: 1;
  pointer-events: auto;
  visibility: visible;
}
/* The drawer always shows the DM list, even if it was collapsed in Original,
   without changing that saved choice */
html[data-chrome-layout="1"] .sidebar-split #dm-list {
  display: block !important;
}
html[data-chrome-layout="1"] .sidebar-split #dm-toggle-arrow.collapsed {
  transform: none;
}

/* Suppress other layout controls from bottom bar */
html[data-chrome-layout="1"] #braid-return-pill,
html[data-chrome-layout="1"] [data-compact-layout-control] {
  display: none !important;
}

/* Channel row voice controls */
html[data-chrome-layout="1"] .channel-join-voice {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.5rem;
  height: 1.5rem;
  margin-left: auto;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: 0.75rem;
  line-height: 1;
  cursor: pointer;
}
html[data-chrome-layout="1"] .channel-item:has(.channel-join-voice) .channel-more-btn {
  margin-left: 0;
}
html[data-chrome-layout="1"] .channel-join-voice:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
  border-color: var(--accent);
}
html[data-chrome-layout="1"] .channel-join-voice.is-live {
  color: var(--success, #43b581);
  border-color: color-mix(in srgb, var(--success, #43b581) 45%, var(--border));
}
html[data-chrome-layout="1"] .channel-join-voice.is-leave {
  background: var(--danger, #ed4245);
  color: var(--danger-text, #fff);
  border-color: var(--danger, #ed4245);
}
html[data-chrome-layout="1"] .channel-join-voice.is-leave:hover {
  filter: brightness(1.08);
  color: var(--danger-text, #fff);
}

/* Home server menu */
html[data-chrome-layout="1"] .home-server-menu {
  position: fixed;
  z-index: 90;
  min-width: 12.5rem;
  padding: 0.25rem;
  background: var(--bg-card, var(--bg-secondary));
  border: 1px solid var(--border);
  border-radius: 0.625rem;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.28);
}
html[data-chrome-layout="1"] .home-server-menu button {
  display: block;
  width: 100%;
  text-align: left;
  background: transparent;
  border: 0;
  border-radius: 0.4rem;
  color: var(--text-primary);
  cursor: pointer;
  font: inherit;
  font-size: 0.8125rem;
  padding: 0.45rem 0.65rem;
}
html[data-chrome-layout="1"] .home-server-menu button:hover {
  background: var(--bg-hover);
}
html[data-chrome-layout="1"] .home-server-menu button[hidden] {
  display: none;
}
html[data-chrome-layout="1"] #home-server {
  cursor: pointer;
}

/* Header badge for thread mentions */
html[data-chrome-layout="1"] .header-icon-with-badge {
  position: relative;
}
html[data-chrome-layout="1"] .header-icon-badge {
  position: absolute;
  top: -0.3rem;
  right: -0.3rem;
  min-width: 1rem;
  height: 1rem;
  padding: 0 0.25rem;
  border-radius: 999px;
  background: var(--danger, #d35a5a);
  color: var(--danger-text, #fff);
  font-size: 0.625rem;
  font-weight: 700;
  line-height: 1rem;
  text-align: center;
  box-shadow: 0 0 0 2px var(--bg-secondary);
}

/* Hide default redundantly placed buttons */
html[data-chrome-layout="1"] #voice-join-btn,
html[data-chrome-layout="1"] #voice-active-indicator,
html[data-chrome-layout="1"] #voice-leave-header-btn,
html[data-chrome-layout="1"] #add-server-btn,
html[data-chrome-layout="1"] #manage-servers-btn,
html[data-chrome-layout="1"] #sync-servers-btn,
html[data-chrome-layout="1"] #desktop-app-banner,
html[data-chrome-layout="1"] #android-beta-banner {
  display: none !important;
}
`;

if (typeof module !== 'undefined') module.exports = ChromeLayout;
if (typeof window !== 'undefined') window.ChromeLayout = ChromeLayout;
if (typeof _win !== 'undefined') _win.ChromeLayout = ChromeLayout;
