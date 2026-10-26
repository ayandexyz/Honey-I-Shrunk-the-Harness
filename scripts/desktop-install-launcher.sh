#!/usr/bin/env bash
# Install a per-user "Honey" launcher for the desktop app (apps/desktop):
# ~/.local/share/applications/honey.desktop + the Honey icon. Wayland
# compositors and app launchers find a window's icon through a .desktop entry
# whose name matches its app id (`honey`), which a dev `pnpm desktop` run never
# installs. The entry runs this checkout's `pnpm desktop` script.
#
# Remove with: bash scripts/desktop-install-launcher.sh --uninstall
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd -P)"
apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
icons="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/1024x1024/apps"

if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$apps/honey.desktop" "$icons/honey.png"
  echo "Removed the Honey launcher."
  exit 0
fi

mkdir -p "$apps" "$icons"
install -m644 "$repo/apps/desktop/assets/app-icon/icon-1024.png" "$icons/honey.png"
cat > "$apps/honey.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Honey
Comment=Native desktop client for freecode
Exec=bash $repo/scripts/desktop.sh
Icon=honey
Terminal=false
Categories=Development;Utility;
StartupNotify=true
StartupWMClass=honey
EOF
command -v update-desktop-database >/dev/null && update-desktop-database -q "$apps" || true
command -v gtk-update-icon-cache >/dev/null &&
  gtk-update-icon-cache -q -t "${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor" || true
echo "Installed $apps/honey.desktop"
