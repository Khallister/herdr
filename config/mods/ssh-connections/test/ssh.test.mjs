// Run: node --test mods/ssh-connections/test/   (no Herdr window, no network; ssh is mocked
// except `ssh -G`, which runs the real OpenSSH client against a temp config with -F).

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { parseConfig, serialize, tokenizeLine, collectHosts, loadConfigTree, editHostBlock, removeHostBlock, prependInclude, hostPatternsMatch, findInclude } from "../lib/sshconfig.mjs";
import { validateAlias, validateHostname, validateUser, parsePort, checkKeyPath } from "../lib/validate.mjs";
import { atomicWrite, sha } from "../lib/store.mjs";
import { classify, testArgs, systemRunner } from "../lib/sshrun.mjs";
import { createService } from "../lib/service.mjs";

// ---------------------------------------------------------------- fixtures

let HOME;
async function freshHome({ config, ssh = true } = {}) {
  HOME = await fsp.mkdtemp(path.join(os.tmpdir(), "herdr-sshcm-test-"));
  if (ssh) {
    await fsp.mkdir(path.join(HOME, ".ssh"), { mode: 0o700 });
    await fsp.writeFile(path.join(HOME, ".ssh", "id_vps"), "not a real key\n", { mode: 0o600 });
    await fsp.writeFile(path.join(HOME, ".ssh", "id_vps.pub"), "ssh-ed25519 AAAA test\n");
  }
  if (config != null) await fsp.writeFile(path.join(HOME, ".ssh", "config"), config, { mode: 0o644 });
  return HOME;
}
const cfgPath = () => path.join(HOME, ".ssh", "config");
const managedPath = () => path.join(HOME, ".ssh", "herdr", "hosts.conf");
const read = (p) => fsp.readFile(p, "utf8");

// Real `ssh -G` against the temp home's config (ssh itself reads the passwd home, so -F is
// injected); everything that would connect is answered by `fake`.
function runner(fake = {}) {
  const calls = [];
  const fn = async (cmd, args, opts) => {
    calls.push([cmd, ...args]);
    if (cmd === "ssh" && args[0] === "-G") {
      const a = args.includes("-F") ? args : ["-G", "-F", cfgPath(), ...args.slice(1)];
      return systemRunner("ssh", a, opts);
    }
    if (fake[cmd]) return fake[cmd](args);
    return { code: 0, stdout: "", stderr: "" };
  };
  fn.calls = calls;
  return fn;
}
const svc = (r = runner(), fs = fsp) => createService({ fs, home: HOME, runner: r, platform: "linux", tmpdir: os.tmpdir(), includeArg: managedPath() });
const FIELDS = { alias: "prod-vps", hostname: "192.0.2.10", user: "deploy", port: "22", identityFile: "~/.ssh/id_vps" };
async function addViaPlan(s, fields = FIELDS, extra = {}) {
  const p = await s.plan({ action: "add", fields, ...extra });
  return { p, r: p.blocked ? null : await s.apply({ action: "add", fields, snapshot: p.snapshot, ...extra }) };
}

// ---------------------------------------------------------------- parser

