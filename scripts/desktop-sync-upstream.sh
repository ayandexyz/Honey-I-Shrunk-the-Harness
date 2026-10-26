#!/usr/bin/env bash
# Pull upstream jcode-desktop into apps/desktop (the Honey desktop frontend)
# without fighting our changes. Steps, each committed so a failure leaves a
# clean, resumable state:
#
#   1. revert the Honey text rename (scripts/desktop-rebrand.py), so upstream
#      lines match theirs and the pull cannot conflict on wording
#   2. git subtree pull --prefix=apps/desktop jcode-desktop-upstream <branch>
#   3. re-apply the rename (also renames any new upstream strings)
#   4. build against the jcode-sdk shim: a compile error here means upstream
#      now uses SDK API the shim does not have yet — add it to
#      apps/desktop-shim/jcode-sdk (spec docs/specs/2026-10-26-jcode-sdk-shim-contract.md)
#
# Usage: bash scripts/desktop-sync-upstream.sh [--branch main] [--remote NAME] [--no-build] [--dry-run]
# A conflict in step 2 stops the script: resolve it, `git commit`, then run
# `python3 scripts/desktop-rebrand.py apply` and commit (steps 3–4 by hand).
set -euo pipefail
cd "$(dirname "$0")/.."

remote=jcode-desktop-upstream
url=https://github.com/1jehuang/jcode-desktop.git
branch=main
build=1
dry=0
while [ $# -gt 0 ]; do
  case "$1" in
    --branch) branch="$2"; shift 2 ;;
    --remote) remote="$2"; shift 2 ;;
    --no-build) build=0; shift ;;
    --dry-run) dry=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

git remote get-url "$remote" >/dev/null 2>&1 || git remote add "$remote" "$url"
git fetch -q "$remote" "$branch"

# Where apps/desktop last synced: the newest subtree merge's split commit.
last=$(git log --format=%b --grep="git-subtree-dir: apps/desktop" |
  sed -n 's/^git-subtree-split: //p' | head -1)
new=$(git rev-list --count "${last}..${remote}/${branch}")
echo "apps/desktop is at ${last:0:12}; ${remote}/${branch} has ${new} new commit(s)."
if [ "$new" -eq 0 ]; then
  echo "Already up to date."
  exit 0
fi
git log --format='  %h %ad %s' --date=short "${last}..${remote}/${branch}" | head -20
[ "$dry" -eq 1 ] && exit 0

# apps/desktop/Cargo.lock is re-resolved against the local jcode checkout on
# every build; it is regenerated, never meaningful local work.
git checkout -q -- apps/desktop/Cargo.lock 2>/dev/null || true
if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree is not clean; commit or stash first:" >&2
  git status --short >&2
  exit 1
fi

python3 scripts/desktop-rebrand.py revert
if [ -n "$(git status --porcelain)" ]; then
  git commit -q -am "desktop: revert Honey rebrand for upstream pull"
fi

if ! git subtree pull --prefix=apps/desktop "$remote" "$branch" \
  -m "Merge upstream jcode-desktop ${branch} into apps/desktop"; then
  echo >&2
  echo "Upstream merge has conflicts (in our hooks or Honey identity lines)." >&2
  echo "Resolve them, git commit, then: python3 scripts/desktop-rebrand.py apply && git commit -am 'desktop: re-apply Honey rebrand'" >&2
  exit 1
fi

python3 scripts/desktop-rebrand.py apply
if [ -n "$(git status --porcelain)" ]; then
  git commit -q -am "desktop: re-apply Honey rebrand"
fi

jcode="$(cd apps/jcode-upstream 2>/dev/null && pwd -P || true)"
if [ -n "$jcode" ] && git -C "$jcode" rev-parse -q --verify '@{u}' >/dev/null; then
  git -C "$jcode" fetch -q
  behind=$(git -C "$jcode" rev-list --count 'HEAD..@{u}')
  [ "$behind" -gt 0 ] && echo "Note: your jcode checkout ($jcode) is $behind commit(s) behind; upstream desktop changes often need its matching crates — pull it too."
fi

if [ "$build" -eq 1 ]; then
  bash scripts/desktop-overlay.sh
  echo "Building against the jcode-sdk shim…"
  if ! (cd apps/desktop && CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-4}" CARGO_PROFILE_DEV_DEBUG=0 \
    cargo build -q -p jcode-desktop); then
    echo >&2
    echo "Build failed: upstream likely uses jcode-sdk API the shim lacks." >&2
    echo "Add the missing items to apps/desktop-shim/jcode-sdk, then rebuild." >&2
    exit 1
  fi
  echo "Build OK."
fi
echo "Synced. Review the merge, run 'pnpm desktop', then push."
