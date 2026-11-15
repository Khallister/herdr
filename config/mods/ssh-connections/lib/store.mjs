// Safe writes to the two files Herdr may change: ~/.ssh/config and ~/.ssh/herdr/hosts.conf.
//
// - Only those two paths are accepted (allowedTargets); no symlinks anywhere on the way.
// - Existing file: owner must be us, owner-write bit must be set (a read-only file stays so),
//   its mode is kept. New file: 0600. New directories: 0700.
// - Write to a temp file in the same directory (O_EXCL), fsync, compare the target with the
//   snapshot taken at preview time (concurrent edit detection), then rename over it.
// - A backup of the previous content goes to ~/.ssh/herdr/backups/ (0600) first.

import path from "node:path";
import crypto from "node:crypto";

export const sha = (text) => (text == null ? null : crypto.createHash("sha256").update(text).digest("hex"));

export class StoreError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function paths(home) {
  const ssh = path.join(home, ".ssh");
  const herdr = path.join(ssh, "herdr");
  return { home, ssh, herdr, main: path.join(ssh, "config"), managed: path.join(herdr, "hosts.conf"), backups: path.join(herdr, "backups"), includeArg: "~/.ssh/herdr/hosts.conf" };
}

async function lstatOrNull(fs, p) {
  try { return await fs.lstat(p); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
}

const uid = () => (typeof process.getuid === "function" ? process.getuid() : null);

/** Makes sure `dir` is a real directory we own (creating it 0700 if absent). */
export async function ensureDir(fs, dir) {
  const st = await lstatOrNull(fs, dir);
  if (!st) {
    await fs.mkdir(dir, { mode: 0o700 });
    await fs.chmod(dir, 0o700);
    return { created: true };
  }
  if (st.isSymbolicLink()) throw new StoreError("symlink", `${dir} is a symbolic link; Herdr won't write through it`);
  if (!st.isDirectory()) throw new StoreError("not_dir", `${dir} exists and isn't a folder`);
  if (uid() != null && st.uid !== uid()) throw new StoreError("owner", `${dir} belongs to another user`);
  return { created: false };
}

/** Reads a target file for a snapshot: { text|null, hash|null, mode|null }. Refuses symlinks. */
export async function readTarget(fs, file) {
  const st = await lstatOrNull(fs, file);
  if (!st) return { text: null, hash: null, mode: null };
  if (st.isSymbolicLink()) throw new StoreError("symlink", `${file} is a symbolic link; Herdr won't edit it. Edit the file it points to by hand, or replace the link with a regular file.`);
  if (!st.isFile()) throw new StoreError("not_file", `${file} isn't a regular file`);
  const text = await fs.readFile(file, "utf8");
  return { text, hash: sha(text), mode: st.mode & 0o7777, uid: st.uid };
}

/** Problems that make a target unwritable, without touching it. */
export async function writeProblem(fs, file) {
  const st = await lstatOrNull(fs, file);
  if (!st) return null;
  if (st.isSymbolicLink()) return `${file} is a symbolic link; Herdr won't edit it`;
  if (!st.isFile()) return `${file} isn't a regular file`;
  if (uid() != null && st.uid !== uid()) return `${file} belongs to another user`;
  if ((st.mode & 0o200) === 0) return `${file} is read-only (mode ${(st.mode & 0o777).toString(8)}); Herdr leaves it unchanged`;
  return null;
}

export function assertAllowed(file, home) {
  const p = paths(home);
  const n = path.normalize(file);
  if (n !== p.main && n !== p.managed) throw new StoreError("not_allowed", `refusing to write ${file}: only ${p.main} and ${p.managed} are managed`);
}

/** Copies the current content to backups/, 0600. Returns the backup path. */
export async function backup(fs, home, file, text) {
  const p = paths(home);
  await ensureDir(fs, p.ssh);
  await ensureDir(fs, p.herdr);
  await ensureDir(fs, p.backups);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const name = `${path.basename(file)}.${stamp}.${crypto.randomBytes(3).toString("hex")}.bak`;
  const dest = path.join(p.backups, name);
  const fh = await fs.open(dest, "wx", 0o600);
  try { await fh.writeFile(text, "utf8"); await fh.sync(); } finally { await fh.close(); }
  await prune(fs, p.backups, path.basename(file), 20);
  return dest;
}

async function prune(fs, dir, base, keep) {
  try {
    const all = (await fs.readdir(dir)).filter((n) => n.startsWith(`${base}.`) && n.endsWith(".bak")).sort();
    for (const n of all.slice(0, Math.max(0, all.length - keep))) await fs.unlink(path.join(dir, n));
  } catch {}
}

/**
 * Atomically replaces `file` with `text` if it still hashes to `expectedHash` (null: must not
 * exist). Returns { mode, created }.
 */
export async function atomicWrite(fs, home, file, text, expectedHash) {
  assertAllowed(file, home);
  const dir = path.dirname(file);
  await ensureDir(fs, dir);
  const problem = await writeProblem(fs, file);
  if (problem) throw new StoreError("unwritable", problem);
  const before = await readTarget(fs, file);
  if (before.hash !== expectedHash) throw new StoreError("conflict", `${file} changed since the preview; review the changes again`);
  const mode = before.mode ?? 0o600;
  const tmp = path.join(dir, `.${path.basename(file)}.herdr-${crypto.randomBytes(6).toString("hex")}.tmp`);
  let fh;
  try {
    fh = await fs.open(tmp, "wx", 0o600);
    await fh.writeFile(text, "utf8");
    await fh.sync();
    await fh.close();
    fh = null;
    await fs.chmod(tmp, mode);
    // last look right before the rename: a concurrent edit after our read must not be lost
    const again = await readTarget(fs, file);
    if (again.hash !== expectedHash) throw new StoreError("conflict", `${file} changed while saving; nothing was written`);
    await fs.rename(tmp, file);
  } catch (e) {
    if (fh) await fh.close().catch(() => {});
    await fs.unlink(tmp).catch(() => {});
    if (e instanceof StoreError) throw e;
    throw new StoreError("write_failed", `couldn't write ${file}: ${e.code ?? e.message}`);
  }
  try { const d = await fs.open(dir, "r"); await d.sync().catch(() => {}); await d.close(); } catch {}
  return { mode, created: before.text == null };
}

/** Writes `text` to a temp file (0600) beside `file` for `ssh -G -F` validation. Caller removes it. */
export async function stage(fs, file, text) {
  const dir = path.dirname(file);
  await ensureDir(fs, dir);
  const tmp = path.join(dir, `.${path.basename(file)}.herdr-check-${crypto.randomBytes(6).toString("hex")}`);
  const fh = await fs.open(tmp, "wx", 0o600);
  try { await fh.writeFile(text, "utf8"); } finally { await fh.close(); }
  return tmp;
}
