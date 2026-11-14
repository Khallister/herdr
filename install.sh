#!/usr/bin/env bash
# Bootstrap a Mac with Herdr and this configuration. Safe to run again.
#
#   git clone https://github.com/Khallister/herdr.git ~/Projects/herdr && ~/Projects/herdr/install.sh
#   or:  curl -fsSL https://raw.githubusercontent.com/Khallister/herdr/main/install.sh | bash
#
# Options: --no-skillshare-app  skip the skillshare desktop app (cask from runkids/tap)
#          --no-config          install programs only, don't apply the configuration
set -euo pipefail

REPO_URL="https://github.com/Khallister/herdr.git"
CLONE_DIR="${HERDR_CONFIG_DIR:-$HOME/Projects/herdr}"
WITH_APP=1; WITH_CONFIG=1
for a in "$@"; do
  case "$a" in
    --no-skillshare-app) WITH_APP=0 ;;
    --no-config) WITH_CONFIG=0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || fail "this script is for macOS"
[ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = 1 ] || fail "Herdr releases need Apple Silicon"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

# 1. Homebrew
if ! command -v brew >/dev/null 2>&1; then
  say "installing Homebrew"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  eval "$(/opt/homebrew/bin/brew shellenv)"
fi
command -v git >/dev/null 2>&1 || brew install git

# 2. This repo (when run through curl | bash)
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [ -n "$SELF_DIR" ] && [ -f "$SELF_DIR/sync.sh" ]; then
  REPO="$SELF_DIR"
else
  if [ -d "$CLONE_DIR/.git" ]; then git -C "$CLONE_DIR" pull --ff-only; else git clone "$REPO_URL" "$CLONE_DIR"; fi
  REPO="$CLONE_DIR"
fi

# 3. Herdr (the desktop app + herdr-core). Not `brew install herdr`: that formula is the terminal multiplexer, another program.
if [ -d "$HOME/Applications/Herdr.app" ] || [ -d /Applications/Herdr.app ] || command -v herdr-app >/dev/null 2>&1; then
  say "Herdr already installed"
else
  say "installing Herdr"
  curl -fsSL https://releases.herdr.dev/app/install.sh | sh
fi
command -v hc >/dev/null 2>&1 || warn "herdr-core (hc) not found yet; Herdr offers it on first start"

# 4. skillshare CLI (homebrew-core) and, optionally, its app from runkids/tap (needs brew trust)
if command -v skillshare >/dev/null 2>&1; then say "skillshare already installed"; else say "installing skillshare"; brew install skillshare; fi
if [ "$WITH_APP" = 1 ]; then
  if brew list --cask skillshare-app >/dev/null 2>&1; then
    say "skillshare-app already installed"
  else
    brew tap runkids/tap
    if brew help trust >/dev/null 2>&1; then
      say "trusting runkids/tap/skillshare-app (third-party tap)"
      brew trust --cask runkids/tap/skillshare-app
    fi
    say "installing skillshare-app"
    brew install --cask runkids/tap/skillshare-app
  fi
fi

# 5. The configuration
if [ "$WITH_CONFIG" = 1 ]; then
  say "applying Herdr configuration from $REPO"
  bash "$REPO/sync.sh" pull
fi

if ! pgrep -xq Herdr; then
  say "starting Herdr"
  open -a Herdr 2>/dev/null || open "$HOME/Applications/Herdr.app" 2>/dev/null || warn "open Herdr yourself"
  if [ "$WITH_CONFIG" = 1 ] && [ -f "$REPO/active-layout" ]; then
    for _ in $(seq 30); do herdr-app status >/dev/null 2>&1 && break; sleep 1; done
    herdr-app do layout.switch --name "$(cat "$REPO/active-layout")" >/dev/null 2>&1 \
      && say "layout: $(cat "$REPO/active-layout")" || warn "switch the layout with cmd-shift-l"
  fi
fi
say "done. Later: ./sync.sh push (save this machine's config), ./sync.sh pull (apply the repo's)"
