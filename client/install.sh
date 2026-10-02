#!/bin/sh
# Alveare installer for macOS and Linux.
#   From GitHub:     curl -fsSL https://raw.githubusercontent.com/AGHEORONO/alveare/main/client/install.sh | sh
#   From a hive:     curl -fsSL http://HOST:4747/install.sh | sh -s -- HOST:4747 JOINCODE
# With HOST and JOINCODE it also joins that hive from the current directory (your project repo).
set -eu

HOST="${1:-}"
CODE="${2:-}"
REPO="AGHEORONO/alveare"
DIR="${ALVEARE_HOME:-$HOME/.alveare}/bin"

case "$(uname -s)" in
  Darwin) os=macos ;;
  Linux) os=linux ;;
  *) echo "Unsupported OS: $(uname -s). Use install.ps1 on Windows." >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=x64 ;;
  *) echo "Unsupported CPU: $(uname -m)" >&2; exit 1 ;;
esac
asset="alveare-$os-$arch"

mkdir -p "$DIR"
tmp="$DIR/.alveare.download"
got=""
if [ -n "$HOST" ]; then
  echo "→ downloading $asset from the hive at $HOST"
  if curl -fsSL "http://$HOST/download/$asset" -o "$tmp" 2>/dev/null; then got=1; fi
fi
if [ -z "$got" ]; then
  echo "→ downloading $asset from GitHub releases"
  curl -fsSL "https://github.com/$REPO/releases/latest/download/$asset" -o "$tmp"
fi
chmod +x "$tmp"
mv "$tmp" "$DIR/alveare"
# macOS: binaries downloaded with curl are not quarantined, but clear it just in case.
if [ "$os" = macos ]; then xattr -d com.apple.quarantine "$DIR/alveare" 2>/dev/null || true; fi
echo "✓ installed $DIR/alveare ($("$DIR/alveare" version))"

case ":$PATH:" in
  *":$DIR:"*) ;;
  *)
    for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile"; do
      if [ -f "$rc" ] || [ "$rc" = "$HOME/.profile" ]; then
        grep -qs 'alveare/bin' "$rc" || printf '\nexport PATH="%s:$PATH"\n' "$DIR" >> "$rc"
      fi
    done
    echo "✓ added $DIR to PATH (open a new terminal to use 'alveare' everywhere)"
    ;;
esac

if [ -n "$HOST" ] && [ -n "$CODE" ]; then
  echo
  # Reattach stdin to the terminal so the client picker can ask questions when piped from curl.
  if [ -t 1 ] && [ -r /dev/tty ]; then
    "$DIR/alveare" join "$HOST" --code "$CODE" < /dev/tty
  else
    "$DIR/alveare" join "$HOST" --code "$CODE"
  fi
fi
