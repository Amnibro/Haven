// Discord history import: upload a DiscordChatExporter file and preview it,
// or read a server straight from Discord's API, then run the import. Admin only.

const fs = require('fs');
const path = require('path');
const express = require('express');
const crypto = require('crypto');
const os = require('os');
const { verifyToken } = require('../auth');
const { parseDiscordExport } = require('../importDiscord');

module.exports = function registerImport(deps) {
  const { uploadDiskGuard, app, verifyAdminFromDb, uploadLimiter, importUpload } = deps;
  // ── Step 1: Upload & parse → return preview ──────────────
  app.post('/api/import/discord/upload', uploadLimiter, uploadDiskGuard, (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user || !verifyAdminFromDb(user)) return res.status(403).json({ error: 'Admin only' });

    importUpload.single('file')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

      try {
        const result = parseDiscordExport(req.file.path);

        // Save parsed data to temp so the execute step can read it
        const importId = crypto.randomBytes(16).toString('hex');
        const tempPath = path.join(os.tmpdir(), `haven-import-${importId}.json`);
        fs.writeFileSync(tempPath, JSON.stringify(result));

        // Clean up the uploaded raw file
        try { fs.unlinkSync(req.file.path); } catch { /* cleanupTempImports() sweeps any haven-import leftover */ }

        // Return preview (channel list + counts, NOT the full messages)
        res.json({
          importId,
          format: result.format,
          serverName: result.serverName,
          channels: result.channels.map(c => ({
            discordId: c.discordId,
            name: c.name,
            topic: c.topic,
            category: c.category,
            messageCount: c.messageCount
          })),
          totalMessages: result.channels.reduce((sum, c) => sum + c.messageCount, 0)
        });
      } catch (parseErr) {
        try { fs.unlinkSync(req.file.path); } catch { /* rejected temp upload may already be gone */ }
        res.status(400).json({ error: parseErr.message });
      }
    });
  });

  // ── Discord Direct Connect: pull messages straight from Discord's API ──
  const DISCORD_API = 'https://discord.com/api/v10';

  async function discordApiFetch(endpoint, auth, retries = 2) {
    const resp = await fetch(`${DISCORD_API}${endpoint}`, {
      headers: auth.headers,
      signal: AbortSignal.timeout(30000)
    });
    if (resp.status === 401) {
      throw new Error(auth.ferry
        ? "Discord rejected the Ferry bot's token. Set Ferry up again in Settings, then try again."
        : 'Invalid or expired Discord token');
    }
    if (resp.status === 403) {
      const err = new Error(auth.ferry
        ? "The Ferry bot isn't allowed to read that on Discord."
        : 'Access denied. Check the token can see this.');
      err.status = 403;
      throw err;
    }
    if (resp.status === 429 && retries > 0) {
      const wait = parseFloat(resp.headers.get('retry-after') || '3');
      await new Promise(r => setTimeout(r, wait * 1000));
      return discordApiFetch(endpoint, auth, retries - 1);
    }
    if (!resp.ok) throw new Error(`Discord API error ${resp.status}`);
    return resp.json();
  }

  // Who the import reads Discord as. The Ferry bot is the normal way: its token
  // stays on the server and the client only sends useFerry. A personal login
  // token is the fallback the client keeps behind a warning, since Discord's
  // rules don't allow apps to drive a personal account.
  function resolveImportAuth(body) {
    if (body?.useFerry) {
      const headers = require('../ferry').importHeaders();
      if (!headers) return { error: 'Ferry is not set up yet. Set it up in Settings, then try again.' };
      return { ferry: true, headers };
    }
    const discordToken = body?.discordToken;
    if (!discordToken || typeof discordToken !== 'string') return { error: 'Discord token required' };
    return { ferry: false, headers: { Authorization: discordToken } };
  }

  // Discord ids are numbers; anything else never reaches a Discord URL.
  const DISCORD_ID = /^\d{5,25}$/;

  // Step A: validate token → list servers
  app.post('/api/import/discord/connect', express.json(), async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user || !verifyAdminFromDb(user)) return res.status(403).json({ error: 'Admin only' });

    const auth = resolveImportAuth(req.body);
    if (auth.error) return res.status(400).json({ error: auth.error });

    try {
      const me = await discordApiFetch('/users/@me', auth);
      const guilds = await discordApiFetch('/users/@me/guilds?limit=200', auth);
      if (auth.ferry && !guilds.length) {
        return res.status(400).json({ error: "The Ferry bot isn't in any Discord server yet. Add it to yours with the invite link in Settings, Ferry, then try again." });
      }
      res.json({
        ferry: auth.ferry,
        user: { username: me.global_name || me.username },
        guilds: guilds.map(g => ({ id: g.id, name: g.name, icon: g.icon }))
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Step B: list text channels, announcement channels, forums, and threads for a guild
  app.post('/api/import/discord/guild-channels', express.json(), async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user || !verifyAdminFromDb(user)) return res.status(403).json({ error: 'Admin only' });

    const auth = resolveImportAuth(req.body);
    if (auth.error) return res.status(400).json({ error: auth.error });
    const { guildId } = req.body;
    if (typeof guildId !== 'string' || !DISCORD_ID.test(guildId)) return res.status(400).json({ error: 'Missing params' });

    try {
      const allChannels = await discordApiFetch(`/guilds/${guildId}/channels`, auth);

      // Build category map
      const categories = {};
      allChannels.filter(c => c.type === 4).forEach(c => { categories[c.id] = c.name; });

      // Text (0), Announcement (5), Forum (15), Media (16): all contain readable content
      const textTypes = new Set([0, 5, 15, 16]);
      const channelsList = allChannels
        .filter(c => textTypes.has(c.type))
        .sort((a, b) => a.position - b.position)
        .map(c => ({
          id: c.id,
          name: c.name,
          topic: c.topic || '',
          category: (c.parent_id && categories[c.parent_id]) || null,
          type: c.type === 5 ? 'announcement' : c.type === 15 ? 'forum' : c.type === 16 ? 'media' : 'text',
          // Forum tags (available on type 15 and 16)
          tags: Array.isArray(c.available_tags) ? c.available_tags.map(t => ({ id: t.id, name: t.name })) : []
        }));

      // Fetch threads (active + archived public)
      const threads = [];

      // Active threads
      try {
        const active = await discordApiFetch(`/guilds/${guildId}/threads/active`, auth);
        if (active.threads) threads.push(...active.threads);
      } catch { /* bot may lack access to active threads; list the channels without them */ }

      // Archived threads per text/forum/announcement channel, a page of 100 at
      // a time (#5772), up to 2,000 per channel.
      for (const ch of channelsList) {
        let before = null;
        for (let page = 0; page < 20; page++) {
          try {
            const q = before ? `&before=${encodeURIComponent(before)}` : '';
            const archived = await discordApiFetch(`/channels/${ch.id}/threads/archived/public?limit=100${q}`, auth);
            const list = Array.isArray(archived.threads) ? archived.threads : [];
            threads.push(...list);
            const last = list[list.length - 1];
            before = last && last.thread_metadata && last.thread_metadata.archive_timestamp;
            if (!archived.has_more || !before) break;
          } catch { break; /* channels the bot cannot read have no archived threads to list */ }
          await new Promise(r => setTimeout(r, 200));
        }
        await new Promise(r => setTimeout(r, 200));
      }

      // De-duplicate threads and map to entries
      const seen = new Set();
      const threadEntries = [];
      for (const t of threads) {
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        // Find parent channel
        const parent = channelsList.find(c => c.id === t.parent_id);
        const parentName = parent ? parent.name : null;

        // Resolve applied forum tags
        let tagNames = [];
        if (Array.isArray(t.applied_tags) && parent && parent.tags.length) {
          tagNames = t.applied_tags
            .map(tid => parent.tags.find(tag => tag.id === tid))
            .filter(Boolean)
            .map(tag => tag.name);
        }

        threadEntries.push({
          id: t.id,
          name: t.name,
          topic: '',
          category: (parent && parent.category) || null,
          type: 'thread',
          parentId: t.parent_id,
          parentName,
          tags: tagNames
        });
      }

      res.json({ channels: channelsList, threads: threadEntries });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Step C: fetch all messages from selected channels → save temp → return preview
  // Reading a large server takes minutes. Held open as one request, it was
  // cut off by whatever sits in front of Haven (Cloudflare Tunnel gives up
  // after 100 seconds and answers with an HTML page). So the read runs as a
  // job: this starts it and answers at once, and the page asks for progress
  // until the result is ready.
  const fetchJobs = new Map();
  const FETCH_JOB_TTL = 30 * 60 * 1000;
  setInterval(() => {
    const cutoff = Date.now() - FETCH_JOB_TTL;
    for (const [id, job] of fetchJobs) if (job.updatedAt < cutoff) fetchJobs.delete(id);
  }, 5 * 60 * 1000).unref();

  app.post('/api/import/discord/fetch', express.json(), (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user || !verifyAdminFromDb(user)) return res.status(403).json({ error: 'Admin only' });

    const auth = resolveImportAuth(req.body);
    if (auth.error) return res.status(400).json({ error: auth.error });
    const { guildName, channels: selected } = req.body;
    if (!Array.isArray(selected) || !selected.length || !selected.every(ch => typeof ch?.id === 'string' && DISCORD_ID.test(ch.id))) {
      return res.status(400).json({ error: 'Missing params' });
    }
    if ([...fetchJobs.values()].filter(j => j.state === 'running').length >= 3) {
      return res.status(429).json({ error: 'Other imports are still reading from Discord. Try again when they finish.' });
    }

    const jobId = crypto.randomBytes(16).toString('hex');
    const job = { userId: user.id, state: 'running', channelsDone: 0, channelsTotal: selected.length, messages: 0, updatedAt: Date.now() };
    fetchJobs.set(jobId, job);
    res.status(202).json({ jobId });
    readDiscordChannels(job, auth, guildName, selected).catch((err) => {
      console.warn('[import] Discord read failed:', err.message);
      Object.assign(job, { state: 'done', status: 400, body: { error: err.message }, updatedAt: Date.now() });
    });
  });

  app.get('/api/import/discord/fetch/:jobId', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const user = token ? verifyToken(token) : null;
    if (!user || !verifyAdminFromDb(user)) return res.status(403).json({ error: 'Admin only' });
    const job = fetchJobs.get(String(req.params.jobId));
    if (!job || job.userId !== user.id) return res.status(404).json({ error: 'That import is no longer running. Fetch the messages again.' });
    if (job.state === 'running') {
      return res.json({ state: 'running', channelsDone: job.channelsDone, channelsTotal: job.channelsTotal, messages: job.messages });
    }
    fetchJobs.delete(String(req.params.jobId));
    res.status(job.status).json({ state: 'done', ...job.body });
  });

  async function readDiscordChannels(job, auth, guildName, selected) {
    const finish = (status, body) => Object.assign(job, { state: 'done', status, body, updatedAt: Date.now() });
    const result = {
      format: 'Discord Direct',
      serverName: guildName || 'Discord Import',
      channels: []
    };
    // Channels the reader can't open (a bot only sees what its roles allow)
    // are skipped and named, instead of failing the whole import.
    const skipped = [];
    // A bot without the Message Content intent gets every message with an
    // empty body, which would import as nothing at all.
    let peopleMessages = 0, emptyPeopleMessages = 0;

    // Discord rate-limits message reads per channel, so several channels can
    // be fetched at once without hitting the limits.
    const IMPORT_CONCURRENCY = 4;
    const fetched = new Array(selected.length);
    let nextIdx = 0;
    const worker = async () => {
    while (nextIdx < selected.length) {
      const idx = nextIdx++;
      const ch = selected[idx];
      const messages = [];
      let before = null, batch;
      // What the entry is (#5772): a thread goes into its parent channel, and
      // a forum becomes a Haven forum whose posts are its topics.
      const kind = ['text', 'announcement', 'forum', 'media', 'thread'].includes(ch.kind) ? ch.kind : 'text';
      const parentId = typeof ch.parentId === 'string' && DISCORD_ID.test(ch.parentId) ? ch.parentId : null;
      const tags = Array.isArray(ch.tags)
        ? ch.tags.filter(t => typeof t === 'string' && t.trim()).map(t => t.trim().slice(0, 30)).slice(0, 20)
        : [];
      const isForum = kind === 'forum' || kind === 'media';

      try {
        if (!isForum) do {
          let ep = `/channels/${ch.id}/messages?limit=100`;
          if (before) ep += `&before=${before}`;
          batch = await discordApiFetch(ep, auth);
          job.messages += batch.length;
          job.updatedAt = Date.now();

          for (const msg of batch) {
            if (msg.type !== 0 && msg.type !== 19) continue; // Default + Reply only
            if (!msg.author?.bot) {
              peopleMessages++;
              if (!msg.content && !msg.attachments?.length && !msg.embeds?.length) emptyPeopleMessages++;
            }
            let content = msg.content || '';
            if (Array.isArray(msg.attachments)) {
              for (const a of msg.attachments) {
                content += `\n📎 ${a.url ? '[' + a.filename + '](' + a.url + ')' : a.filename}`;
              }
            }
            if (Array.isArray(msg.embeds)) {
              for (const e of msg.embeds) {
                if (e.title) content += `\n🔗 **${e.title}**`;
                if (e.description) content += `\n${e.description}`;
                if (e.url && !content.includes(e.url)) content += `\n${e.url}`;
              }
            }
            content = content.trim();
            if (!content) continue;

            messages.push({
              discordId: msg.id,
              author: msg.author?.global_name || msg.author?.username || 'Unknown',
              authorId: msg.author?.id || null,
              authorAvatar: msg.author?.avatar
                ? `https://cdn.discordapp.com/avatars/${msg.author.id}/${msg.author.avatar}.png?size=64`
                : null,
              isBot: msg.author?.bot || false,
              content,
              timestamp: msg.timestamp,
              isPinned: msg.pinned || false,
              reactions: (msg.reactions || []).map(r => ({
                emoji: r.emoji?.name || '❓',
                count: r.count || 1
              })),
              replyTo: msg.message_reference?.message_id || null
            });
          }

          if (batch.length > 0) before = batch[batch.length - 1].id;
          await new Promise(r => setTimeout(r, 300)); // respect rate limits
        } while (batch.length === 100);
      } catch (err) {
        if (err.status !== 403) throw err;
        skipped.push(ch.name || ch.id);
        job.channelsDone++;
        continue;
      }
      job.channelsDone++;

      fetched[idx] = {
        discordId: ch.id,
        name: ch.name,
        topic: ch.topic || '',
        category: ch.category || null,
        kind,
        parentId,
        tags,
        messageCount: messages.length,
        messages
      };
    }
    };
    await Promise.all(Array.from({ length: Math.min(IMPORT_CONCURRENCY, selected.length) }, worker));
    for (const c of fetched) if (c) result.channels.push(c);

    if (auth.ferry && peopleMessages >= 5 && emptyPeopleMessages === peopleMessages) {
      return finish(400, { error: "Discord sent the messages without their text. On the Ferry bot's Bot page in the Discord Developer Portal, turn on Message Content Intent, then try again." });
    }
    if (!result.channels.length) {
      return finish(400, { error: auth.ferry
        ? "The Ferry bot can't read any of those channels. On Discord, give it a role that can see them, then try again."
        : "Couldn't read any of those channels." });
    }

    const importId = crypto.randomBytes(16).toString('hex');
    const tempPath = path.join(os.tmpdir(), `haven-import-${importId}.json`);
    fs.writeFileSync(tempPath, JSON.stringify(result));

    finish(200, {
      importId,
      skipped,
      format: result.format,
      serverName: result.serverName,
      channels: result.channels.map(c => ({
        discordId: c.discordId,
        name: c.name,
        topic: c.topic,
        category: c.category,
        messageCount: c.messageCount
      })),
      totalMessages: result.channels.reduce((sum, c) => sum + c.messageCount, 0)
    });
  }

  // ── Periodic cleanup of orphaned import temp files (1 hour TTL) ──
  function cleanupTempImports() {
    try {
      const tmpDir = os.tmpdir();
      const cutoff = Date.now() - 60 * 60 * 1000; // 1 hour
      for (const f of fs.readdirSync(tmpDir)) {
        if (!f.startsWith('haven-import-')) continue;
        const fp = path.join(tmpDir, f);
        try {
          const stat = fs.statSync(fp);
          if (stat.mtimeMs < cutoff) fs.unlinkSync(fp);
        } catch { /* file in use or already removed; the next sweep retries */ }
      }
    } catch { /* temp dir unreadable; orphaned import files are only disk clutter */ }
  }
  // Run once at startup to clean up any stale files from previous crashes
  cleanupTempImports();
  setInterval(cleanupTempImports, 15 * 60 * 1000); // then every 15 min

};
