// Channel categories in the sidebar (#5756): headers that read as buttons,
// dark while open and lit while collapsed; an optional short name or emoji
// shown when a category is collapsed; and an admin option that lays the
// category headers out as a grid of tabs above their channels.
//
// Server settings: category_layout ('list' or 'tabs') and
// category_short_names (JSON, lowercase category name to short name).

const SHORT_MAX = 12;

export default {

_categoryLayout() {
  return this.serverSettings?.category_layout === 'tabs' ? 'tabs' : 'list';
},

_categoryShortNames() {
  try {
    const map = JSON.parse(this.serverSettings?.category_short_names || '{}');
    return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
  } catch {
    return {}; // a broken value just means no short names
  }
},

// In tab mode every category header goes into one wrapping grid, placed
// where the first category starts; their channels follow in order below.
_categoryHeaderHolder(list) {
  if (this._categoryLayout() !== 'tabs') return list;
  let holder = list.querySelector(':scope > .category-tabs');
  if (!holder) {
    holder = document.createElement('div');
    holder.className = 'category-tabs';
    list.appendChild(holder);
  }
  return holder;
},

// Look and label for a header, called when it is drawn and on every toggle.
_decorateCategoryLabel(label, cat, collapsed) {
  label.classList.add('cat-pill');
  label.classList.toggle('cat-collapsed', !!collapsed);
  const nameEl = label.querySelector('.cat-name') || [...label.children].find(c => c.tagName === 'SPAN' && !c.classList.contains('cat-collapse-arrow') && !c.classList.contains('channel-badge'));
  if (!nameEl) return;
  nameEl.classList.add('cat-name');
  const short = this._categoryShortNames()[cat.toLowerCase()];
  // The glitch effect remembers the text it scrambles; a new name replaces
  // that memory so the effect does not bring the other name back (#5761).
  if (nameEl._scrambleInterval) { clearInterval(nameEl._scrambleInterval); nameEl._scrambleInterval = null; }
  nameEl._scrambling = false;
  nameEl.classList.remove('scrambling');
  delete nameEl.dataset.originalText;
  nameEl.textContent = collapsed && short ? short : cat;
  label.title = collapsed && short ? cat : '';
  if (!label.dataset.shortNameMenu && (this.user?.isAdmin || this._hasPerm?.('manage_server'))) {
    label.dataset.shortNameMenu = '1';
    label.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this._editCategoryShortName(cat);
    });
  }
},

async _editCategoryShortName(cat) {
  const names = this._categoryShortNames();
  const key = cat.toLowerCase();
  const value = await this._showPromptModal(t('channels.category_short_title', { name: cat }), t('channels.category_short_hint'), names[key] || '');
  if (value === null || value === undefined) return;
  const short = String(value).trim().slice(0, SHORT_MAX);
  if (short) names[key] = short;
  else delete names[key];
  this.socket.emit('update-server-setting', { key: 'category_short_names', value: JSON.stringify(names) });
},

};
