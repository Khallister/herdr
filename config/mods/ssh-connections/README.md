# SSH Connections

Open: `cmd-shift-h`, or **SSH…** in the Machines panel header (`mod.open ssh-connections`).

- `main.js`: dialog UI (list, add/edit form, diff preview, result, Herdr machine actions).
- `machine.js`: relates ssh aliases to `hc machine ls` entries (pure, tested).
- `bin/sshcm.mjs`: Node helper the dialog runs via `exec` (argv only). Commands: `list`, `plan`, `apply`, `test`, `hostkey`, `keys`.
- `lib/`: lossless ssh_config parser/editor, validation, safe atomic store, OpenSSH runner.
- Tests: `node --test mods/ssh-connections/test/`

## Config strategy

New hosts go to `~/.ssh/herdr/hosts.conf`, included from the first line of `~/.ssh/config`.
ssh takes the first value it reads, so those entries beat later `Host *` defaults; options they
don't set are still inherited (shown as warnings). After every write, `ssh -G <alias>` must show
the requested values, or the result says what overrides them.

Edits: Herdr-managed entries, and single-alias `Host` blocks directly in `~/.ssh/config` with no
duplicated keys. Read-only: multi-pattern Host lines, wildcard/Match blocks, entries in other
included files or conditional includes, aliases declared twice.

Writes: only `~/.ssh/config` and `~/.ssh/herdr/hosts.conf`; no symlinks; read-only files left
alone; backup in `~/.ssh/herdr/backups/` (last 20); temp file + fsync + rename; refused if the file
changed since the preview; OpenSSH validates the candidate (`ssh -G -F`) before it replaces anything.

## Limits

- Needs Node 18+ (found on PATH or in common install folders).
- hc has no connect/disconnect: **Connect** runs `true` on the machine through herdr-core;
  **Forget machine** is `hc machine rm` (terminals there keep running).
- Host keys are never accepted automatically: **Verify and accept in a terminal** runs
  OpenSSH's own prompt. Changed keys are only explained (`ssh-keygen -R` is left to you).
- The system picker only picks folders, so Browse lists key files in the chosen folder.
- Testing unsaved fields uses a temp config with only those settings (`-F`), so it ignores the
  rest of `~/.ssh/config` and `/etc/ssh/ssh_config`.
