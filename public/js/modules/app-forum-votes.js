// ═══════════════════════════════════════════════════════════
// Votes on forum topics (#5742).
//
// A forum can have votes off (the default), likes, or likes and dislikes,
// set in Channel Functions. Each topic card, and the bar above an open
// topic, then shows a like button with its count (and a dislike button).
// Clicking your current vote again takes it back; liking replaces a dislike
// and the other way round. The server keeps the counts and sends them live.
// ═══════════════════════════════════════════════════════════

export default {

// 0 off, 1 likes, 2 likes and dislikes.
_forumVotesMode(code) {
  const ch = this.channels && this.channels.find(c => c.code === (code || this.currentChannel));
  const n = Number(ch && ch.forum_votes) || 0;
  return ch && ch.is_forum && (n === 1 || n === 2) ? n : 0;
},

_forumVotesOf(msg) {
  const v = (msg && msg.votes) || {};
  return { likes: Number(v.likes) || 0, dislikes: Number(v.dislikes) || 0, mine: v.mine === 1 || v.mine === -1 ? v.mine : 0 };
},

// Likes minus dislikes, for the Most liked order.
_forumScoreOf(msg) {
  const v = this._forumVotesOf(msg);
  return v.likes - v.dislikes;
},

_forumVotesHtml(msg) {
  const mode = this._forumVotesMode();
  if (!mode || !msg) return '';
  const v = this._forumVotesOf(msg);
  const btn = (value, icon, count, label) => `<button type="button" class="forum-vote${v.mine === value ? ' active' : ''}" data-vote="${value}" title="${this._escapeHtml(label)}" aria-label="${this._escapeHtml(label)}" aria-pressed="${v.mine === value}">${icon} <span class="forum-vote-count">${count}</span></button>`;
  return `<span class="forum-votes" data-votes-for="${msg.id}">${btn(1, '👍', v.likes, t('forum.votes_like'))}${mode === 2 ? btn(-1, '👎', v.dislikes, t('forum.votes_dislike')) : ''}</span>`;
},

// Wire the buttons inside `root` for topic `msg`. The click stays on the
// button, so it never opens the topic underneath.
_forumBindVotes(root, msg) {
  root?.querySelectorAll(`.forum-votes[data-votes-for="${msg.id}"]`).forEach(el => this._forumBindVoteButtons(el, msg.id));
},
_forumBindVoteButtons(votesEl, messageId) {
  votesEl.querySelectorAll('.forum-vote').forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    this._forumCastVote(messageId, Number(b.dataset.vote));
  }));
},

_forumCastVote(messageId, value) {
  const topic = this._forumTopics && this._forumTopics.get(messageId);
  // One vote in flight at a time, so a double click cannot cast and take
  // back in the same moment. Released after a few seconds if no answer.
  if (!topic || Date.now() - (this._forumVoteBusy || 0) < 5000) return;
  const want = this._forumVotesOf(topic).mine === value ? 0 : value;
  this._forumVoteBusy = Date.now();
  this.socket.emit('vote-topic', { messageId, value: want }, (r) => {
    this._forumVoteBusy = 0;
    if (!r || r.error) { this._showToast((r && r.error) || t('forum.votes_failed'), 'error'); return; }
    this._forumApplyVotes({ messageId, likes: r.likes, dislikes: r.dislikes, mine: r.mine });
  });
},

// New counts (and maybe this reader's own vote) for one topic: repaint the
// card and the open topic's bar in place, so nothing jumps while you click.
_forumApplyVotes(data) {
  const topic = data && this._forumTopics && this._forumTopics.get(data.messageId);
  if (!topic) return;
  const v = this._forumVotesOf(topic);
  if (Number.isFinite(data.likes)) v.likes = data.likes;
  if (Number.isFinite(data.dislikes)) v.dislikes = data.dislikes;
  if (data.mine === 1 || data.mine === -1 || data.mine === 0) v.mine = data.mine;
  topic.votes = v;
  document.querySelectorAll(`.forum-votes[data-votes-for="${topic.id}"]`).forEach(el => {
    const holder = document.createElement('span');
    holder.innerHTML = this._forumVotesHtml(topic);
    const fresh = holder.firstElementChild;
    if (!fresh) { el.remove(); return; }
    el.replaceWith(fresh);
    this._forumBindVoteButtons(fresh, topic.id);
  });
},

_listenForumVotes() {
  this.socket.on('topic-votes', (data) => {
    if (!data || data.channelCode !== this.currentChannel) return;
    this._forumApplyVotes({ messageId: data.messageId, likes: data.likes, dislikes: data.dislikes });
  });
  // Your own vote, cast from another device.
  this.socket.on('topic-vote-mine', (data) => {
    if (!data || data.channelCode !== this.currentChannel) return;
    this._forumApplyVotes({ messageId: data.messageId, mine: data.value });
  });
  this.socket.on('forum-votes-mode', (data) => {
    const ch = data && this.channels && this.channels.find(c => c.code === data.code);
    if (!ch) return;
    ch.forum_votes = { off: 0, likes: 1, both: 2 }[data.mode] || 0;
    if (data.code === this.currentChannel && this._forumActive) this._forumReload?.();
  });
},

// Channel Functions row: pick Off, Likes, or Likes and dislikes.
async _forumVotesEdit(code) {
  const current = this._forumVotesMode(code);
  const opt = (id, n, key) => ({ id, label: (current === n ? '✓ ' : '') + t(key), accent: current === n });
  const mode = await this._askChoice(t('forum.votes_title'), t('forum.votes_hint'), [
    opt('off', 0, 'forum.votes_off'),
    opt('likes', 1, 'forum.votes_likes'),
    opt('both', 2, 'forum.votes_both'),
  ]);
  if (!mode) return;
  this.socket.emit('set-forum-votes', { code, mode }, (r) => {
    if (!r || r.error) { this._showToast((r && r.error) || t('forum.votes_failed'), 'error'); return; }
    const ch = this.channels && this.channels.find(c => c.code === code);
    if (ch) ch.forum_votes = { off: 0, likes: 1, both: 2 }[r.mode] || 0;
    this._updateChannelFunctionsPanel?.(ch);
    this._showToast(t('forum.votes_saved'), 'success');
  });
},

// The badge on the Channel Functions row.
_forumVotesBadge(ch) {
  const n = Number(ch && ch.forum_votes) || 0;
  return n === 2 ? t('forum.votes_badge_both') : n === 1 ? t('forum.votes_badge_likes') : t('channel_functions.off');
},

};