describe("parser", () => {
  test("1. empty configuration: no hosts, serializes back to empty", () => {
    const d = parseConfig("");
    assert.equal(serialize(d), "");
    assert.equal(d.blocks.length, 1);
  });

  test("tokenizer: '=' separator, quotes, trailing comments", () => {
    assert.deepEqual(tokenizeLine("  HostName=example.com").args, ["example.com"]);
    assert.deepEqual(tokenizeLine('IdentityFile "~/my keys/id" # mine').args, ["~/my keys/id"]);
    assert.equal(tokenizeLine("# just a comment"), null);
    assert.equal(tokenizeLine("User a # trailing").comment, " # trailing");
    assert.equal(tokenizeLine('User "abc').error, "unterminated quote");
  });

  test("6. multiple aliases in one Host block are listed but read-only", async () => {
    await freshHome({ config: "Host web1 web2\n  HostName 10.0.0.1\n" });
    const { files } = await loadConfigTree({ fs: fsp, home: HOME, mainPath: cfgPath(), managedPath: managedPath() });
    const { hosts } = collectHosts({ files }, { mainPath: cfgPath() });
    assert.deepEqual(hosts.map((h) => h.alias), ["web1", "web2"]);
    assert.match(hosts[0].readOnlyReason, /several patterns/);
  });

  test("7. wildcard patterns and negation follow ssh's matching", () => {
    assert.equal(hostPatternsMatch(["*"], "prod"), true);
    assert.equal(hostPatternsMatch(["*.example.com", "!bad.example.com"], "bad.example.com"), false);
    assert.equal(hostPatternsMatch(["prod-*"], "PROD-1"), true);
    assert.equal(hostPatternsMatch(["a?c"], "abbc"), false);
  });

  test("8. Include: glob, relative-to-~/.ssh, read-only, conditional include", async () => {
    await freshHome({ config: "Include conf.d/*.conf\nHost box\n  Include inner.conf\n" });
    await fsp.mkdir(path.join(HOME, ".ssh", "conf.d"));
    await fsp.writeFile(path.join(HOME, ".ssh", "conf.d", "b.conf"), "Host bee\n  HostName b\n");
    await fsp.writeFile(path.join(HOME, ".ssh", "conf.d", "a.conf"), "Host ay\n  HostName a\n");
    await fsp.writeFile(path.join(HOME, ".ssh", "inner.conf"), "Host inner\n  HostName i\n");
    const t = await loadConfigTree({ fs: fsp, home: HOME, mainPath: cfgPath(), managedPath: managedPath() });
    const { hosts } = collectHosts(t, { mainPath: cfgPath() });
    assert.deepEqual(hosts.map((h) => h.alias), ["ay", "bee", "box", "inner"]); // glob sorted
    assert.match(hosts.find((h) => h.alias === "ay").readOnlyReason, /included file/);
    assert.equal(hosts.find((h) => h.alias === "inner").conditional, true);
  });

  test("8b. Include cycles terminate", async () => {
    await freshHome({ config: "Include config\nHost x\n" });
    const t = await loadConfigTree({ fs: fsp, home: HOME, mainPath: cfgPath(), managedPath: managedPath() });
    assert.equal(t.files.length, 1);
  });

  test("9. Match blocks are rules, never hosts", () => {
    const d = parseConfig("Match host foo exec \"true\"\n  User m\nHost real\n  User r\n");
    const { hosts, rules } = collectHosts({ files: [{ path: "/c", origin: "user", doc: d }] }, { mainPath: "/c" });
    assert.deepEqual(hosts.map((h) => h.alias), ["real"]);
    assert.equal(rules[0].kind, "match");
  });

  test("10. edits preserve comments, spacing, CRLF and unrelated blocks byte for byte", () => {
    const src = "# top comment\r\nHost a\r\n\tHostName  old.example   # keep me\r\n\tUser x\r\n\r\n# about b\r\nHost b\r\n  User y\r\n";
    const d = parseConfig(src);
    const out = serialize(editHostBlock(d, 1, { hostname: "new.example", port: 2222 }));
    assert.equal(out, "# top comment\r\nHost a\r\n\tHostName  new.example   # keep me\r\n\tUser x\r\n\tPort 2222\r\n\r\n# about b\r\nHost b\r\n  User y\r\n");
    const inc = serialize(prependInclude(d, "~/.ssh/herdr/hosts.conf"));
    assert.ok(inc.endsWith(src), "original content kept verbatim after the Include");
    const rm = serialize(removeHostBlock(d, 1));
    assert.equal(rm, "# top comment\r\n\r\n# about b\r\nHost b\r\n  User y\r\n");
  });

  test("findInclude: top-level vs conditional", () => {
    const home = "/h";
    assert.equal(findInclude(parseConfig("Include ~/.ssh/herdr/hosts.conf\n"), "/h/.ssh/herdr/hosts.conf", home).first, true);
    assert.equal(findInclude(parseConfig("Host x\n Include herdr/hosts.conf\n"), "/h/.ssh/herdr/hosts.conf", home).conditional, true);
  });
});

// ---------------------------------------------------------------- validation

