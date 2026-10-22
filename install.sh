#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Install or remove the Recoll file search extension for Cinnamon.
#   ./install.sh            install and enable
#   ./install.sh --remove   disable and remove
#
# The extension itself installs and enables the search provider when it is
# enabled, and removes it again when it is disabled.
set -e

UUID="recoll-search@mittelerde.ch"
SRC="$(cd "$(dirname "$0")" && pwd)/files/$UUID"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/cinnamon/extensions/$UUID"

# Add or remove the uuid in org.cinnamon enabled-extensions,
# keeping any other extensions that are already enabled.
update_key() {
    python3 - "$1" "$UUID" <<'EOF'
import ast, subprocess, sys
action, uuid = sys.argv[1], sys.argv[2]
cur = subprocess.check_output(
    ["gsettings", "get", "org.cinnamon", "enabled-extensions"], text=True).strip()
lst = [] if cur.startswith("@as") else ast.literal_eval(cur)
if action == "add" and uuid not in lst:
    lst.append(uuid)
if action == "remove":
    lst = [u for u in lst if u != uuid]
subprocess.check_call(
    ["gsettings", "set", "org.cinnamon", "enabled-extensions", str(lst)])
print("enabled-extensions =", lst)
EOF
}

if [ "$1" = "--remove" ]; then
    update_key remove
    sleep 1   # let Cinnamon run disable(), which removes the provider
    rm -rf "$DEST"
    echo "Removed $DEST"
    exit 0
fi

command -v recollq >/dev/null || echo "Warning: recollq not found (package 'recollcmd')."

# Disable first, so that reinstalling reloads the new code.
update_key remove >/dev/null
sleep 1
rm -rf "$DEST"
mkdir -p "$(dirname "$DEST")"
cp -r "$SRC" "$DEST"
echo "Installed to $DEST"
update_key add
echo "Done. Open the menu and type at least 3 characters."
echo "Settings: System Settings > Extensions > Recoll file search."
