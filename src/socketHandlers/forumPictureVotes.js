'use strict';

// Likes and dislikes on each picture of a blog post (#5784).
//
//   vote-piece { messageId, value: 1 | -1 | 0 }   0 takes a vote back
//
// A piece is the topic or one of its author's additions (src/forumBlog.js
// pieceOf), so a picture's votes are ordinary forum_votes rows keyed by its
// message, with the same rules as topic votes (src/forumVotes.js
// voteRefusal). Everyone viewing the forum gets the new counts through the
// same 'topic-votes' event; only the voter's own devices learn their vote
// ('topic-vote-mine'). The general event budget rate limits it, the same as
// vote-topic.

const { setVote, voteRefusal } = require('../forumVotes');
const forumBlog = require('../forumBlog');

module.exports = function register(socket, ctx) {
  const { io, db } = ctx;

  socket.on('vote-piece', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    if (!data || typeof data !== 'object') return cb({ error: 'Invalid request' });
    const messageId = Number.isInteger(data.messageId) && data.messageId > 0 ? data.messageId : null;
    const value = data.value;
    if (!messageId || ![1, -1, 0].includes(value)) return cb({ error: 'Invalid vote' });

    let piece = null;
    try {
      piece = forumBlog.pieceOf(db, messageId);
    } catch (err) {
      console.warn('[forum-picture-votes] piece lookup failed, refusing the vote:', err.message);
      return cb({ error: 'Failed to save the vote' });
    }
    if (!piece) return cb({ error: 'That is not a picture in a blog post' });

    const refusal = voteRefusal(ctx, socket.user, piece, value);
    if (refusal) return cb({ error: refusal });

    let totals;
    try {
      totals = setVote(db, messageId, socket.user.id, value);
    } catch (err) {
      console.error('vote-piece error:', err);
      return cb({ error: 'Failed to save the vote' });
    }
    io.to(`channel:${piece.code}`).emit('topic-votes', { channelCode: piece.code, messageId, ...totals });
    for (const [, s] of io.sockets.sockets) {
      if (s !== socket && s.user && s.user.id === socket.user.id) {
        s.emit('topic-vote-mine', { channelCode: piece.code, messageId, value });
      }
    }
    cb({ success: true, messageId, mine: value, ...totals });
  });
};
