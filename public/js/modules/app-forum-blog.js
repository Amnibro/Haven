// ═══════════════════════════════════════════════════════════
// Blog mode for forums (#5742).
//
// A Channel Functions switch on a forum. With it on, a topic belongs to its
// author: the author's own follow-ups in the topic (more pictures in a
// gallery post, an update) are shown as part of the post, and everyone
// else's replies go under a separate Comments heading below it. The topic
// cards count only the comments.
//
// The server decides which replies are part of the post and marks them
// post_part; this side only places them. See src/forumBlog.js for the rule.
// ═══════════════════════════════════════════════════════════

export default {

_forumBlogOn(code) {
  const ch = this.channels && this.channels.find(c => c.code === (code || this.currentChannel));
  return !!(ch && ch.is_forum && !ch.is_dm && Number(ch.forum_blog) === 1);
},

// The count under a topic card in blog mode: comments only. Returns null
// when the forum is not in blog mode, so the card keeps its reply count.
_forumBlogRepliesLabel(msg) {
  if (!this._forumBlogOn()) return null;
  const n = Number(msg && msg.thread && msg.thread.comments) || 0;
  return n ? `💬 ${t(n === 1 ? 'forum.blog_comment_one' : 'forum.blog_comment_other', { count: n })}` : t('forum.blog_comment_cta');
},

// The 'thread-messages' handler calls this after drawing the topic body and
// before adding the replies. In blog mode it lays out the post's own section
// and the Comments section under it.
_forumBlogPrepareThread(data) {
  const container = document.getElementById('thread-messages');
  const panel = document.getElementById('thread-panel');
  const blog = !!(data && data.blog);
  this._forumBlogThread = blog ? { parentId: data.parentId, authorId: data.parentUserId || null } : null;
  panel?.classList.toggle('thread-blog', blog);
  this._forumBlogComposerHint();
  if (!blog || !container) return;
  const parts = document.createElement('div');
  parts.className = 'blog-post-parts';
  parts.id = 'blog-post-parts';
  const head = document.createElement('div');
  head.className = 'blog-comments-head';
  head.id = 'blog-comments-head';
  const list = document.createElement('div');
  list.className = 'blog-comments';
  list.id = 'blog-comments';
  list.dataset.empty = t('forum.blog_no_comments');
  container.append(parts, head, list);
  this._forumBlogRecount();
},

// After the first load the post is what you see first, not the newest comment.
_forumBlogAfterLoad() {
  if (!this._forumBlogThread) return;
  const container = document.getElementById('thread-messages');
  if (container) container.scrollTop = 0;
},

// Where a thread reply goes: the post's section or the comments. Null when
// the open thread is not a blog topic, so it goes where it always did.
_forumBlogTargetFor(msg) {
  if (!this._forumBlogThread) return null;
  const container = document.getElementById('thread-messages');
  if (!container) return null;
  return container.querySelector(msg && msg.post_part === true ? '#blog-post-parts' : '#blog-comments');
},

_forumBlogIsPart(msg) {
  return !!(this._forumBlogThread && msg && msg.post_part === true);
},

_forumBlogRecount() {
  const head = document.getElementById('blog-comments-head');
  const list = document.getElementById('blog-comments');
  if (!head || !list) return;
  const n = list.querySelectorAll('.thread-message').length;
  head.textContent = n ? t('forum.blog_comments_count', { count: n }) : t('forum.blog_comments');
},

// The thread box says what sending will do: the author adds to the post,
// everyone else comments.
_forumBlogComposerHint() {
  const input = document.getElementById('thread-input');
  if (!input) return;
  const b = this._forumBlogThread;
  if (!b) { input.placeholder = t('thread_runtime.reply_placeholder'); return; }
  const isAuthor = !!(this.user && b.authorId && b.authorId === this.user.id);
  input.placeholder = t(isAuthor ? 'forum.blog_add_to_post' : 'forum.blog_write_comment');
},

_forumBlogClose() {
  this._forumBlogThread = null;
  document.getElementById('thread-panel')?.classList.remove('thread-blog');
  this._forumBlogComposerHint();
},

_listenForumBlog() {
  // Turned on or off in Channel Functions: redraw the forum and any topic
  // open in it, so everyone viewing sees the change at once.
  this.socket.on('channel-permission-updated', (data) => {
    if (!data || data.permission !== 'forum_blog') return;
    const ch = this.channels && this.channels.find(c => c.code === data.code);
    if (ch) ch.forum_blog = data.enabled ? 1 : 0;
    if (data.code !== this.currentChannel) return;
    if (this._forumActive) this._forumReload?.();
    if (this._activeThreadParent) this.socket.emit('get-thread-messages', { parentId: this._activeThreadParent });
    if (ch) this._updateChannelFunctionsPanel?.(ch);
  });
},

};
