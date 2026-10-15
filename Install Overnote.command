#!/bin/bash
# Installs Overnote into Raycast. Double-click this file in Finder; Terminal opens and runs it.
#
# In an unzipped release, it first offers to move the folder to ~/Applications/Overnote, where
# Check for Updates and `npm run update-extension` expect it to stay. Then it runs
# scripts/install-extension.sh (the same as `npm run install-extension`), passing on any
# arguments, and keeps the window open until Return so the result stays readable.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
TARGET="$HOME/Applications/Overnote"
INTERACTIVE=0
[[ -t 0 && -t 1 ]] && INTERACTIVE=1

# A Terminal window opened from Finder may not have the shell setup that puts Node on PATH.
for dir in /opt/homebrew/bin /usr/local/bin "$HOME/.volta/bin" "$HOME/.local/bin"; do
  [[ -d "$dir" && ":$PATH:" != *":$dir:"* ]] && PATH="$PATH:$dir"
done
export PATH

finish() {
  local status="$1"
  if ((INTERACTIVE)); then
    echo
    read -r -p "Press Return to close this window. " _ || true
  fi
  exit "$status"
}

say() { printf '[Overnote] %s\n' "$*"; }

# Without a terminal (scripts, the release check), it never prompts and never moves the folder.
if ((INTERACTIVE)) && [[ -f "$HERE/assets/prebuilt.json" && "$HERE" != "$TARGET" ]]; then
  if [[ -e "$TARGET" ]]; then
    say "Overnote is already installed in $TARGET."
    say "To update it, run Check for Updates in Raycast, or in Terminal:"
    say "  cd '$TARGET' && npm run update-extension"
    say "To install from this folder instead, remove $TARGET first and open this file again."
    finish 1
  fi
  read -r -p "[Overnote] Move this folder to $TARGET first (recommended)? [Y/n] " answer || answer="n"
  if [[ ! "$answer" =~ ^[Nn] ]]; then
    mkdir -p "$(dirname "$TARGET")" && mv "$HERE" "$TARGET" || {
      say "Could not move the folder to $TARGET."
      finish 1
    }
    HERE="$TARGET"
    say "Moved to $TARGET."
  else
    say "Installing from $HERE. Keep this folder here; updates run in it."
  fi
fi

cd "$HERE" || finish 1
bash scripts/install-extension.sh "$@"
finish $?
