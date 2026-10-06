#!/usr/bin/env bash
# Rebuild the haven.amni-scient.com layout on Linux: seed -> brand -> layout.
# Stops Haven and its bots while the database is rewritten, then starts them.
# Edit scripts/amniScientProducts.json to change product pages, then re-run.
set -euo pipefail
cd "$(dirname "$0")/.."
export HAVEN_DATA_DIR="${HAVEN_DATA_DIR:-$HOME/.local/share/haven-amniscient}"
units=(amni-haven-release-bot amni-haven-guide amni-haven)
systemctl --user stop "${units[@]}"
trap 'systemctl --user start amni-haven amni-haven-guide amni-haven-release-bot' EXIT
node scripts/seedAmniScientCommunity.js | grep -v '^\[search\]'
node scripts/brandAmniScientHaven.js | grep -v '^\[search\]'
node scripts/amniScientLayout.js | grep -v '^\[search\]'
