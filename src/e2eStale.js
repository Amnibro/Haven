// Accounts with a device holding an outdated encryption key.
//
// A device left with an old key (an old install, or a key reset made
// elsewhere) has its public key refused as a conflict. Apps up to 8.6.3 then
// failed to open the signing key backup with that old key and forced a new
// signing key in, replacing it for every device of the account, often from
// another connection a moment later (the app reconnects while signing in).
// So the mark is per account, not per connection, and lasts long enough to
// cover that. Publishing a different key (an explicit reset) clears it. Kept
// in memory only: it guards the minutes around such a sign-in, nothing more.
const WINDOW_MS = 10 * 60 * 1000;
const marked = new Map();

module.exports = {
  WINDOW_MS,
  mark(userId) { marked.set(userId, Date.now()); },
  clear(userId) { marked.delete(userId); },
  isStale(userId) {
    const at = marked.get(userId);
    if (!at) return false;
    if (Date.now() - at < WINDOW_MS) return true;
    marked.delete(userId);
    return false;
  },
};
