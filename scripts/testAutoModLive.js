'use strict';

/**
 * End-to-end integration test for AutoModQuarantine plugin on the live Haven server.
 * Run with: node scripts/testAutoModLive.js
 */

const io = require('socket.io-client');
const AutoModQuarantine = require('../plugins/AutoModQuarantine.plugin.js');

const SERVER_URL = process.env.HAVEN_URL || 'http://127.0.0.1:3010';

async function main() {
  console.log(`[AutoMod Live Test] Connecting to Haven server at ${SERVER_URL}...`);

  // 1. Verify plugin endpoint
  console.log('\n--- Step 1: Checking /api/plugins endpoint ---');
  const pluginsRes = await fetch(`${SERVER_URL}/api/plugins`);
  const pluginsList = await pluginsRes.json();
  const automodMeta = pluginsList.find(p => p.file === 'AutoModQuarantine.plugin.js');
  if (!automodMeta) {
    throw new Error('AutoModQuarantine.plugin.js not found in /api/plugins response!');
  }
  console.log('✓ Found plugin in /api/plugins:', automodMeta.name, 'v' + automodMeta.version);

  // 2. Verify static plugin file serving
  console.log('\n--- Step 2: Fetching /plugins/AutoModQuarantine.plugin.js ---');
  const fileRes = await fetch(`${SERVER_URL}/plugins/AutoModQuarantine.plugin.js`);
  if (!fileRes.ok) {
    throw new Error(`Failed to fetch plugin file: HTTP ${fileRes.status}`);
  }
  const fileText = await fileRes.text();
  if (!fileText.includes('class AutoModQuarantine')) {
    throw new Error('Plugin file content invalid or missing AutoModQuarantine class');
  }
  console.log(`✓ Fetched plugin code successfully (${fileText.length} bytes)`);

  // 3. Authenticate with Haven API
  console.log('\n--- Step 3: Authenticating admin account (amnibro) ---');
  const authRes = await fetch(`${SERVER_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'amnibro',
      password: 'breakthisbro',
      eulaVersion: '1.0',
      ageVerified: true
    })
  });
  if (!authRes.ok) {
    throw new Error(`Login failed with status ${authRes.status}: ${await authRes.text()}`);
  }
  const authData = await authRes.json();
  const token = authData.token;
  console.log('✓ Login successful! User:', authData.user.username, '(Admin:', authData.user.isAdmin, ')');

  // 4. Initialize AutoModQuarantine instance
  console.log('\n--- Step 4: Testing Plugin Scanning Engine ---');
  const plugin = new AutoModQuarantine();

  // Test Case A: Safe Whitelisted Link (GitHub)
  const safeUrl = 'https://github.com/torvalds/linux';
  console.log(`Scanning Link A: ${safeUrl}...`);
  const verdictSafe = await plugin.scanContentAndLink(safeUrl, 'Check this kernel repo');
  console.log(`  -> Status: ${verdictSafe.status.toUpperCase()} (${verdictSafe.reason}) [Source: ${verdictSafe.source}]`);
  if (verdictSafe.status !== 'safe') throw new Error('Safe link was not marked as safe!');
  console.log('  ✓ Safe link verified and marked for release.');

  // Test Case B: Dangerous IP link with executable
  const maliciousUrl = 'http://45.33.32.156/payload_update.exe';
  console.log(`Scanning Link B: ${maliciousUrl}...`);
  const verdictMalicious = await plugin.scanContentAndLink(maliciousUrl, 'Download this game update!');
  console.log(`  -> Status: ${verdictMalicious.status.toUpperCase()} (${verdictMalicious.reason}) [Source: ${verdictMalicious.source}]`);
  if (verdictMalicious.status !== 'blocked') throw new Error('Malicious link was not blocked!');
  console.log('  ✓ Malicious link intercepted, quarantined, and blocked.');

  // Test Case C: Phishing scam link
  const phishingUrl = 'https://discord-nitro-gift-claim.xyz/free';
  console.log(`Scanning Link C: ${phishingUrl}...`);
  const verdictPhishing = await plugin.scanContentAndLink(phishingUrl, 'Claim your free discord nitro gift!');
  console.log(`  -> Status: ${verdictPhishing.status.toUpperCase()} (${verdictPhishing.reason}) [Source: ${verdictPhishing.source}]`);
  if (verdictPhishing.status !== 'blocked') throw new Error('Phishing link was not blocked!');
  console.log('  ✓ Phishing link intercepted, quarantined, and blocked.');

  // 5. Test Strike & Warning System
  console.log('\n--- Step 5: Testing Warning and Strike Issuance ---');
  const mockUserId = 999;
  const mockUsername = 'bad_actor';
  const warnResult = plugin.issueWarning(mockUsername, mockUserId, verdictPhishing.reason, phishingUrl, 'testchannel');
  console.log('✓ Warning Issued:');
  console.log(`  Strikes: ${warnResult.strikes}`);
  console.log(`  Message: "${warnResult.message}"`);
  if (warnResult.strikes !== 1) throw new Error('Strike count did not increment to 1');

  // Issue 2nd and 3rd warning to test threshold escalation
  plugin.issueWarning(mockUsername, mockUserId, verdictMalicious.reason, maliciousUrl, 'testchannel');
  const warn3 = plugin.issueWarning(mockUsername, mockUserId, 'Repeated violation', 'http://1.2.3.4', 'testchannel');
  console.log(`✓ Escalation Threshold reached: ${warn3.strikes} strikes recorded for @${mockUsername}`);

  // 6. Test HTML Quarantine & Release Transformation
  console.log('\n--- Step 6: Testing HTML Quarantine & Release Transformation ---');
  const sampleChatHtml = `Hey everyone! Look at <a href="${safeUrl}" target="_blank">${safeUrl}</a> and stay away from <a href="${maliciousUrl}" target="_blank">${maliciousUrl}</a>.`;
  const transformed = plugin.transformMessageHtml(sampleChatHtml, `Hey everyone! Look at ${safeUrl} and stay away from ${maliciousUrl}.`);

  if (!transformed.includes('haven-automod-released') || !transformed.includes('hq-verified-check')) {
    throw new Error('Safe link was not rendered with release badge!');
  }
  if (!transformed.includes('haven-automod-blocked-card') || !transformed.includes('Link Blocked by AutoMod')) {
    throw new Error('Malicious link was not rendered with blocked card!');
  }
  console.log('✓ HTML correctly renders safe link with release badge and malicious link with blocked quarantine card!');

  // 7. Live Socket Connection test
  console.log('\n--- Step 7: Testing Live Socket.io Connection with Token ---');
  const socket = io(SERVER_URL, {
    auth: { token },
    transports: ['websocket', 'polling']
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.disconnect();
      reject(new Error('Socket connection timed out'));
    }, 5000);

    socket.on('connect', () => {
      clearTimeout(timeout);
      console.log('✓ Socket connected successfully! ID:', socket.id);
      resolve();
    });

    socket.on('connect_error', (err) => {
      clearTimeout(timeout);
      reject(new Error('Socket connection error: ' + err.message));
    });
  });

  socket.disconnect();
  console.log('\n======================================================');
  console.log('🎉 ALL LIVE INTEGRATION TESTS PASSED SUCCESSFULLY! 🎉');
  console.log('======================================================');
}

main().catch(err => {
  console.error('\n❌ Test failed:', err);
  process.exit(1);
});
