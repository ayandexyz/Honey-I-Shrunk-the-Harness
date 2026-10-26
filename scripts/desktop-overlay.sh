#!/usr/bin/env bash
# Build the apps/jcode overlay that apps/desktop's Cargo.toml path-deps resolve
# against (`../../../jcode/crates/<crate>`). Every crate is a symlink into the
# real jcode checkout EXCEPT `jcode-sdk`, which points at our shim
# (apps/desktop-shim/jcode-sdk). That swap is how apps/desktop runs on
# freecode's backend without a single edit to the upstream subtree — see
# docs/specs/2026-10-26-jcode-sdk-shim-contract.md.
#
# The real checkout is found via $JCODE_UPSTREAM, else the apps/jcode-upstream
# symlink (gitignored, machine-specific). apps/jcode itself is regenerated on
# every run, so never edit inside it.
set -euo pipefail
cd "$(dirname "$0")/.."

# Migrate the old layout, where apps/jcode WAS the symlink to the checkout.
if [ -L apps/jcode ] && [ ! -e apps/jcode-upstream ]; then
  mv apps/jcode apps/jcode-upstream
fi

upstream="${JCODE_UPSTREAM:-apps/jcode-upstream}"
if [ ! -d "$upstream/crates/jcode-harness-api" ]; then
  echo "No jcode checkout found. Point apps/jcode-upstream at one:" >&2
  echo "  ln -s /path/to/your/jcode apps/jcode-upstream" >&2
  echo "(or set JCODE_UPSTREAM). It's gitignored — every machine uses its own." >&2
  exit 1
fi
upstream="$(cd "$upstream" && pwd -P)"

rm -rf apps/jcode
mkdir -p apps/jcode/crates
for crate in "$upstream"/crates/*/; do
  name="$(basename "$crate")"
  [ "$name" = jcode-sdk ] && continue
  ln -s "${crate%/}" "apps/jcode/crates/$name"
done
ln -s ../../desktop-shim/jcode-sdk apps/jcode/crates/jcode-sdk
