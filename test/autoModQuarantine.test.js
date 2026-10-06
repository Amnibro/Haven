'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const AutoModQuarantine = require('../plugins/AutoModQuarantine.plugin.js');

test('AutoModQuarantine initializes with valid default settings', () => {
  const plugin = new AutoModQuarantine();
  assert.equal(plugin._started, false);
  assert.equal(plugin._settings.enabled, true);
  assert.equal(plugin._settings.autoReleaseSafe, true);
  assert.equal(plugin._settings.autoWarnUsers, true);
  assert.equal(plugin._settings.maxStrikes, 3);
  assert.equal(plugin._settings.aiProvider, 'gemini');
  assert.ok(plugin._settings.trustedDomains.includes('github.com'));
  assert.ok(plugin._settings.blockedDomains.includes('grabify.link'));
});

test('Multi-Provider AI configurations are properly defined', () => {
  const providers = AutoModQuarantine.PROVIDERS;
  assert.ok(providers.gemini, 'Gemini provider missing');
  assert.ok(providers.claude, 'Claude provider missing');
  assert.ok(providers.openai, 'OpenAI/Codex provider missing');
  assert.ok(providers.grok, 'Grok provider missing');
  assert.ok(providers.ollama, 'Ollama provider missing');
  assert.ok(providers.agy, 'AGY provider missing');
  assert.ok(providers.opencode, 'OpenCode provider missing');
  assert.ok(providers.muse, 'Muse provider missing');
  assert.ok(providers.custom, 'Custom provider missing');

  // Verify provider endpoints & types
  assert.equal(providers.gemini.type, 'gemini');
  assert.equal(providers.claude.type, 'anthropic');
  assert.equal(providers.openai.type, 'openai');
  assert.equal(providers.grok.type, 'openai');
  assert.equal(providers.ollama.type, 'openai');
  assert.equal(providers.ollama.needsKey, false);
  assert.equal(providers.agy.type, 'openai');
  assert.equal(providers.muse.type, 'openai');
});

test('getEffectiveAiConfig correctly resolves custom and default provider settings', () => {
  const plugin = new AutoModQuarantine();

  // Default Gemini
  const geminiConfig = plugin.getEffectiveAiConfig();
  assert.equal(geminiConfig.providerId, 'gemini');
  assert.equal(geminiConfig.model, 'gemini-3.8-flash');
  assert.equal(geminiConfig.auth, 'key');

  // Switch to Grok
  plugin._settings.aiProvider = 'grok';
  plugin._settings.aiApiKey = 'xai-test-key';
  const grokConfig = plugin.getEffectiveAiConfig();
  assert.equal(grokConfig.providerId, 'grok');
  assert.equal(grokConfig.endpoint, 'https://api.x.ai/v1/chat/completions');
  assert.equal(grokConfig.model, 'grok-4.7');
  assert.equal(grokConfig.apiKey, 'xai-test-key');

  // Switch to Ollama with custom model
  plugin._settings.aiProvider = 'ollama';
  plugin._settings.aiModel = 'mistral:latest';
  const ollamaConfig = plugin.getEffectiveAiConfig();
  assert.equal(ollamaConfig.providerId, 'ollama');
  assert.equal(ollamaConfig.endpoint, 'http://localhost:11434/v1/chat/completions');
  assert.equal(ollamaConfig.model, 'mistral:latest');

  // Switch to Claude with custom endpoint
  plugin._settings.aiProvider = 'claude';
  plugin._settings.aiEndpoint = 'https://my-proxy.internal/v1/messages';
  plugin._settings.aiApiKey = 'Bearer sso-token-xyz';
  const claudeConfig = plugin.getEffectiveAiConfig();
  assert.equal(claudeConfig.providerId, 'claude');
  assert.equal(claudeConfig.endpoint, 'https://my-proxy.internal/v1/messages');
  assert.equal(claudeConfig.apiKey, 'Bearer sso-token-xyz');
  const ssoHeaders = plugin._authHeaders(claudeConfig);
  assert.equal(ssoHeaders.Authorization, 'Bearer sso-token-xyz');
  assert.match(ssoHeaders['anthropic-beta'], /oauth-2025-04-20/);

  plugin._settings.aiProvider = 'opencode';
  plugin._settings.aiAuth = 'sso';
  plugin._settings.aiApiKey = 'oc_sk_test';
  plugin._settings.aiEndpoint = '';
  plugin._settings.aiModel = '';
  const openCode = plugin.getEffectiveAiConfig();
  assert.equal(openCode.providerId, 'opencode');
  assert.equal(openCode.endpoint, 'https://opencode.ai/zen/v1/chat/completions');
  assert.equal(openCode.model, 'glm-5.3-flash');
  assert.equal(openCode.auth, 'sso');
  const ocHeaders = plugin._authHeaders(openCode);
  assert.equal(ocHeaders.Authorization, 'Bearer oc_sk_test');
  assert.ok(ocHeaders['x-opencode-session']);

  plugin._settings.aiProvider = 'gemini';
  plugin._settings.aiAuth = 'sso';
  plugin._settings.aiApiKey = 'ya29-test';
  const geminiSso = plugin._authHeaders(plugin.getEffectiveAiConfig());
  assert.equal(geminiSso.Authorization, 'Bearer ya29-test');
  assert.equal(geminiSso['x-goog-api-key'], undefined);
  plugin._settings.aiAuth = 'key';
  const geminiKey = plugin._authHeaders(plugin.getEffectiveAiConfig());
  assert.equal(geminiKey['x-goog-api-key'], 'ya29-test');
  assert.equal(geminiKey.Authorization, undefined);
});

