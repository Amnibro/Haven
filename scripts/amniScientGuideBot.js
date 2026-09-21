'use strict';

const http = require('http');
const path = require('path');
const os = require('os');

const dataDir = process.env.HAVEN_DATA_DIR || path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Haven-AmniScient');
process.env.HAVEN_DATA_DIR = dataDir;
const { initDatabase } = require('../src/database');
const db = initDatabase();
const PORT = Number(process.env.AMNI_GUIDE_PORT || 3012);
const ORIGIN = process.env.HAVEN_WEBHOOK_ORIGIN || 'http://127.0.0.1:3010';

function guideToken() {
  const row = db.prepare("SELECT token FROM webhooks WHERE name = 'Guide' AND is_active = 1 ORDER BY id DESC LIMIT 1").get();
  return row && row.token;
}

function greet(user) {
  const name = (user && (user.username || user.displayName)) || 'there';
  return `Hey ${name}. I am Guide. Pinned posts in this channel and in each product room have the live links. Take Tester in #introductions for #testers and #prerelease.`;
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/hook') {
    res.writeHead(404);
    res.end();
    return;
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { body = {}; }
    res.writeHead(204);
    res.end();
    if (body.event !== 'member-joined' || !body.user || !body.user.id) return;
    const token = guideToken();
    if (!token) return;
    try {
      await fetch(`${ORIGIN}/api/webhooks/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: greet(body.user),
          username: 'Guide',
          ephemeral: true,
          recipient_id: body.user.id
        })
      });
    } catch (err) {
      console.warn('[guide]', err.message);
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[guide] http://127.0.0.1:${PORT}/hook`);
});
