'use strict';

// "Playing" presence for Haven's own games in Activities (Shippy Container,
// the Flash games, .io Games). The client says which game is open; the name
// shown comes from the server's list, so nobody can put arbitrary text there.

module.exports = function register(socket, ctx) {
  const activity = () => ctx.state && ctx.state.activity;

  socket.on('set-game-activity', (data) => {
    if (!socket.user || !activity()) return;
    const game = data && typeof data.game === 'string' ? data.game : '';
    socket.havenGame = activity().setHavenGame(socket.user.id, game) ? game : null;
  });

  // A tab that closes with a game open stops reporting it, unless another
  // of this person's tabs still has a game open.
  socket.on('disconnect', () => {
    if (!socket.havenGame || !socket.user || !activity()) return;
    const uid = socket.user.id;
    for (const [, s] of ctx.io.of('/').sockets) {
      if (s !== socket && s.user && s.user.id === uid && s.havenGame) return;
    }
    activity().setHavenGame(uid, '');
  });
};
