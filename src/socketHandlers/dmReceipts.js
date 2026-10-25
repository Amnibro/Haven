'use strict';
const { enabled, peerOf, markDelivered, status } = require('../dmReceipts');
module.exports = function register(socket, ctx) {
  const { io, db } = ctx;
  const uid = socket.user.id;
  const socketsOf = (id) => [...io.sockets.sockets.values()].filter(s => s.user?.id === id);
  const tell = (to, code, cid, reader) => { if (enabled(db, to) && enabled(db, reader)) { const st = { code, ...status(db, cid, reader, true) }; for (const s of socketsOf(to)) s.emit('dm-receipt', st); } };
  setImmediate(() => { try { for (const d of markDelivered(db, uid)) tell(d.peer, d.code, d.cid, uid); } catch (err) { console.error('dm-receipt delivered error:', err); } });
  let recent = [];
  socket.on('get-dm-receipt', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    const now = Date.now();
    recent = recent.filter(t => now - t < 10000);
    if (recent.length >= 40) return cb({ error: 'Slow down a little' });
    recent.push(now);
    try {
      const p = peerOf(db, typeof data?.code === 'string' ? data.code : '', uid);
      if (!p) return cb({ off: true });
      if (!enabled(db, uid) || !enabled(db, p.peer)) return cb({ code: data.code, off: true });
      cb({ code: data.code, ...status(db, p.cid, p.peer, socketsOf(p.peer).length > 0) });
    } catch (err) { console.error('get-dm-receipt error:', err); cb({ error: 'Could not load the receipt' }); }
  });
  socket.on('mark-read', (data) => {
    try {
      const p = typeof data?.code === 'string' && peerOf(db, data.code, uid);
      if (p) setImmediate(() => { try { tell(p.peer, data.code, p.cid, uid); } catch (err) { console.error('dm-receipt read error:', err); } });
    } catch (err) { console.error('dm-receipt read error:', err); }
  });
  socket.on('disconnect', () => { try { markDelivered(db, uid); } catch (err) { console.error('dm-receipt delivered error:', err); } });
};
