'use strict';
const { CATALOG, tally, mine, setVote } = require('../layoutVotes');
module.exports = function register(socket, ctx) {
  const { io, db } = ctx;
  let recent = [];
  socket.on('get-layout-votes', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : typeof data === 'function' ? data : () => {};
    try { cb({ catalog: CATALOG, tally: tally(db), mine: mine(db, socket.user.id) }); }
    catch (err) { console.error('get-layout-votes error:', err); cb({ error: 'Could not load the votes' }); }
  });
  socket.on('vote-layout', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    const now = Date.now();
    recent = recent.filter(t => now - t < 10000);
    if (recent.length >= 20) return cb({ error: 'Slow down a little' });
    recent.push(now);
    const id = typeof data?.id === 'string' ? data.id : '';
    if (typeof data?.on !== 'boolean') return cb({ error: 'Invalid vote' });
    try {
      if (!setVote(db, socket.user.id, id, data.on)) return cb({ error: 'Unknown layout' });
      const t = tally(db);
      cb({ tally: t, mine: mine(db, socket.user.id) });
      io.except('bot-sockets').emit('layout-votes', { tally: t });
    } catch (err) { console.error('vote-layout error:', err); cb({ error: 'Could not save your vote' }); }
  });
};
