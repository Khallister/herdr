#!/usr/bin/env bash
# Sync a Herdr app configuration between this repo and ~/.config/herdr-app.
#
#   ./sync.sh pull    repo -> local  (backs up what it replaces, reloads Herdr live)
#   ./sync.sh push    local -> repo, then git commit + push
#   ./sync.sh collect local -> repo, no git
#   ./sync.sh diff    show what differs between repo and local
#
# What is synced: settings.json, keys.json, programs.json, and only YOUR layouts, themes
# and mods. Herdr's shipped ones (replaced by the app on every start) and machine state
# (view.json, shared.json, layouts/.state, window*.json, data/, telemetry/) are left out.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$REPO/config"
HOME_DIR="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"

SHIPPED_LAYOUTS="main terminals win98"
SHIPPED_THEMES="atom-one-dark win98"
FILES="settings.json keys.json programs.json"
EXCLUDES=(--exclude '*.d.ts' --exclude 'jsconfig.json' --exclude '*.error' --exclude '.DS_Store'
          --exclude 'node_modules' --exclude '.*')

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }

in_list() { local x="$1"; shift; for i in $*; do [ "$i" = "$x" ] && return 0; done; return 1; }

# Mods Herdr ships, from its own installed.json (falls back to "none known").
shipped_mods() {
  [ -f "$HOME_DIR/installed.json" ] || return 0
  /usr/bin/python3 -c 'import json,sys; print("\n".join(json.load(open(sys.argv[1])).keys()))' \
    "$HOME_DIR/installed.json" 2>/dev/null || true
}

# Personal items present in a config tree ($1): relative paths, one per line.
personal_items() {
  local root="$1" shipped name f
  shipped="$(shipped_mods | tr '\n' ' ')"
  for f in $FILES; do [ -f "$root/$f" ] && echo "$f"; done
  for f in "$root"/layouts/*.json; do
    [ -f "$f" ] || continue; name="$(basename "$f" .json)"
    in_list "$name" "$SHIPPED_LAYOUTS" && continue
    echo "layouts/$name.json"
    for ext in svg png; do [ -f "$root/layouts/$name.$ext" ] && echo "layouts/$name.$ext"; done
  done
  for f in "$root"/themes/*.json; do
    [ -f "$f" ] || continue; name="$(basename "$f" .json)"
    in_list "$name" "$SHIPPED_THEMES" || echo "themes/$name.json"
  done
  for f in "$root"/mods/*/; do
    [ -d "$f" ] || continue; name="$(basename "$f")"
    in_list "$name" "$shipped" || echo "mods/$name/"
  done
}

copy_item() { # copy_item <from-root> <to-root> <rel> [--delete]
  local from="$1" to="$2" rel="$3"; shift 3
  if [ "${rel%/}" != "$rel" ]; then
    mkdir -p "$to/$rel"
    rsync -a "$@" "${EXCLUDES[@]}" "$from/$rel" "$to/$rel"
  else
    mkdir -p "$(dirname "$to/$rel")"
    cp -p "$from/$rel" "$to/$rel"
  fi
}

active_layout() {
  /usr/bin/python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("layout",""))' \
    "$HOME_DIR/shared.json" 2>/dev/null || true
}

collect() {
  [ -d "$HOME_DIR" ] || { warn "no $HOME_DIR"; exit 1; }
  local tmp; tmp="$(mktemp -d)"
  personal_items "$HOME_DIR" > "$tmp/items"
  rm -rf "$SRC"; mkdir -p "$SRC"
  while read -r rel; do copy_item "$HOME_DIR" "$SRC" "$rel" --delete; say "collected $rel"; done < "$tmp/items"
  local layout; layout="$(active_layout)"
  [ -n "$layout" ] && echo "$layout" > "$REPO/active-layout"
  rm -rf "$tmp"
}

pull() {
  [ -d "$SRC" ] || { warn "nothing to apply: $SRC is missing"; exit 1; }
  mkdir -p "$HOME_DIR"
  local stamp backup; stamp="$(date +%Y%m%d-%H%M%S)"; backup="$HOME_DIR/.backup/$stamp"
  local tmp; tmp="$(mktemp -d)"
  personal_items "$SRC" > "$tmp/items"
  while read -r rel; do
    if [ -e "$HOME_DIR/$rel" ]; then copy_item "$HOME_DIR" "$backup" "$rel"; fi
    copy_item "$SRC" "$HOME_DIR" "$rel" --delete
    say "applied $rel"
  done < "$tmp/items"
  rm -rf "$tmp"
  [ -d "$backup" ] && say "previous versions kept in $backup"

  if command -v herdr-app >/dev/null 2>&1; then
    for m in "$SRC"/mods/*/; do
      [ -d "$m" ] || continue
      herdr-app check "$HOME_DIR/mods/$(basename "$m")" >/dev/null 2>&1 \
        && say "check ok: $(basename "$m")" || warn "check failed: $(basename "$m") (run: herdr-app check $HOME_DIR/mods/$(basename "$m"))"
    done
    if [ -f "$REPO/active-layout" ] && herdr-app status >/dev/null 2>&1; then
      herdr-app do layout.switch --name "$(cat "$REPO/active-layout")" >/dev/null && say "layout: $(cat "$REPO/active-layout")"
    fi
  fi
  [ -f "$REPO/active-layout" ] && ! herdr-app status >/dev/null 2>&1 && \
    say "Herdr isn't running: pick layout \"$(cat "$REPO/active-layout")\" with cmd-shift-l (or herdr-app do layout.switch --name $(cat "$REPO/active-layout"))"
  return 0
}

diff_all() {
  local tmp; tmp="$(mktemp -d)"
  { personal_items "$SRC"; personal_items "$HOME_DIR"; } | sort -u > "$tmp/items"
  while read -r rel; do
    diff -rq "${EXCLUDES[@]/--exclude/-x}" "$SRC/$rel" "$HOME_DIR/$rel" 2>&1 | sed "s|$HOME|~|g" || true
  done < "$tmp/items"
  rm -rf "$tmp"
}

case "${1:-}" in
  pull) pull ;;
  collect) collect ;;
  push)
    collect
    cd "$REPO"
    git add -A
    if git diff --cached --quiet; then say "nothing changed"; exit 0; fi
    git commit -q -m "${2:-sync: herdr config from $(hostname -s)}"
    git push -u origin HEAD
    ;;
  diff) diff_all ;;
  *) sed -n '2,12p' "$0"; exit 1 ;;
esac
