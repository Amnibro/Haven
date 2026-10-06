# Checklist: Windows self-host support + cloudflared auto-download (PR #5575)
- [x] Read server bind, wizard port-check, tunnel.js, installer, GUIDE remote-access sections
- [x] Root causes: portchecker.io outside-in probe; installer promised download it never did; tunnel spawned from PATH only
- [x] Backups: backups/tunnel.js.v4.3.0.bak, backups/Install Haven.ps1.v4.3.0.bak, backups/server.js.eacces.bak
- [x] tunnel.js resolve/download; installer pre-fetch; server EACCES Windows hint; CHANGELOG
- [x] tests 5/5; live download 54.8 MB -> cloudflared 2026.8.3 runs; PS AST parse OK
- [x] Commit 235e30c (Amnibro, no trailer), pushed, PR https://github.com/ancsemi/Haven/pull/5575
- [x] Reply draft for Dispencer2 delivered in chat
