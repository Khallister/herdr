# Herdr config

My [Herdr](https://herdr.dev) app setup: layout `main-skillshare` with a **Spaces | Projects** sidebar,
the skillshare panel, keys and settings, plus scripts to put it on any Mac.

## New machine

```sh
curl -fsSL https://raw.githubusercontent.com/Khallister/herdr/main/install.sh | bash
# or
git clone https://github.com/Khallister/herdr.git ~/Projects/herdr && ~/Projects/herdr/install.sh
```

`install.sh` (safe to rerun) installs Homebrew if missing, the Herdr app + herdr-core
(official installer, Apple Silicon), `skillshare` (homebrew-core) and `skillshare-app`
(`runkids/tap`, after `brew trust --cask runkids/tap/skillshare-app`), then applies the config
and switches Herdr to the saved layout. `--no-skillshare-app`, `--no-config` skip parts.

## Keeping machines in sync

```sh
./sync.sh push      # this machine's config -> repo, commit, push
./sync.sh pull      # repo -> this machine (old files backed up to ~/.config/herdr-app/.backup/<time>)
./sync.sh diff      # what differs
./sync.sh collect   # like push, without git
```

Synced: `settings.json`, `keys.json`, `programs.json`, and only personal layouts, themes and mods.
Herdr's shipped ones (rewritten by the app on every start, listed in `installed.json`) and per-machine
state (`view.json`, `shared.json`, `layouts/.state`, windows, telemetry) stay out; generated
`*.d.ts` / `jsconfig.json` too. Copies, not symlinks: Herdr writes some files itself.

## Projects panel (`config/mods/projects`)

A tab next to Spaces in the left sidebar listing every folder under the projects root.

- Root: `config/mods/projects/config.json` → `{"root": "~/Projects"}` (`~` expands per machine),
  or ⚙ in the panel to pick a folder (writes that file; `./sync.sh push` to keep it).
- Click a project: jumps to the space already working there (dot = open, colored by its agents'
  status), else opens a new space with a terminal in that folder.
- Claude icon on a row: a new space running `claude` there.
- Filter box; list refreshes every 30 s and with ↻.
