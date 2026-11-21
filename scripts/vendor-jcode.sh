#!/usr/bin/env bash
# Refresh vendor/jcode from a jcode checkout (vendor/README.md). Re-copies the
# crates already vendored — add a name to vendor/jcode/crates (mkdir) first if
# an upstream desktop change needs a new one — plus the one file outside the
# crates they include, and records the checkout's commit.
#
#   bash scripts/vendor-jcode.sh /path/to/jcode
set -euo pipefail
cd "$(dirname "$0")/.."

src="${1:?usage: vendor-jcode.sh /path/to/jcode-checkout}"
src="$(cd "$src" && pwd -P)"
rev="$(git -C "$src" rev-parse HEAD)"
[ -z "$(git -C "$src" status --porcelain)" ] || { echo "$src has local changes" >&2; exit 1; }

for dir in vendor/jcode/crates/*/; do
  name="$(basename "$dir")"
  [ -d "$src/crates/$name" ] || { echo "upstream has no crates/$name" >&2; exit 1; }
  rm -rf "vendor/jcode/crates/$name"
  cp -r --dereference "$src/crates/$name" vendor/jcode/crates/
  rm -rf "vendor/jcode/crates/$name/target"
done
cp "$src/docs/kagi-web-search.md" vendor/jcode/docs/
cp "$src/LICENSE" vendor/jcode/LICENSE
echo "$rev" > vendor/jcode/REV
echo "$rev" > apps/desktop-shim/JCODE_REV
echo "vendor/jcode now at ${rev:0:12}. Rebuild: bash scripts/desktop-overlay.sh && (cd apps/desktop && cargo build -p jcode-desktop)"
