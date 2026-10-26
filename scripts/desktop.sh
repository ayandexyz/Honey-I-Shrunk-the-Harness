#!/usr/bin/env bash
# Build + run apps/desktop (the vendored jcode-desktop GPU UI). See the
# "Desktop App" section in CLAUDE.md/AGENTS.md for what this talks to.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -e apps/jcode ]; then
  echo "apps/jcode is missing. It must be a symlink to a local jcode checkout" >&2
  echo "(apps/desktop's Cargo.toml path-deps resolve against it, e.g.:" >&2
  echo "  ln -s /path/to/your/jcode apps/jcode" >&2
  echo "It's gitignored on purpose — every machine points it at its own checkout." >&2
  exit 1
fi

cd apps/desktop
# ponytail: -j1 + no debug info avoids OOM on low-RAM machines (verified
# 7.6GB RAM crashed at default parallelism). Override via env if you have more.
exec env \
  CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-1}" \
  CARGO_PROFILE_DEV_DEBUG="${CARGO_PROFILE_DEV_DEBUG:-0}" \
  cargo run -p jcode-desktop "$@"
