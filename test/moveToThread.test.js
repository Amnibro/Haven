'use strict';

/**
 * "Move here as thread": selected messages go into the thread under another
 * message in the same channel (src/moveToThread.js and its socket handler).
 *
 *   node --test test/moveToThread.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createHarness, wait } = require('./socketServerHarness');
const threadNotify = require('../src/threadNotify');

const PORT = 3471;
const h = createHarness(PORT, 'move-to-thread');

test.before(() => h.start());
test.after(() => h.stop());

const move = (sock, code, rootId, messageIds) => h.ask(sock, 'move-messages-to-thread', { code, rootId, messageIds });

test('moving messages into a thread', async (t) => {
  const admin = await h.register('admin');
  const mod = await h.register('mod');
  const bob = await h.register('bob');
  const carol = await h.register('carol');
  const A = await h.connect(admin.token);
  const M = await h.connect(mod.token);
  const B = await h.connect(bob.token);
  const C = await h.connect(carol.token);
  const db = new Database(path.join(h.dataDir, 'haven.db'));
  db.pragma('busy_timeout = 5000');
  t.after(() => db.close());

  const roles = (await h.ask(A, 'get-roles', {})).roles;
  assert.ok((await h.ask(A, 'assign-role', { userId: mod.id, roleId: roles.find((r) => r.name === 'Mod').id })).success);

  async function makeChannel(name, perms = []) {
    A.emit('create-channel', { name });
    for (let i = 0; i < 30; i++) {
      const row = db.prepare('SELECT id, code FROM channels WHERE name = ?').get(name);
      if (row) {
        for (const permission of perms) {
          A.emit('toggle-channel-permission', { code: row.code, permission });
          await wait(150);
        }
        for (const s of [A, M, B]) { s.emit('join-channel', { code: row.code }); await wait(100); }
        return row;
      }
      await wait(100);
    }
    throw new Error(`channel ${name} was not created`);
  }

  let minute = 0;
  const post = (channelId, userId, content, threadId = null, replyTo = null) => {
    minute += 1;
    const at = `2026-01-01 10:${String(minute).padStart(2, '0')}:00`;
    return Number(db.prepare('INSERT INTO messages (channel_id, user_id, content, created_at, thread_id, reply_to) VALUES (?, ?, ?, ?, ?, ?)')
      .run(channelId, userId, content, at, threadId, replyTo).lastInsertRowid);
  };
  const threadOf = (rootId) => db.prepare('SELECT id, content, reply_to FROM messages WHERE thread_id = ? ORDER BY created_at, id').all(rootId);

  const talk = await makeChannel('talk');
  const other = await makeChannel('other');
  A.emit('enter-channel', { code: talk.code });
  B.emit('enter-channel', { code: talk.code });
  await wait(200);

  await t.test('a member without Delete Messages is refused, and so is someone outside the channel', async () => {
    const base = post(talk.id, bob.id, 'base');
    const m = post(talk.id, bob.id, 'one');
    const r = await move(B, talk.code, base, [m]);
    assert.match(r.error || '', /permissions/);
    db.prepare('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?').run(talk.id, carol.id);
    const c = await move(C, talk.code, base, [m]);
    assert.match(c.error || '', /Channel not found/);
    assert.equal(db.prepare('SELECT thread_id FROM messages WHERE id = ?').get(m).thread_id, null, 'nothing moved');
  });

  await t.test('the base and the selection have to be roots of this channel', async () => {
    const base = post(talk.id, admin.id, 'base');
    const sel = post(talk.id, admin.id, 'sel');
    const reply = post(talk.id, admin.id, 'a reply', base);
    const elsewhere = post(other.id, admin.id, 'elsewhere');
    assert.match((await move(A, talk.code, sel, [sel])).error || '', /not one of the selected/);
    assert.match((await move(A, talk.code, reply, [sel])).error || '', /threads cannot hold threads/);
    assert.match((await move(A, talk.code, elsewhere, [sel])).error || '', /not in this channel/);
    assert.match((await move(A, talk.code, base, [sel, elsewhere])).error || '', /not found in this channel/);
    assert.match((await move(A, talk.code, base, [reply])).error || '', /already replies/);
    const many = Array.from({ length: 201 }, (_, i) => sel + 1000 + i);
    assert.match((await move(A, talk.code, base, many)).error || '', /between 1 and 200/);
  });

  await t.test('messages land in time order around the base, with what they carry, and everyone hears', async () => {
    const before1 = post(talk.id, bob.id, 'before 1');
    const before2 = post(talk.id, mod.id, 'before 2');
    const base = post(talk.id, admin.id, 'the base');
    const existing = post(talk.id, bob.id, 'already in the thread', base);
    const after1 = post(talk.id, bob.id, 'after 1', null, base);
    const after2 = post(talk.id, admin.id, 'after 2');
    db.prepare('INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)').run(before1, mod.id, '👍');
    db.prepare('INSERT INTO pinned_messages (message_id, channel_id, pinned_by) VALUES (?, ?, ?)').run(after2, talk.id, admin.id);
    db.prepare('UPDATE messages SET is_archived = 1 WHERE id = ?').run(before2);
    // Bob read the thread to the end; the moved messages are not news to him.
    db.prepare('INSERT INTO thread_reads (user_id, thread_id, last_read_reply_id) VALUES (?, ?, ?)').run(bob.id, base, existing);

    const gone = h.next(B, 'messages-moved', (d) => d && d.toThread === base);
    const threaded = h.next(B, 'messages-threaded', (d) => d && d.parentId === base);
    const chip = h.next(B, 'thread-updated', (d) => d && d.parentId === base);
    const quiet = h.next(B, 'new-thread-message', () => true, 800);
    const r = await move(M, talk.code, base, [after2, before1, after1, before2]);
    assert.deepStrictEqual(r, { success: true, moved: 4, brought: 0 });

    assert.deepStrictEqual(threadOf(base).map((m) => m.content), ['before 1', 'before 2', 'already in the thread', 'after 1', 'after 2']);
    assert.deepStrictEqual((await gone).messageIds, [before1, before2, after1, after2].sort((a, b) => a - b));
    assert.equal((await threaded).channelCode, talk.code);
    assert.equal((await chip).thread.count, 5);
    assert.equal(await quiet, null, 'no new-thread-message, so no sounds or markers');

    const row = (id) => db.prepare('SELECT user_id, created_at, is_archived, channel_id FROM messages WHERE id = ?').get(id);
    assert.equal(row(before1).user_id, bob.id);
    assert.equal(row(before1).created_at, '2026-01-01 10:' + String(minute - 5).padStart(2, '0') + ':00');
    assert.equal(row(before2).is_archived, 1, 'still protected');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reactions WHERE message_id = ?').get(before1).n, 1);
    assert.equal(db.prepare('SELECT channel_id FROM pinned_messages WHERE message_id = ?').get(after2).channel_id, talk.id, 'still pinned');
    assert.equal(threadNotify.newCounts(db, bob.id, [{ id: base, userId: admin.id }]).get(base), 0, 'bob stays caught up');

    const history = await new Promise((res) => {
      B.once('message-history', res);
      B.emit('get-messages', { code: talk.code });
    });
    const ids = history.messages.map((m) => m.id);
    for (const id of [before1, before2, after1, after2]) assert.ok(!ids.includes(id), 'gone from the channel feed');
    assert.ok(ids.includes(base));
  });

  await t.test('a selected message with its own thread brings its replies along', async () => {
    const base = post(talk.id, admin.id, 'base');
    const sub = post(talk.id, bob.id, 'its own thread');
    const r1 = post(talk.id, mod.id, 'answer 1', sub);
    const r2 = post(talk.id, admin.id, 'answer 2', sub, r1);
    const loose = post(talk.id, bob.id, 'loose');
    db.prepare('INSERT INTO thread_reads (user_id, thread_id, last_read_reply_id) VALUES (?, ?, ?)').run(bob.id, sub, r2);
    // Someone with a reply still to read keeps their place.
    const unread = post(talk.id, mod.id, 'not seen yet', base);
    db.prepare('INSERT INTO thread_reads (user_id, thread_id, last_read_reply_id) VALUES (?, ?, 0)').run(bob.id, base);

    const threaded = h.next(B, 'messages-threaded', (d) => d && d.parentId === base);
    const r = await move(A, talk.code, base, [loose, sub]);
    assert.deepStrictEqual(r, { success: true, moved: 2, brought: 2 });
    const thread = threadOf(base);
    assert.deepStrictEqual(thread.map((m) => m.content), ['its own thread', 'answer 1', 'answer 2', 'loose', 'not seen yet']);
    assert.equal(thread.find((m) => m.id === r1).reply_to, sub, 'a loose reply now answers the message it was under');
    assert.equal(thread.find((m) => m.id === r2).reply_to, r1, 'a reply to a reply keeps its target');
    const d = await threaded;
    assert.deepStrictEqual(d.absorbedRoots, [sub]);
    assert.deepStrictEqual(d.messageIds, [sub, r1, r2, loose].sort((a, b) => a - b));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM thread_reads WHERE thread_id = ?').get(sub).n, 0, 'no read position on a message that is no longer a thread');
    assert.ok(threadNotify.newCounts(db, bob.id, [{ id: base, userId: admin.id }]).get(base) >= 1, 'bob still has the unread reply');
    assert.ok(unread);
  });

  await t.test('a forum topic takes other topics as replies, unless it is a blog or paired with Discord', async () => {
    const forum = await makeChannel('ideas', ['forum']);
    const topic = post(forum.id, admin.id, 'first topic');
    const second = post(forum.id, bob.id, 'second topic');
    const r = await move(A, forum.code, topic, [second]);
    assert.ok(r.success, JSON.stringify(r));
    assert.deepStrictEqual(threadOf(topic).map((m) => m.content), ['second topic']);
    assert.equal(threadNotify.newCounts(db, admin.id, [{ id: topic, userId: admin.id }]).get(topic), 0, 'the topic author was caught up and stays so');

    const paired = post(forum.id, bob.id, 'paired topic');
    db.prepare(`INSERT INTO ferry_forum_threads (topic_message_id, channel_id, guild_id, discord_forum_id, discord_thread_id, origin)
      VALUES (?, ?, 'g', 'f', 't1', 'haven')`).run(paired, forum.id);
    assert.match((await move(A, forum.code, topic, [paired])).error || '', /Discord/);

    const blog = await makeChannel('journal', ['forum', 'forum_blog']);
    const post1 = post(blog.id, admin.id, 'a post');
    const post2 = post(blog.id, bob.id, 'another post');
    assert.match((await move(A, blog.code, post1, [post2])).error || '', /blog/);
  });

  await t.test('DMs are refused', async () => {
    const dm = Number(db.prepare("INSERT INTO channels (name, code, created_by, is_dm) VALUES ('dm', 'abcdef12', ?, 1)").run(admin.id).lastInsertRowid);
    db.prepare('INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?), (?, ?)').run(dm, admin.id, dm, bob.id);
    const base = post(dm, admin.id, 'hi');
    const m = post(dm, bob.id, 'hello');
    assert.match((await move(A, 'abcdef12', base, [m])).error || '', /DMs/);
  });

  await t.test('the move is in the audit log', async () => {
    await wait(100);
    const rows = db.prepare("SELECT actor_id, target_type, target_id, details FROM audit_log WHERE action = 'messages_move_to_thread' ORDER BY id").all();
    assert.equal(rows.length, 3);
    assert.equal(rows[0].actor_id, mod.id);
    assert.equal(rows[0].target_type, 'channel');
    assert.equal(rows[0].target_id, talk.id);
    assert.equal(JSON.parse(rows[0].details).messages, 4);
  });
});
