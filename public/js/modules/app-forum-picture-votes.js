// ═══════════════════════════════════════════════════════════
// Likes and dislikes on each picture of a blog post (#5784).
//
// In a blog forum each piece of a post (the opening post, or one of the
// author's additions) gets its own like and dislike buttons, next to its
// comments button and on the picture when it is opened full size. They show
// whenever the forum has votes on, and follow the forum's setting (likes
// only, or likes and dislikes). The opening post's votes are the topic's
// votes, so they match the bar above the post and the topic card.
//
// The server keeps the counts (vote-piece) and sends them live through the
// same events topic votes use; app-forum-votes.js passes them on here.
// ═══════════════════════════════════════════════════════════

export default {

// Shown on an open blog post in a forum with votes on.
_forumPieceVotesOn() {
  return !!this._forumBlogThread && this._forumVotesMode() > 0;
},

// The counts the server sent with the topic, keyed by piece id. Null clears.
_forumPieceVotesLoad(map) {
  this._forumPieceVotes = new Map();
  if (!map || typeof map !== 'object') return;
  for (const [id, v] of Object.entries(map)) this._forumPieceVotes.set(Number(id), this._forumVotesOf({ votes: v }));
},

_forumPieceVotesOf(id) {
  return (this._forumPieceVotes && this._forumPieceVotes.get(Number(id))) || { likes: 0, dislikes: 0, mine: 0 };
},

// The buttons for one piece, the same look as a topic's.
_forumPieceVotesHtml(id) {
  if (!this._forumPieceVotesOn()) return '';
  return this._forumVotesHtml({ id: Number(id), votes: this._forumPieceVotesOf(id) }, 'data-piece-votes-for');
},

_forumPieceBindVotes(el, id) {
  el.querySelectorAll('.forum-vote').forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    this._forumPieceCastVote(Number(id), Number(b.dataset.vote));
  }));
},

// Puts a piece's buttons at the start of its bar, before the comments
// button, or takes them away when votes are off.
_forumPieceVotesPaint(id, bar) {
  if (!bar) return;
  bar.querySelector(':scope > [data-piece-votes-for]')?.remove();
  const html = this._forumPieceVotesHtml(id);
  if (!html) return;
  bar.insertAdjacentHTML('afterbegin', html);
  const el = bar.firstElementChild;
  if (el) this._forumPieceBindVotes(el, id);
},

// Every bar of the open post, and the opened picture: after the forum's
// vote setting changes.
_forumPieceVotesRepaint() {
  document.querySelectorAll('#thread-messages .blog-piece-bar[data-piece]').forEach(bar => this._forumPieceVotesPaint(bar.dataset.piece, bar));
  this._forumPieceVotesLightbox(this._forumPieceLightboxImg || null);
},

_forumPieceCastVote(id, value) {
  // One vote in flight at a time, as on topics; released after a few
  // seconds if the server never answers.
  if (!id || Date.now() - (this._forumPieceVoteBusy || 0) < 5000) return;
  const want = this._forumPieceVotesOf(id).mine === value ? 0 : value;
  this._forumPieceVoteBusy = Date.now();
  this.socket.emit('vote-piece', { messageId: id, value: want }, (r) => {
    this._forumPieceVoteBusy = 0;
    if (!r || r.error) { this._showToast((r && r.error) || t('forum.votes_failed'), 'error'); return; }
    // Through the topic path too: the opening post's votes are the topic's.
    this._forumApplyVotes({ messageId: id, likes: r.likes, dislikes: r.dislikes, mine: r.mine });
  });
},

// New counts, or this reader's own vote, for a message that may be a piece
// of the open post. Anything else is left alone.
_forumPieceApplyVotes(data) {
  if (!data || !this._forumBlogThread) return;
  const id = Number(data.messageId);
  const known = this._forumPieceVotes && this._forumPieceVotes.has(id);
  if (!known && !document.querySelector(`#thread-messages .blog-piece-bar[data-piece="${id}"]`)) return;
  if (!this._forumPieceVotes) this._forumPieceVotes = new Map();
  const v = { ...this._forumPieceVotesOf(id) };
  if (Number.isFinite(data.likes)) v.likes = data.likes;
  if (Number.isFinite(data.dislikes)) v.dislikes = data.dislikes;
  if (data.mine === 1 || data.mine === -1 || data.mine === 0) v.mine = data.mine;
  this._forumPieceVotes.set(id, v);
  document.querySelectorAll(`[data-piece-votes-for="${id}"]`).forEach(el => {
    const holder = document.createElement('span');
    holder.innerHTML = this._forumPieceVotesHtml(id);
    const fresh = holder.firstElementChild;
    if (!fresh) { el.remove(); return; }
    el.replaceWith(fresh);
    this._forumPieceBindVotes(fresh, id);
  });
},

// Which piece of the open post a picture belongs to, or null.
_forumPieceIdOf(imgEl) {
  const b = this._forumBlogThread;
  if (!b || !imgEl || !imgEl.closest) return null;
  if (!imgEl.closest('#thread-messages')) return null;
  if (imgEl.closest('.thread-topic-body')) return Number(b.parentId);
  const part = imgEl.closest('#blog-post-parts > .thread-message');
  return part ? Number(part.dataset.msgId) : null;
},

// The lightbox shows the opened picture's buttons; app-media.js calls this
// when it shows a picture (and with null when it closes).
_forumPieceVotesLightbox(imgEl) {
  const lb = document.getElementById('image-lightbox');
  if (!lb) return;
  this._forumPieceLightboxImg = imgEl || null;
  const id = this._forumPieceVotesOn() ? this._forumPieceIdOf(imgEl) : null;
  let box = lb.querySelector(':scope > .lightbox-piece-votes');
  if (!id) { box?.remove(); return; }
  if (!box) {
    box = document.createElement('div');
    box.className = 'lightbox-piece-votes';
    lb.appendChild(box);
  }
  box.innerHTML = this._forumPieceVotesHtml(id);
  const el = box.firstElementChild;
  if (el) this._forumPieceBindVotes(el, id);
},

};