describe("validation", () => {
  beforeEach(() => freshHome());

  test("11. missing private key", async () => {
    assert.match((await checkKeyPath("~/.ssh/nope", { home: HOME, fs: fsp })).error, /No file/);
  });

  test("12. invalid key paths: relative, directory, .pub, tokens", async () => {
    assert.match((await checkKeyPath("id_vps", { home: HOME, fs: fsp })).error, /absolute/);
    assert.match((await checkKeyPath("~/.ssh", { home: HOME, fs: fsp })).error, /not a file/);
    assert.match((await checkKeyPath("~/.ssh/id_vps.pub", { home: HOME, fs: fsp })).error, /public key/);
    assert.match((await checkKeyPath("~/.ssh/%h", { home: HOME, fs: fsp })).error, /tokens/);
    const ok = await checkKeyPath("~/.ssh/../.ssh/id_vps", { home: HOME, fs: fsp });
    assert.equal(ok.written, "~/.ssh/id_vps"); // normalized
  });

  test("key with loose permissions warns", async () => {
    await fsp.chmod(path.join(HOME, ".ssh", "id_vps"), 0o644);
    assert.match((await checkKeyPath("~/.ssh/id_vps", { home: HOME, fs: fsp })).warnings[0], /chmod 600/);
  });

  test("13. invalid ports", () => {
    for (const p of ["0", "65536", "-1", "22a", "2 2", "1e3"]) assert.ok(parsePort(p).error, p);
    assert.equal(parsePort("").port, 22);
    assert.equal(parsePort("2222").port, 2222);
  });

  test("14. newline / directive injection is rejected in every field", async () => {
    assert.ok(validateAlias("prod\nHost *"));
    assert.ok(validateAlias("prod *"));
    assert.ok(validateAlias("-oProxyCommand=x"));
    assert.ok(validateHostname("1.2.3.4\n  ProxyCommand sh"));
    assert.ok(validateHostname("evil host"));
    assert.ok(validateHostname("999.1.1.1"));
    assert.ok(validateUser("root\nHost *"));
    assert.ok(validateUser("a b"));
    assert.ok((await checkKeyPath("~/.ssh/id_vps\nProxyCommand x", { home: HOME, fs: fsp })).error);
    assert.ok((await checkKeyPath('~/.ssh/id"vps', { home: HOME, fs: fsp })).error);
    assert.equal(validateHostname("2001:db8::1"), null);
    assert.equal(validateHostname("vps.example.com"), null);
  });
});

// ---------------------------------------------------------------- service: plan/apply

