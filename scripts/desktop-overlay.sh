#!/usr/bin/env bash
# Build the apps/jcode overlay that apps/desktop's Cargo.toml path-deps resolve
# against (`../../../jcode/crates/<crate>`). Every crate is a symlink into the
# real jcode checkout EXCEPT `jcode-sdk`, which points at our shim
# (apps/desktop-shim/jcode-sdk). That swap is how apps/desktop runs on
# freecode's backend without a single edit to the upstream subtree — see
# docs/specs/2026-10-26-jcode-sdk-shim-contract.md.
#
# The crates come from vendor/jcode — the pinned jcode crates the desktop
# builds, committed in this repo (vendor/README.md), so a build never fetches
# jcode. $JCODE_UPSTREAM points at a full jcode checkout instead, for working
# against a newer upstream. apps/jcode itself is regenerated on every run, so
# never edit inside it.
set -euo pipefail
cd "$(dirname "$0")/.."

upstream="${JCODE_UPSTREAM:-vendor/jcode}"
if [ ! -d "$upstream/crates/jcode-harness-api" ]; then
  echo "No jcode crates at $upstream (vendor/jcode, or \$JCODE_UPSTREAM)." >&2
  exit 1
fi
upstream="$(cd "$upstream" && pwd -P)"

# Releases build against the jcode commit pinned in apps/desktop-shim/JCODE_REV
# (vendor/jcode/REV records what is vendored). A checkout elsewhere builds, but
# say so: it is not what users get.
pinned="$(cat apps/desktop-shim/JCODE_REV)"
current="$(cat "$upstream/REV" 2>/dev/null || git -C "$upstream" rev-parse HEAD 2>/dev/null || echo unknown)"
if [ "$current" != "$pinned" ]; then
  echo "note: jcode checkout is at ${current:0:12}, releases pin ${pinned:0:12} (apps/desktop-shim/JCODE_REV)" >&2
fi

rm -rf apps/jcode
mkdir -p apps/jcode/crates
for crate in "$upstream"/crates/*/; do
  name="$(basename "$crate")"
  [ "$name" = jcode-sdk ] && continue
  ln -s "${crate%/}" "apps/jcode/crates/$name"
done
ln -s ../../desktop-shim/jcode-sdk apps/jcode/crates/jcode-sdk
