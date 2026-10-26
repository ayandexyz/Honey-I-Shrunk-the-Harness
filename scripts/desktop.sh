#!/usr/bin/env bash
# Build + run apps/desktop (the vendored jcode-desktop GPU UI). See the
# "Desktop App" section in CLAUDE.md/AGENTS.md for what this talks to.
set -euo pipefail
cd "$(dirname "$0")/.."

# apps/jcode = the real jcode crates with jcode-sdk swapped for our shim.
bash scripts/desktop-overlay.sh

cd apps/desktop
# Sessions come from freecode core, but upstream UI code also reads Jcode's
# own state straight off disk (sidebar session merge, persisted-history
# prefetch, transcript search, collections) under JCODE_HOME, default
# ~/.jcode. Point it at a freecode-owned dir so Jcode's sessions never mix in.
# ponytail: -j1 + no debug info avoids OOM on low-RAM machines (verified
# 7.6GB RAM crashed at default parallelism). Override via env if you have more.
# Upstream also reports usage to Jcode's telemetry service; a freecode build
# must not, so its documented opt-out is always set.
exec env \
  JCODE_HOME="${FREECODE_DESKTOP_JCODE_HOME:-$HOME/.freecode/desktop/jcode-home}" \
  JCODE_NO_TELEMETRY=1 \
  CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-1}" \
  CARGO_PROFILE_DEV_DEBUG="${CARGO_PROFILE_DEV_DEBUG:-0}" \
  cargo run -p jcode-desktop "$@"