describe("persistence", () => {
  test("2. missing config: add creates ~/.ssh/config (0600), herdr dir (0700), Include first", async () => {
    await freshHome({ ssh: true });
    const { p, r } = await addViaPlan(svc());
    assert.equal(p.blocked, null);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.verified, true, r.mismatches.join("; "));
    assert.equal((await fsp.stat(cfgPath())).mode & 0o777, 0o600);
    assert.equal((await fsp.stat(path.dirname(managedPath()))).mode & 0o777, 0o700);
    assert.ok((await read(cfgPath())).split("\n")[1] === `Include ${managedPath()}`);
    assert.match(await read(managedPath()), /Host prod-vps\n    HostName 192\.0\.2\.10\n    User deploy\n    Port 22\n    IdentityFile ~\/\.ssh\/id_vps\n    IdentitiesOnly yes/);
  });

  test("2b. missing ~/.ssh is created 0700", async () => {
    await freshHome({ ssh: false });
    await fsp.mkdir(path.join(HOME, "keys"));
    await fsp.writeFile(path.join(HOME, "keys", "k"), "x", { mode: 0o600 });
    const { r } = await addViaPlan(svc(), { ...FIELDS, identityFile: "~/keys/k" });
    assert.equal(r.ok, true, r.error);
    assert.equal((await fsp.stat(path.join(HOME, ".ssh"))).mode & 0o777, 0o700);
  });

  test("3. existing valid connection is listed with effective settings; existing file mode kept and backed up", async () => {
    const original = "# mine\nHost old\n  HostName old.example\n  User me\n";
    await freshHome({ config: original });
    const l = await svc().list();
    assert.equal(l.hosts[0].alias, "old");
    assert.equal(l.hosts[0].effective.hostname, "old.example");
    assert.equal(l.hosts[0].editable, true);
    const { r } = await addViaPlan(svc());
    assert.equal(r.ok, true, r.error);
    assert.ok((await read(cfgPath())).endsWith(original));
    assert.equal((await fsp.stat(cfgPath())).mode & 0o777, 0o644); // preserved
    assert.equal(await read(r.backups[0]), original);
  });

  test("4. duplicate alias: different settings blocked (edit offered); identical reused", async () => {
    await freshHome({ config: "Host prod-vps\n  HostName 198.51.100.1\n  User deploy\n" });
    const p = await svc().plan({ action: "add", fields: FIELDS });
    assert.equal(p.conflicts[0].kind, "alias_exists");
    assert.equal(p.conflicts[0].editable, true);
    assert.match(p.blocked, /Edit that entry/);
    await freshHome({ config: "Host prod-vps\n  HostName 192.0.2.10\n  User deploy\n  IdentityFile ~/.ssh/id_vps\n" });
    const same = await svc().plan({ action: "add", fields: FIELDS });
    assert.equal(same.reuse, "prod-vps");
    assert.equal(same.changes.length, 0);
  });

  test("5. same server/user/port/key under another alias: blocked unless explicitly allowed", async () => {
    await freshHome({ config: "Host other\n  HostName 192.0.2.10\n  User deploy\n  IdentityFile ~/.ssh/id_vps\n" });
    const p = await svc().plan({ action: "add", fields: FIELDS });
    assert.equal(p.conflicts[0].kind, "duplicate");
    assert.equal(p.reuse, "other");
    assert.ok(p.blocked);
    const allowed = await svc().plan({ action: "add", fields: FIELDS, allowDuplicate: true });
    assert.equal(allowed.blocked, null);
  });

  test("7b. Host * defaults: warned, and managed entry still wins (verified by ssh -G)", async () => {
    await freshHome({ config: "Host *\n  User root\n  Port 2200\n  ForwardAgent yes\n" });
    const { p, r } = await addViaPlan(svc());
    assert.ok(p.warnings.some((w) => /Host \*/.test(w) && /ForwardAgent/.test(w)));
    assert.equal(r.verified, true, r.mismatches.join("; "));
    assert.equal(r.effective.user, "deploy");
    assert.equal(r.effective.port, 22);
  });

  test("7c. Include placed after Host * is detected by verification, not assumed", async () => {
    await freshHome({ config: "Host *\n  User root\nInclude ~/.ssh/herdr/hosts.conf\n" }); // conditional: inside Host *
    const { p, r } = await addViaPlan(svc());
    assert.ok(p.blocked, "Include inside Host * is conditional and must block");
    assert.match(p.blocked, /conditionally/);
    assert.equal(r, null);
  });

  test("8c. alias defined in an included file is detected before saving", async () => {
    await freshHome({ config: "Include extra.conf\n" });
    await fsp.writeFile(path.join(HOME, ".ssh", "extra.conf"), "Host prod-vps\n  HostName 203.0.113.5\n");
    const p = await svc().plan({ action: "add", fields: FIELDS });
    assert.equal(p.conflicts[0].origin, "included");
    assert.match(p.blocked, /can't edit it safely/);
  });

  test("9b. Match blocks produce a warning", async () => {
    await freshHome({ config: "Match host prod-vps\n  User m\n" });
    const p = await svc().plan({ action: "add", fields: FIELDS });
    assert.ok(p.warnings.some((w) => /Match host/.test(w)));
  });

  test("edit and remove of a managed entry; remove leaves user config intact", async () => {
    await freshHome({ config: "Host keep\n  User k\n" });
    const s = svc();
    await addViaPlan(s);
    const pe = await s.plan({ action: "edit", originalAlias: "prod-vps", fields: { ...FIELDS, port: "2222" } });
    const re = await s.apply({ action: "edit", originalAlias: "prod-vps", fields: { ...FIELDS, port: "2222" }, snapshot: pe.snapshot });
    assert.equal(re.verified, true, re.mismatches?.join("; "));
    assert.match(await read(managedPath()), /Port 2222/);
    const before = await read(cfgPath());
    const pr = await s.plan({ action: "remove", alias: "prod-vps" });
    const rr = await s.apply({ action: "remove", alias: "prod-vps", snapshot: pr.snapshot });
    assert.equal(rr.verified, true);
    assert.doesNotMatch(await read(managedPath()), /prod-vps/);
    assert.equal(await read(cfgPath()), before);
  });

  test("read-only entries cannot be edited", async () => {
    await freshHome({ config: "Host a b\n  User x\n" });
    const p = await svc().plan({ action: "edit", originalAlias: "a", fields: { ...FIELDS, alias: "a" } });
    assert.match(p.blocked, /several patterns/);
  });

  test("15. concurrent modification between preview and save is refused", async () => {
    await freshHome({ config: "Host a\n  User x\n" });
    const s = svc();
    const p = await s.plan({ action: "add", fields: FIELDS });
    await fsp.appendFile(cfgPath(), "Host sneaky\n");
    const r = await s.apply({ action: "add", fields: FIELDS, snapshot: p.snapshot });
    assert.equal(r.ok, false);
    assert.match(r.error, /changed since the preview/);
    assert.equal(await read(cfgPath()), "Host a\n  User x\nHost sneaky\n");
  });

  test("15b. atomicWrite refuses a stale expected hash", async () => {
    await freshHome({ config: "x\n" });
    await assert.rejects(atomicWrite(fsp, HOME, cfgPath(), "y\n", sha("other\n")), /changed since the preview/);
    assert.equal(await read(cfgPath()), "x\n");
  });

  test("16. read-only ~/.ssh/config is never modified", async () => {
    await freshHome({ config: "Host a\n" });
    await fsp.chmod(cfgPath(), 0o400);
    const p = await svc().plan({ action: "add", fields: FIELDS });
    assert.match(p.blocked, /read-only/);
    await fsp.chmod(cfgPath(), 0o600);
  });

  test("16b. symlinked ~/.ssh/config is refused", async () => {
    await freshHome();
    await fsp.writeFile(path.join(HOME, "real-config"), "Host a\n");
    await fsp.symlink(path.join(HOME, "real-config"), cfgPath());
    const p = await svc().plan({ action: "add", fields: FIELDS });
    assert.match(p.blocked, /symbolic link/);
  });

  test("writes outside the two managed files are refused", async () => {
    await freshHome();
    await assert.rejects(atomicWrite(fsp, HOME, path.join(HOME, ".ssh", "authorized_keys"), "x", null), /only/);
  });

  test("17. atomic write failure leaves everything unchanged and cleans temp files", async () => {
    const original = "Host a\n  User x\n";
    await freshHome({ config: original });
    let renames = 0;
    const flaky = { ...fsp, rename: async (a, b) => { if (++renames === 2) { const e = new Error("disk full"); e.code = "ENOSPC"; throw e; } return fsp.rename(a, b); } };
    const s = svc(runner(), flaky);
    const p = await s.plan({ action: "add", fields: FIELDS });
    const r = await s.apply({ action: "add", fields: FIELDS, snapshot: p.snapshot });
    assert.equal(r.ok, false);
    assert.match(r.error, /ENOSPC/);
    assert.equal(await read(cfgPath()), original);
    await assert.rejects(fsp.stat(managedPath()), { code: "ENOENT" }); // managed write rolled back
    const leftovers = (await fsp.readdir(path.join(HOME, ".ssh"))).filter((n) => n.includes("herdr-"));
    assert.deepEqual(leftovers, []);
  });

  test("OpenSSH validation failure aborts before writing", async () => {
    await freshHome({ config: "Host a\n" });
    const bad = runner();
    const r0 = async (cmd, args, o) => (cmd === "ssh" && args[0] === "-G" && args[2]?.includes("herdr-check") ? { code: 255, stdout: "", stderr: "line 3: Bad configuration option: x" } : bad(cmd, args, o));
    const s = svc(r0);
    const p = await s.plan({ action: "add", fields: FIELDS });
    const r = await s.apply({ action: "add", fields: FIELDS, snapshot: p.snapshot });
    assert.equal(r.ok, false);
    assert.match(r.error, /OpenSSH rejected/);
    assert.equal(await read(cfgPath()), "Host a\n");
  });

  test("private key contents are never read", async () => {
    await freshHome();
    const spy = { ...fsp, readFile: async (p, ...a) => { assert.ok(!String(p).endsWith("id_vps"), "key file read!"); return fsp.readFile(p, ...a); }, open: async (p, ...a) => { assert.ok(!String(p).endsWith("id_vps"), "key file opened!"); return fsp.open(p, ...a); } };
    const s = svc(runner(), spy);
    await addViaPlan(s);
    await s.keys({});
    await s.list();
  });
});

