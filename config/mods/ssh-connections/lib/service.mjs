// SSH connection manager: list, plan (preview), apply, test, host key review, key discovery.
// Pure orchestration over injected dependencies: { fs (node:fs/promises-like), home, runner,
// platform, tmpdir }. The CLI (bin/sshcm.mjs) wires in the real ones.
//
// Strategy: new connections go into ~/.ssh/herdr/hosts.conf, included from the FIRST line of
// ~/.ssh/config. ssh uses the first value it reads for each option, so entries there win over
// later `Host *` defaults, while options they don't set still inherit. Whether that worked is
// never assumed: after every write, `ssh -G <alias>` (the real config) must show the values.

import path from "node:path";
import {
  loadConfigTree, collectHosts, rulesAffecting, parseConfig, serialize, appendBlock, editHostBlock,
  renameHostBlock, removeHostBlock, findInclude, prependInclude, renderHostBlock, diffLines,
} from "./sshconfig.mjs";
import { validateFields, expandHome, validateAlias } from "./validate.mjs";
import { paths, ensureDir, readTarget, writeProblem, atomicWrite, backup, stage, sha, StoreError } from "./store.mjs";
import { effective, testArgs, classify, scanHostKeys, knownHost, cleanStderr } from "./sshrun.mjs";

const PROBE_HOST = "herdr-config-check.invalid";
const MANAGED_HEADER = [
  "# Managed by Herdr (SSH Connections). Herdr adds, edits and removes Host blocks here;",
  "# it is included from the first line of ~/.ssh/config. Hand edits are kept.",
];
// Options that, inherited from a wildcard block, change what a connection does.
const NOTABLE = new Set(["proxyjump", "proxycommand", "forwardagent", "identityfile", "localforward", "remoteforward", "dynamicforward", "remotecommand", "stricthostkeychecking", "userknownhostsfile", "hostkeyalias", "controlmaster", "controlpath", "permitlocalcommand", "localcommand", "user", "port", "hostname", "certificatefile", "pkcs11provider"]);

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

const normId = (p, home) => path.normalize(expandHome(String(p ?? ""), home));

function sameSettings(eff, f, home) {
  if (!eff || eff.error) return false;
  return String(eff.hostname).toLowerCase() === f.hostname.toLowerCase()
    && eff.user === f.user
    && Number(eff.port) === Number(f.port)
    && normId(eff.identityFiles?.[0], home) === normId(f.identityFile, home);
}

function declared(block) {
  const v = {};
  for (const d of block?.directives ?? []) if (["hostname", "user", "port", "identityfile"].includes(d.key) && !(d.key in v)) v[d.key] = d.args.join(" ");
  return v;
}

