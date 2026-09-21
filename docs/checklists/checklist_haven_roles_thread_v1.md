# Checklist: Haven support-thread fixes (Raidenphantom admin-role save + mods-see-all-channels) v1

Diagnosis: admin-role Save silently no-ops because `update-admin-role-display` only exists since 3.44.0 (2026-08-08); older server.js never acks, socket.io callback never fires, zero feedback. Other roles use ancient `update-role` so they work.

## PR A — fix/role-editor-silent-noop
- [x] Branch off origin/main, backups taken (backups/*.v3.47.0.bak)
- [x] `_roleEmit` ack-timeout helper in app-admin.js
- [x] Replace acked role-editor emits with `_roleEmit` (~26 call sites)
- [x] `toasts.role_server_no_response` in 7 locales
- [x] validate-locales + syntax check
- [x] Repro rig: pre-3.44 server.js + new public/ -> Save shows toast (old files: silent) — must fail on the .bak
- [x] Current server: Save still works, green toast

## PR B — feat/view-all-channels-perm
- [x] Branch off origin/main, backups
- [x] helpers.js VALID_ROLE_PERMS += view_all_channels
- [x] getEnrichedChannels: non-admin holders of view_all_channels take the admin visibility path
- [x] roles.js adminOnlyPerms x3 += view_all_channels; push channels-list on assign/revoke of roles granting it
- [x] app-admin.js ALL_PERMS / ADMIN_ONLY_PERMS / PERM_LABELS
- [x] `permissions.view_all_channels` in 7 locales
- [x] Live test: user2 with Server Mod+view_all_channels sees all channels incl. later-created; revoke stops future adds; non-admin cannot grant
- [x] node --check sweep + validate-locales

## Ship
- [x] Push both via Amnibro fork (anmire token helper), PRs on ancsemi/Haven
- [x] architecture_map.md + changelog.md updated

## PR C — fix/stale-install-shadow-check (#5513, round 2)
- [x] Diagnose boot crash screenshot: stale pre-2.9.8 src/socketHandlers.js shadows src/socketHandlers/ (require resolves file over dir); monolith setupSocketHandlers returns undefined -> server.js:4427 .activity TypeError
- [x] Repro byte-for-byte (fad2a5d~1 monolith into current tree, unfixed server.js)
- [x] Generic preflight guard in server.js: <name>.js shadowing <name>/index.js -> file list + exit 1
- [x] Verified: fixed+stale = named + exit 1; clean tree boots, /api/health OK; node --check passes
- [x] Pushed + PR #5513; books + memory updated