// ---------------------------------------------------------------- connection tests

describe("connection test", () => {
  const ssh = (code, stderr, timedOut = false) => runner({ ssh: async () => ({ code, stdout: "", stderr, timedOut }) });
  beforeEach(() => freshHome({ config: "Host prod-vps\n  HostName 192.0.2.10\n  User deploy\n" }));

  test("test args: batch mode, strict host keys, no forwarding, argv after --", () => {
    const a = testArgs("prod-vps");
    assert.ok(a.includes("BatchMode=yes"));
    assert.ok(a.includes("StrictHostKeyChecking=yes"));
    assert.ok(!a.some((x) => /StrictHostKeyChecking=(no|accept-new)/.test(x)));
    assert.ok(a.includes("ForwardAgent=no"));
    assert.deepEqual(a.slice(-3), ["--", "prod-vps", "true"]);
  });

  test("18. authentication failure", async () => {
    const r = await svc(ssh(255, "deploy@192.0.2.10: Permission denied (publickey).")).test({ alias: "prod-vps" });
    assert.equal(r.result.kind, "auth");
  });

  test("19. unreachable host, DNS, timeout, refused", () => {
    assert.equal(classify(255, "ssh: connect to host 192.0.2.10 port 22: No route to host").kind, "unreachable");
    assert.equal(classify(255, "ssh: Could not resolve hostname nope.invalid: nodename nor servname provided, or not known").kind, "dns");
    assert.equal(classify(255, "ssh: connect to host 192.0.2.10 port 22: Operation timed out").kind, "timeout");
    assert.equal(classify(124, "", true).kind, "timeout");
    assert.equal(classify(255, "ssh: connect to host 192.0.2.10 port 22: Connection refused").kind, "refused");
  });

  test("20. unknown and changed host keys are reported, never accepted", async () => {
    const unknown = await svc(ssh(255, "No ED25519 host key is known for 192.0.2.10 and you have requested strict checking.\nHost key verification failed.")).test({ alias: "prod-vps" });
    assert.equal(unknown.result.kind, "host_key_unknown");
    const changed = classify(255, "@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\nHost key verification failed.");
    assert.equal(changed.kind, "host_key_changed");
    assert.match(changed.hint, /won't do this/);
  });

  test("key problems", () => {
    assert.equal(classify(255, "Warning: Identity file /x/k not accessible: No such file or directory.\nno such identity: /x/k: No such file or directory\nPermission denied (publickey).").kind, "key_missing");
    assert.equal(classify(255, "@ WARNING: UNPROTECTED PRIVATE KEY FILE! @").kind, "key_permissions");
    assert.equal(classify(255, 'Load key "/x/k": invalid format').kind, "key_invalid");
  });

  test("21. successful connection", async () => {
    const s = ssh(0, "");
    const r = await svc(s).test({ alias: "prod-vps" });
    assert.equal(r.result.kind, "ok");
    const call = s.calls.find((c) => c[0] === "ssh" && c[1] === "-T");
    assert.ok(call.includes("BatchMode=yes"));
  });

  test("unsaved fields are tested through a temp config (-F), not the real one", async () => {
    const s = ssh(0, "");
    const r = await svc(s).test({ fields: { ...FIELDS, alias: "new-one" } });
    assert.equal(r.scope, "unsaved");
    const call = s.calls.find((c) => c[0] === "ssh" && c[1] === "-T");
    assert.equal(call[2], "-F");
  });
});

// sanity: the real ssh accepts what we render
test("rendered block passes `ssh -G` on this machine", async () => {
  await freshHome();
  const s = svc();
  const p = await s.plan({ action: "add", fields: FIELDS });
  const file = path.join(HOME, "check.conf");
  await fsp.writeFile(file, p.changes.find((c) => c.path === managedPath()).after);
  const out = execFileSync("ssh", ["-G", "-F", file, "--", "prod-vps"], { encoding: "utf8" });
  assert.match(out, /^hostname 192\.0\.2\.10$/m);
});
