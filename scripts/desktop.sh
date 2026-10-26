#!/usr/bin/env bash
# Build + run apps/desktop (the vendored jcode-desktop GPU UI). See the
# "Desktop App" section in CLAUDE.md/AGENTS.md for what this talks to.
set -euo pipefail
cd "$(dirname "$0")/.."

# apps/jcode = the real jcode crates with jcode-sdk swapped for our shim.
bash scripts/desktop-overlay.sh

cd apps/desktop
# ponytail: -j1 + no debug info avoids OOM on low-RAM machines (verified
# 7.6GB RAM crashed at default parallelism). Override via env if you have more.
exec env \
  CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-1}" \
  CARGO_PROFILE_DEV_DEBUG="${CARGO_PROFILE_DEV_DEBUG:-0}" \
  cargo run -p jcode-desktop "$@"
