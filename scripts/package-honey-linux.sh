#!/usr/bin/env bash
# Package Honey (apps/desktop on freecode core) for Linux:
#   out/honey/Honey-<version>-linux-<arch>.tar.gz   (portable, extract and run ./honey)
#   out/honey/Honey-<version>-linux-<debarch>.deb   (when dpkg-deb exists)
#   out/honey/SHA256SUMS-linux[-aarch64]
#
# One package = one desktop build + one exact freecode core, upgraded
# together. Core rides beside the desktop binary, where the jcode-sdk shim
# looks first (`bundled_core`), with the sidecars the CLI release ships:
# onnxruntime libs (memory graph) and ripgrep (the grep tool).
#
# Usage: bash scripts/package-honey-linux.sh <version> [--profile release|dev]
# Plan: docs/specs/2026-10-27-honey-desktop-release.md
set -euo pipefail
cd "$(dirname "$0")/.."
root="$PWD"

version="${1:?usage: package-honey-linux.sh <version> [--profile release|dev]}"
profile=release
[ "${2:-}" = "--profile" ] && profile="${3:?--profile needs a value}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-beta\.[0-9]+)?$ ]] ||
  { echo "error: version must look like 0.1.0 or 0.1.0-beta.1" >&2; exit 1; }

case "$(uname -m)" in
  x86_64) arch=x86_64 deb_arch=amd64 bun_target=bun-linux-x64 rg_triple=x86_64-unknown-linux-musl sums=SHA256SUMS-linux ;;
  aarch64|arm64) arch=aarch64 deb_arch=arm64 bun_target=bun-linux-arm64 rg_triple=aarch64-unknown-linux-musl sums=SHA256SUMS-linux-aarch64 ;;
  *) echo "error: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac
rg_version=15.2.0 # keep in step with .github/workflows/release.yml

out="$root/out/honey"
name="Honey-$version-linux-$arch"
stage="$out/$name"
rm -rf "$stage" && mkdir -p "$stage"

echo "== freecode core ($bun_target)"
pnpm --filter @thisisayande/freecode-shared build >/dev/null
pnpm --filter @thisisayande/freecode-core build >/dev/null
FREECODE_BUN_TARGET="$bun_target" FREECODE_BUN_OUTFILE="$stage/freecode" node scripts/build-bun.mjs
# Only the soname core's onnxruntime addon loads. The versioned duplicate and
# the GPU-provider library vary by release and architecture, and the updater
# accepts only a fixed file list (see the check below).
rm -f "$stage"/libonnxruntime.so.1.* "$stage"/libonnxruntime_providers_shared.so
rg_pkg="ripgrep-$rg_version-$rg_triple"
curl -fsSL "https://github.com/BurntSushi/ripgrep/releases/download/$rg_version/$rg_pkg.tar.gz" |
  tar -xz -C "$stage" --strip-components=1 "$rg_pkg/rg"

echo "== desktop ($profile)"
bash scripts/desktop-overlay.sh
cargo_dir=$([ "$profile" = release ] && echo release || echo debug)
(cd apps/desktop &&
  JCODE_DESKTOP_VERSION="$version" CARGO_PROFILE_DEV_DEBUG=0 \
    cargo build --locked --profile "$profile" -p jcode-desktop)
install -m755 "apps/desktop/target/$cargo_dir/jcode-desktop" "$stage/"
# A script, not a symlink: the updater refuses links inside an archive.
cat > "$stage/honey" <<'EOF'
#!/bin/sh
# Honey launcher: runs the desktop binary that sits next to this script.
exec "$(dirname "$(readlink -f "$0")")/jcode-desktop" "$@"
EOF
chmod 755 "$stage/honey"
install -m644 apps/desktop/assets/app-icon/icon-1024.png "$stage/honey.png"
cat > "$stage/honey.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=Honey
Comment=Native desktop client for freecode
Exec=honey
Icon=honey
Terminal=false
Categories=Development;Utility;
StartupNotify=true
StartupWMClass=honey
EOF

# The in-app updater (crates/jcode-desktop-updater/src/archive.rs UNIX_FILES)
# accepts an archive only if it holds exactly these files. Never ship one it
# would reject: installed copies could not update past it.
expected="$(sed -n '/^pub const UNIX_FILES/,/^];/p' \
  apps/desktop/crates/jcode-desktop-updater/src/archive.rs | grep -o '"[^"]*"' | tr -d '"' | sort)"
actual="$(ls -A "$stage" | sort)"
if [ "$expected" != "$actual" ]; then
  echo "error: package files differ from the updater's UNIX_FILES:" >&2
  diff <(echo "$expected") <(echo "$actual") >&2 || true
  exit 1
fi

# Fail before archiving if the bundle cannot even report its version.
"$stage/jcode-desktop" --version | grep -q "v$version" ||
  { echo "error: packaged binary does not report v$version" >&2; exit 1; }

tar -C "$out" -czf "$out/$name.tar.gz" "$name"
artifacts=("$name.tar.gz")

if command -v dpkg-deb >/dev/null; then
  deb="$out/deb-$arch"
  rm -rf "$deb"
  mkdir -p "$deb/DEBIAN" "$deb/usr/lib/honey" "$deb/usr/bin" \
    "$deb/usr/share/applications" "$deb/usr/share/icons/hicolor/1024x1024/apps"
  cp -a "$stage/." "$deb/usr/lib/honey/"
  rm "$deb/usr/lib/honey/"{honey,honey.png,honey.desktop}
  ln -s ../lib/honey/jcode-desktop "$deb/usr/bin/honey"
  install -m644 "$stage/honey.desktop" "$deb/usr/share/applications/honey.desktop"
  install -m644 "$stage/honey.png" "$deb/usr/share/icons/hicolor/1024x1024/apps/honey.png"
  cat > "$deb/DEBIAN/control" <<EOF
Package: honey
Version: $version
Architecture: $deb_arch
Maintainer: Ayan De <deayan252@gmail.com>
Section: devel
Priority: optional
Description: Honey, the native desktop client for freecode
 A GPU-accelerated desktop frontend (from jcode-desktop, MIT) running on
 the freecode agent core, which is bundled.
EOF
  dpkg-deb --root-owner-group --build "$deb" "$out/Honey-$version-linux-$deb_arch.deb" >/dev/null
  artifacts+=("Honey-$version-linux-$deb_arch.deb")
else
  echo "note: dpkg-deb not found, skipping the .deb (CI builds it)" >&2
fi

(cd "$out" && sha256sum "${artifacts[@]}" > "$sums")
echo "== done"
(cd "$out" && ls -la "${artifacts[@]}" "$sums")
