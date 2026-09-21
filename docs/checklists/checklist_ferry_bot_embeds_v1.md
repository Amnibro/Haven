# Checklist: Ferry relays promotion-bot embeds (links + images) v1

- [x] Scan repo (no architecture_map.md in upstream Haven)
- [x] Backup src/ferry.js + test/ferry.test.js -> backups/*.v4.3.0.bak
- [x] buildHavenContent: read `rich` embeds even when the bot typed text
- [x] keep embed.url for rich embeds (stream link), drop only that link when the allowlist refuses it
- [x] dedupe title/url/description already present in typed text
- [x] tests: text+rich embed, kick link dropped under allowlist, SaucyBot shape unchanged
- [x] node --check + npm test (ferry*)
- [x] CHANGELOG entry
- [x] commit as Amnibro, push fork, PR to ancsemi (no Claude trailer)

- PR: https://github.com/ancsemi/Haven/pull/5557 (branch fix/ferry-bot-embed-links, commit ccdfa49)