test('_parseAiResponse cleanly parses structured JSON or fallbacks', () => {
  const plugin = new AutoModQuarantine();

  // Valid clean JSON
  const res1 = plugin._parseAiResponse('{"safe": true, "reason": "Repository is clean", "confidence": 0.99}', 'test');
  assert.equal(res1.safe, true);
  assert.equal(res1.reason, 'Repository is clean');

  // JSON inside markdown fences
  const res2 = plugin._parseAiResponse('```json\n{"safe": false, "reason": "Phishing token grabber"}\n```', 'test');
  assert.equal(res2.safe, false);
  assert.equal(res2.reason, 'Phishing token grabber');

  // Fallback text classification
  const res3 = plugin._parseAiResponse('This link is dangerous and appears to be a phishing threat.', 'test');
  assert.equal(res3.safe, false);
});

test('extractUrls extracts both raw URLs and markdown links', () => {
  const plugin = new AutoModQuarantine();
  const text = 'Check out https://github.com/torvalds/linux and also [docs](https://wikipedia.org/wiki/Linux) here!';
  const urls = plugin.extractUrls(text);

  assert.equal(urls.length, 2);
  assert.equal(urls[0].url, 'https://wikipedia.org/wiki/Linux');
  assert.equal(urls[0].label, 'docs');
  assert.equal(urls[0].isMarkdown, true);

  assert.equal(urls[1].url, 'https://github.com/torvalds/linux');
  assert.equal(urls[1].isMarkdown, false);
});

test('normalizeHost handles www, ports, trailing dots, and case', () => {
  const plugin = new AutoModQuarantine();
  assert.equal(plugin.normalizeHost('WWW.Example.COM:8080'), 'example.com');
  assert.equal(plugin.normalizeHost('sub.domain.org.'), 'sub.domain.org');
  assert.equal(plugin.normalizeHost('github.com'), 'github.com');
});

test('Source Trust: releases trusted domains', () => {
  const plugin = new AutoModQuarantine();
  const resGithub = plugin.checkSourceTrust('https://github.com/amnibro/haven');
  assert.equal(resGithub.ok, true);
  assert.equal(resGithub.trusted, true);

  const resWiki = plugin.checkSourceTrust('https://en.wikipedia.org/wiki/Computer_security');
  assert.equal(resWiki.ok, true);
  assert.equal(resWiki.trusted, true);
});

test('Source Trust: blocks raw IP URLs', () => {
  const plugin = new AutoModQuarantine();
  const res = plugin.checkSourceTrust('http://45.33.32.156/setup.exe');
  assert.equal(res.ok, false);
  assert.match(res.reason, /IP address/i);
});

test('Source Trust: blocks punycode domains', () => {
  const plugin = new AutoModQuarantine();
  const res = plugin.checkSourceTrust('https://xn--e1awd7f.com/login');
  assert.equal(res.ok, false);
  assert.match(res.reason, /punycode/i);
});

test('Source Trust: blocks dangerous file extensions', () => {
  const plugin = new AutoModQuarantine();
  const resExe = plugin.checkSourceTrust('https://some-unverified-site.org/downloads/game_installer.exe');
  assert.equal(resExe.ok, false);
  assert.match(resExe.reason, /executable/i);

  const resBat = plugin.checkSourceTrust('https://some-unverified-site.org/script.bat');
  assert.equal(resBat.ok, false);
  assert.match(resBat.reason, /executable/i);
});

