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
- Right-click: go to space, new space from recipe / plain / Claude / Codex, create or edit the
  launch recipe (nvim), reveal in Finder, copy path.
- Filter box; list refreshes every 30 s and with ↻. Folded sidebar: initials with status dots.

### Launch recipes: `<project>/.herdr.json`

Opening a project with no space yet builds the space the recipe describes (a layers icon on the
row marks projects that have one). `defaultRecipe` in `config/mods/projects/config.json` applies
to projects without their own.

```json
{ "name": "optional space name",
  "tabs": [
    { "name": "dev", "panes": [
        { "argv": ["claude"], "task": "optional first message" },
        { "argv": ["pnpm", "dev"], "split": "right" },
        { "mod": "devservers", "split": "down", "of": 1 } ] },
    { "name": "git", "panes": [{ "argv": ["lazygit"] }] } ] }
```

A pane without `argv`/`mod` is a shell; `split` is `right` (default) or `down`; `of` is the index
of the pane to split (default: the previous one). The first tab's first pane must be a terminal.

## Other mods

| Mod | Where | What |
|---|---|---|
| `agent-board` | window, `cmd-shift-a` | every agent by urgency: time in status, context used (parsed from the screen), rtk savings, pin/peek, jump to oldest waiting |
| `attention` | floating drawer, bottom right of the work area | only while agents are blocked/done; click to go there |
| `devservers` | right panel **Dev**, `cmd-shift-k` | listening ports and Docker containers of the space's project (or all): open, kill, start/stop/restart, logs, shell, compose up/down |
| `project-notes` | right panel **Notes**, `cmd-shift-u` | claude-mem observations for the project (worker API, SQLite fallback) and CLAUDE.md / AGENTS.md view + editor |
| `machines` | right panel **Machines**, `cmd-shift-m` | this Mac and `hc machine ls`: load, memory, disk, uptime, containers; login in a terminal, new space there, update hc |
| `panel-buttons` | tab bar | Dev / Notes / Machines toggles, remembered per space |

Other keys: `cmd-shift-j` shows the Projects tab.
