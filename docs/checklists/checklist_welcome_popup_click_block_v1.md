# Checklist: Welcome popups blocking clicks v1

- [x] Confirm the blocker is `#android-beta-modal` then the recovery-codes overlay
- [x] Defer recovery notice until promo overlays are closed
- [x] Skip recovery notice and promo queue for guests
- [x] Skip Android promo inside Haven Desktop (already in an app)
- [x] Persist `promo_seen_*` + `recovery_notice_seen` for Amnibro on the public instance
- [x] Backup originals
- [x] Changelog
- [x] Confirm in-app clicks after dismiss