test('Source Trust: blocks server denylist domains', () => {
  const plugin = new AutoModQuarantine();
  const res = plugin.checkSourceTrust('https://grabify.link/track/123');
  assert.equal(res.ok, false);
  assert.match(res.reason, /server blocked/i);
});

test('Source Trust: flags Discord Nitro and Steam phishing scams', () => {
  const plugin = new AutoModQuarantine();
  const nitro = plugin.checkSourceTrust('https://free-nitro-gift.xyz/claim');
  assert.equal(nitro.ok, false);
  assert.match(nitro.reason, /Discord Nitro/i);

  const steam = plugin.checkSourceTrust('https://steamcommunity-tradeoffer.ru/trade');
  assert.equal(steam.ok, false);
  assert.match(steam.reason, /Steam/i);

  const crypto = plugin.checkSourceTrust('https://airdrop-claim-tokens.site/connect-wallet');
  assert.equal(crypto.ok, false);
  assert.match(crypto.reason, /wallet drainer/i);
});

test('AI Heuristic scanner catches social engineering messages', async () => {
  const plugin = new AutoModQuarantine();
  const verdictScam = await plugin.scanContentAndLink(
    'https://unverified-zone.xyz/win',
    'Hey bro click here to claim free nitro gift right now!'
  );
  assert.equal(verdictScam.status, 'blocked');
  assert.ok(verdictScam.reason.length > 0);

  const verdictSafe = await plugin.scanContentAndLink(
    'https://cool-project.org/about',
    'Here is an open source blog post discussing protocol architectures'
  );
  assert.equal(verdictSafe.status, 'safe');
});

test('transformMessageHtml quarantines unverified links initially', () => {
  const plugin = new AutoModQuarantine();
  const rawText = 'Check this https://unknown-site.org/item';
  const initialHtml = 'Check this <a href="https://unknown-site.org/item" target="_blank">https://unknown-site.org/item</a>';

  const quarantinedHtml = plugin.transformMessageHtml(initialHtml, rawText);
  assert.match(quarantinedHtml, /haven-quarantine-capsule/);
  assert.match(quarantinedHtml, /Quarantined Link/);
  assert.doesNotMatch(quarantinedHtml, /<a href="https:\/\/unknown-site\.org\/item"/);
});

test('transformMessageHtml displays verified safe link when cached safe', () => {
  const plugin = new AutoModQuarantine();
  const url = 'https://github.com/torvalds/linux';
  plugin._cache.set(url, { status: 'safe', reason: 'Trusted source', url });

  const rawText = `Check ${url}`;
  const initialHtml = `Check <a href="${url}" target="_blank">${url}</a>`;

  const safeHtml = plugin.transformMessageHtml(initialHtml, rawText);
  assert.match(safeHtml, /haven-automod-released/);
  assert.match(safeHtml, /hq-verified-check/);
  assert.match(safeHtml, /href="https:\/\/github\.com\/torvalds\/linux"/);
});

test('transformMessageHtml displays blocked card when cached blocked', () => {
  const plugin = new AutoModQuarantine();
  const url = 'https://grabify.link/test';
  plugin._cache.set(url, { status: 'blocked', reason: 'Denylisted IP logger', url });

  const rawText = `Check ${url}`;
  const initialHtml = `Check <a href="${url}" target="_blank">${url}</a>`;

  const blockedHtml = plugin.transformMessageHtml(initialHtml, rawText);
  assert.match(blockedHtml, /haven-automod-blocked-card/);
  assert.match(blockedHtml, /Link Blocked by AutoMod/);
  assert.match(blockedHtml, /Denylisted IP logger/);
});

test('recordInfraction and issueWarning tracks strikes and escalates', () => {
  const plugin = new AutoModQuarantine();
  assert.equal(plugin.getUserStrikes(42), 0);

  const warn1 = plugin.issueWarning('badguy', 42, 'Phishing link', 'https://bad.xyz', 'testchan');
  assert.equal(warn1.strikes, 1);
  assert.match(warn1.message, /Warning 1\/3/);

  const warn2 = plugin.issueWarning('badguy', 42, 'Malicious executable', 'https://bad.xyz/evil.exe', 'testchan');
  assert.equal(warn2.strikes, 2);
  assert.match(warn2.message, /Warning 2\/3/);

  const warn3 = plugin.issueWarning('badguy', 42, 'IP logger', 'https://grabify.link/1', 'testchan');
  assert.equal(warn3.strikes, 3);
  assert.match(warn3.message, /Warning 3\/3/);
  assert.equal(plugin.getUserStrikes(42), 3);

  plugin.clearUserStrikes(42);
  assert.equal(plugin.getUserStrikes(42), 0);
});