export function createService(deps) {
  const { fs, home, runner, platform = process.platform } = deps;
  const P = paths(home);
  if (deps.includeArg) P.includeArg = deps.includeArg; // tests: ssh expands ~ from the passwd home

  async function tree() {
    const t = await loadConfigTree({ fs, home, mainPath: P.main, managedPath: P.managed });
    return { t, ...collectHosts(t, { mainPath: P.main }) };
  }

  async function keychainSupported() {
    if (platform !== "darwin") return false;
    const r = await runner("ssh", ["-G", "-F", "/dev/null", "-o", "UseKeychain=yes", "--", PROBE_HOST], { timeout: 5000 });
    return r.code === 0;
  }

  async function extras() {
    const x = [["IdentitiesOnly", "yes"], ["AddKeysToAgent", "yes"]];
    if (await keychainSupported()) x.push(["UseKeychain", "yes"]);
    return x;
  }

  /** Symlink / ownership / read-only checks on the dirs and files a write would touch. */
  async function pathProblems(files) {
    const out = [];
    for (const dir of [P.ssh, P.herdr]) {
      try {
        const st = await fs.lstat(dir);
        if (st.isSymbolicLink()) out.push(`${dir} is a symbolic link; Herdr won't write through it`);
        else if (!st.isDirectory()) out.push(`${dir} exists and isn't a folder`);
      } catch (e) { if (e.code !== "ENOENT") out.push(`can't check ${dir}: ${e.code}`); }
    }
    for (const f of files) { const p = await writeProblem(fs, f); if (p) out.push(p); }
    return out;
  }

  // ------------------------------------------------------------ list

  async function list() {
    const { t, hosts, rules } = await tree();
    const main = t.files.find((f) => f.origin === "user");
    const include = main ? findInclude(main.doc, P.managed, home) : null;
    const effs = await mapLimit(hosts, 6, (h) => effective(runner, h.alias));
    return {
      ok: true,
      paths: { main: P.main, managed: P.managed },
      mainExists: Boolean(main?.exists),
      managedIncluded: include,
      problems: t.problems.map((p) => ({ ...p, path: p.path })),
      hosts: hosts.map((h, i) => {
        const file = t.files.find((f) => f.path === h.path);
        const block = file.doc.blocks.find((b) => b.start === h.line - 1);
        const e = effs[i];
        return {
          alias: h.alias,
          origin: h.origin,
          path: h.path,
          line: h.line,
          patterns: h.patterns,
          includedFrom: file.include ? { path: file.include.from, line: file.include.line } : null,
          editable: !h.readOnlyReason,
          readOnlyReason: h.readOnlyReason,
          declared: declared(block),
          effective: e.error ? { error: e.error } : { hostname: e.hostname, user: e.user, port: e.port, identityFile: e.identityFiles[0] ?? null, identityFiles: e.identityFiles, proxyJump: e.raw.proxyjump && e.raw.proxyjump !== "none" ? e.raw.proxyjump : null },
        };
      }),
      rules: rules.map(({ kind, path: p, origin, line, text, keys }) => ({ kind, path: p, origin, line, text, keys })),
    };
  }

  // ------------------------------------------------------------ plan

  async function plan(op) {
    const action = op?.action;
    if (!["add", "edit", "remove"].includes(action)) return { ok: false, error: `unknown action ${action}` };
    const res = { ok: true, action, errors: {}, warnings: [], conflicts: [], changes: [], blocked: null, reuse: null, snapshot: {} };
    const { t, hosts } = await tree();
    const find = (a) => hosts.find((h) => h.alias === a);

    let v = null;
    if (action !== "remove") {
      v = await validateFields(op.fields ?? {}, { home, fs });
      res.errors = v.errors;
      res.warnings.push(...v.warnings);
      res.fields = v.fields;
      if (Object.keys(v.errors).length) { res.blocked = "Fix the highlighted fields"; return res; }
    }

    // --- files we would read/write
    let main, managed;
    try {
      main = await readTarget(fs, P.main);
      managed = await readTarget(fs, P.managed);
    } catch (e) {
      res.blocked = e.message;
      return res;
    }
    res.snapshot = { [P.main]: main.hash, [P.managed]: managed.hash };
    const mainDoc = parseConfig(main.text ?? "");
    const managedDoc = parseConfig(managed.text ?? MANAGED_HEADER.join("\n") + "\n");
    const pending = new Map(); // path -> { before, doc }

    if (action === "add") {
      const f = v.fields;
      const existing = find(f.alias);
      if (existing) {
        const eff = await effective(runner, f.alias);
        if (sameSettings(eff, f, home)) {
          res.reuse = f.alias;
          res.blocked = `"${f.alias}" already exists with exactly these settings (${path.basename(existing.path)}:${existing.line}); nothing to write, use it as is`;
          return res;
        }
        res.conflicts.push({
          kind: "alias_exists", alias: f.alias, path: existing.path, line: existing.line, origin: existing.origin,
          editable: !existing.readOnlyReason, reason: existing.readOnlyReason,
          current: eff.error ? null : { hostname: eff.hostname, user: eff.user, port: eff.port, identityFile: eff.identityFiles?.[0] ?? null },
        });
        res.blocked = existing.readOnlyReason
          ? `"${f.alias}" is already declared at ${existing.path}:${existing.line} with different settings, and Herdr can't edit it safely: ${existing.readOnlyReason}. Choose another name.`
          : `"${f.alias}" is already declared at ${existing.path}:${existing.line} with different settings. Edit that entry instead, or choose another name.`;
        return res;
      }
      await duplicateCheck(res, hosts, f, null, op);
      const inc = findInclude(mainDoc, P.managed, home);
      if (inc?.conditional) {
        res.blocked = `~/.ssh/config includes ${P.managed} inside "${inc.block}" (line ${inc.line}), so its hosts only apply conditionally. Move that Include line to the top of ~/.ssh/config, then try again.`;
        return res;
      }
      if (inc && !inc.first) res.warnings.push(`The Include of ${P.managed} (line ${inc.line}) isn't the first line of ~/.ssh/config; settings above it win. Herdr will check the result after saving.`);
      const block = renderHostBlock(f, await extras());
      pending.set(P.managed, { before: managed.text, doc: appendBlock(managedDoc, block) });
      if (!inc) pending.set(P.main, { before: main.text, doc: prependInclude(mainDoc, P.includeArg) });
      rules(res, t, f.alias);
    } else {
      const alias = action === "edit" ? op.originalAlias : op.alias;
      const err = validateAlias(alias ?? "");
      if (err) return { ...res, blocked: `alias: ${err}` };
      const h = find(alias);
      if (!h) return { ...res, blocked: `"${alias}" isn't declared in your ssh config` };
      if (h.readOnlyReason) return { ...res, blocked: `Herdr can't change "${alias}" safely: ${h.readOnlyReason}` };
      const isManaged = h.origin === "managed";
      const doc = isManaged ? managedDoc : mainDoc;
      const before = isManaged ? managed.text : main.text;
      const start = h.line - 1;
      if (!isManaged) res.warnings.push(`This changes your own ~/.ssh/config (line ${h.line}); a backup is kept in ${P.backups}.`);
      if (action === "remove") {
        pending.set(h.path, { before, doc: removeHostBlock(doc, start) });
      } else {
        const f = v.fields;
        if (f.alias !== alias && find(f.alias)) {
          const other = find(f.alias);
          res.conflicts.push({ kind: "alias_exists", alias: f.alias, path: other.path, line: other.line, origin: other.origin, editable: false, reason: "another entry uses this name" });
          res.blocked = `"${f.alias}" is already declared at ${other.path}:${other.line}`;
          return res;
        }
        await duplicateCheck(res, hosts, f, alias, op);
        let next = editHostBlock(doc, start, { hostname: f.hostname, user: f.user, port: f.port, identityfile: f.identityFile });
        if (f.alias !== alias) next = renameHostBlock(next, start, f.alias);
        pending.set(h.path, { before, doc: next });
        rules(res, t, f.alias);
      }
    }

    const problems = await pathProblems([...pending.keys()]);
    if (problems.length) { res.blocked = problems.join("; "); }
    for (const [p, { before, doc }] of pending) {
      const after = serialize(doc);
      if (after === (before ?? "")) continue;
      res.changes.push({ path: p, created: before == null, label: p === P.main ? "~/.ssh/config" : "~/.ssh/herdr/hosts.conf", diff: diffLines(before ?? "", after), after });
    }
    if (!res.blocked && res.conflicts.some((c) => c.kind === "duplicate") && !op.allowDuplicate) {
      res.blocked = "The same server, user, port and key are already configured under another name";
    }
    return res;
  }

  async function duplicateCheck(res, hosts, f, exclude, op) {
    const others = hosts.filter((h) => h.alias !== exclude && h.alias !== f.alias);
    const effs = await mapLimit(others, 6, (h) => effective(runner, h.alias));
    others.forEach((h, i) => {
      if (sameSettings(effs[i], f, home)) res.conflicts.push({ kind: "duplicate", alias: h.alias, path: h.path, line: h.line, allowed: Boolean(op.allowDuplicate) });
    });
    if (res.conflicts.some((c) => c.kind === "duplicate")) res.reuse = res.conflicts.find((c) => c.kind === "duplicate").alias;
  }

  function rules(res, t, alias) {
    for (const r of rulesAffecting(t, alias)) {
      const notable = r.keys.filter((k) => NOTABLE.has(k.toLowerCase()));
      if (r.kind === "match") res.warnings.push(`${r.path}:${r.line} "${r.text}" is evaluated when connecting and may change settings for ${alias}${r.keys.length ? ` (${r.keys.join(", ")})` : ""}.`);
      else if (notable.length) res.warnings.push(`${r.path}:${r.line} "${r.text}" also applies to ${alias} and sets ${notable.join(", ")}. Values this entry sets win; others are inherited${notable.some((k) => k.toLowerCase() === "identityfile") ? " (IdentityFile adds keys to try)" : ""}.`);
      else if (r.keys.length) res.warnings.push(`${r.path}:${r.line} "${r.text}" also applies to ${alias} (${r.keys.join(", ")}).`);
    }
  }

  // ------------------------------------------------------------ apply

  async function apply(op) {
    const p = await plan(op);
    if (!p.ok) return p;
    if (p.blocked) return { ...p, ok: false, error: p.blocked };
    for (const [file, hash] of Object.entries(op.snapshot ?? {})) {
      if (p.snapshot[file] !== hash) return { ...p, ok: false, error: `${file} changed since the preview; review the changes again`, code: "conflict" };
    }
    if (!op.snapshot) return { ...p, ok: false, error: "missing preview snapshot" };
    if (!p.changes.length) return { ...p, ok: true, written: [], note: "nothing to change" };

    // managed file first, so the main config's new Include validates against the real file
    const order = [...p.changes.filter((c) => c.path === P.managed), ...p.changes.filter((c) => c.path !== P.managed)];
    const done = []; // { path, before, afterHash, created }
    const backups = [];
    try {
      await ensureDir(fs, P.ssh);
      if (order.some((c) => c.path === P.managed)) await ensureDir(fs, P.herdr);
    } catch (e) {
      return { ...p, ok: false, error: e.message, code: e.code };
    }
    const rollback = async () => {
      for (const d of done.reverse()) {
        try {
          if (d.created) await fs.unlink(d.path);
          else await atomicWrite(fs, home, d.path, d.before, d.afterHash);
        } catch {}
      }
    };
    for (const c of order) {
      const before = (await readTarget(fs, c.path)).text;
      // 1. validate the candidate with OpenSSH before it replaces anything
      let staged = null;
      try {
        staged = await stage(fs, c.path, c.after);
        const probe = p.action === "remove" || c.path === P.managed ? PROBE_HOST : p.fields.alias;
        const r = await runner("ssh", ["-G", "-F", staged, "--", probe], { timeout: 8000 });
        if (r.code !== 0) {
          await rollback();
          return { ...p, ok: false, error: `OpenSSH rejected the new ${c.label}: ${cleanStderr(r.stderr).split("\n").pop() || `exit ${r.code}`}. Nothing was changed.`, code: "invalid" };
        }
      } catch (e) {
        await rollback();
        return { ...p, ok: false, error: e.message, code: e.code };
      } finally {
        if (staged) await fs.unlink(staged).catch(() => {});
      }
      // 2. back up, 3. atomic compare-and-swap write
      try {
        if (before != null) backups.push(await backup(fs, home, c.path, before));
        await atomicWrite(fs, home, c.path, c.after, p.snapshot[c.path]);
        done.push({ path: c.path, before, afterHash: sha(c.after), created: before == null });
      } catch (e) {
        await rollback();
        return { ...p, ok: false, error: `${e.message}. ${done.length ? "Earlier changes were rolled back." : "Nothing was changed."}`, code: e instanceof StoreError ? e.code : "write_failed", backups };
      }
    }

    // 4. what does ssh actually use now?
    const out = { ...p, ok: true, written: done.map((d) => d.path), backups, verified: false, mismatches: [] };
    delete out.snapshot;
    if (p.action === "remove") {
      const { hosts } = await tree();
      out.verified = !hosts.some((h) => h.alias === op.alias);
      if (!out.verified) out.mismatches.push(`"${op.alias}" is still declared elsewhere in your ssh config`);
      return out;
    }
    const f = p.fields;
    const eff = await effective(runner, f.alias);
    if (eff.error) { out.mismatches.push(`ssh -G ${f.alias} failed: ${eff.error}`); return out; }
    if (String(eff.hostname).toLowerCase() !== f.hostname.toLowerCase()) out.mismatches.push(`HostName is ${eff.hostname}, expected ${f.hostname}`);
    if (eff.user !== f.user) out.mismatches.push(`User is ${eff.user}, expected ${f.user}`);
    if (Number(eff.port) !== f.port) out.mismatches.push(`Port is ${eff.port}, expected ${f.port}`);
    if (normId(eff.identityFiles[0], home) !== normId(f.identityFile, home)) out.mismatches.push(`first IdentityFile is ${eff.identityFiles[0] ?? "none"}, expected ${f.identityFile}`);
    out.verified = out.mismatches.length === 0;
    out.effective = { hostname: eff.hostname, user: eff.user, port: eff.port, identityFiles: eff.identityFiles };
    return out;
  }

  // ------------------------------------------------------------ test / host keys

  async function withTempConfig(fields, fn) {
    const dir = await fs.mkdtemp(path.join(deps.tmpdir ?? "/tmp", "herdr-ssh-"));
    const file = path.join(dir, "config");
    try {
      await fs.writeFile(file, renderHostBlock(fields, await extras()).join("\n") + "\n", { mode: 0o600 });
      return await fn(file);
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function target(op) {
    if (op.fields) {
      const v = await validateFields(op.fields, { home, fs });
      if (Object.keys(v.errors).length) return { errors: v.errors };
      return { fields: v.fields };
    }
    const err = validateAlias(op.alias ?? "");
    if (err) return { error: err };
    return { alias: op.alias };
  }

  async function test(op) {
    const tg = await target(op);
    if (tg.error || tg.errors) return { ok: false, error: tg.error ?? "Fix the highlighted fields", errors: tg.errors };
    const runTest = async (alias, file) => {
      const r = await runner("ssh", testArgs(alias, file), { timeout: 15000 });
      return { ok: true, scope: file ? "unsaved" : "saved", result: classify(r.code, r.stderr, r.timedOut) };
    };
    if (tg.fields) return withTempConfig(tg.fields, (file) => runTest(tg.fields.alias, file));
    return runTest(tg.alias, null);
  }

  async function hostkey(op) {
    const tg = await target(op);
    if (tg.error || tg.errors) return { ok: false, error: tg.error ?? "Fix the highlighted fields" };
    const eff = tg.fields ? { hostname: tg.fields.hostname, port: tg.fields.port } : await effective(runner, tg.alias);
    if (eff.error) return { ok: false, error: eff.error };
    const tmp = path.join(deps.tmpdir ?? "/tmp", `herdr-keyscan-${process.pid}-${Date.now()}`);
    const scan = await scanHostKeys(runner, fs, tmp, eff);
    return { ok: !scan.error, error: scan.error, hostname: eff.hostname, port: eff.port, keys: scan.keys ?? [], known: await knownHost(runner, eff) };
  }

  /** Candidate private keys in a folder: names and modes only, contents never read. */
  async function keys(op) {
    const dir = path.normalize(expandHome(op?.dir || "~/.ssh", home));
    if (!path.isAbsolute(dir)) return { ok: false, error: "folder must be absolute" };
    let names = [];
    try { names = await fs.readdir(dir); } catch (e) { return { ok: false, error: `can't list ${dir}: ${e.code}` }; }
    const skip = /^(known_hosts.*|config|authorized_keys.*|environment|rc|.*\.(pub|bak|old|conf|json|txt|md))$/;
    const out = [];
    for (const n of names.sort()) {
      if (n.startsWith(".") || skip.test(n)) continue;
      const abs = path.join(dir, n);
      let st;
      try { st = await fs.stat(abs); } catch { continue; }
      if (!st.isFile() || st.size > 64 * 1024) continue;
      const hasPub = names.includes(`${n}.pub`);
      if (!hasPub && !n.startsWith("id_")) continue;
      out.push({ path: abs, written: abs.startsWith(home + path.sep) ? `~/${path.relative(home, abs)}` : abs, hasPub, mode: (st.mode & 0o777).toString(8) });
    }
    return { ok: true, dir, keys: out };
  }

  return { list, plan, apply, test, hostkey, keys, paths: P };
}
