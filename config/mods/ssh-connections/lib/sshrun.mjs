// The system OpenSSH client, always run with an argument vector (execFile, no shell).
// `runner(cmd, args, { timeout })` resolves { code, stdout, stderr, timedOut } and is
// injectable so tests never start ssh.

import { execFile } from "node:child_process";

export function systemRunner(cmd, args, { timeout = 15000, env } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024, env: env ?? process.env, windowsHide: true }, (err, stdout, stderr) => {
      if (err && err.code === "ENOENT") return resolve({ code: 127, stdout: "", stderr: `${cmd}: not found`, timedOut: false });
      const timedOut = Boolean(err?.killed);
      resolve({ code: err ? (typeof err.code === "number" ? err.code : timedOut ? 124 : 1) : 0, stdout: String(stdout), stderr: String(stderr), timedOut });
    });
  });
}

/** Parses `ssh -G` output: lowercase key -> value (multi-valued keys -> arrays). */
export function parseG(text) {
  const multi = new Set(["identityfile", "certificatefile", "localforward", "remoteforward", "dynamicforward", "sendenv", "setenv"]);
  const out = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf(" ");
    if (i <= 0) continue;
    const k = line.slice(0, i), v = line.slice(i + 1).trim();
    if (multi.has(k)) (out[k] ??= []).push(v);
    else if (!(k in out)) out[k] = v;
  }
  return out;
}

/** Effective settings for `alias` (optionally from config file `configFile`). */
export async function effective(runner, alias, configFile = null) {
  const args = ["-G", ...(configFile ? ["-F", configFile] : []), "--", alias];
  const r = await runner("ssh", args, { timeout: 8000 });
  if (r.code !== 0) return { error: cleanStderr(r.stderr) || `ssh -G exited ${r.code}` };
  const g = parseG(r.stdout);
  return { hostname: g.hostname, user: g.user, port: Number(g.port) || 22, identityFiles: g.identityfile ?? [], raw: g };
}

export function cleanStderr(s) {
  return String(s ?? "").split("\n").map((l) => l.trim()).filter((l) => l && !/^Pseudo-terminal will not be allocated/.test(l) && !/^debug\d?:/.test(l)).join("\n");
}

/** Arguments for a non-interactive connection test. Never weakens host key checking. */
export function testArgs(alias, configFile = null) {
  return [
    "-T",
    ...(configFile ? ["-F", configFile] : []),
    "-o", "BatchMode=yes", // no password / passphrase / host key prompts
    "-o", "ConnectTimeout=8",
    "-o", "ConnectionAttempts=1",
    "-o", "StrictHostKeyChecking=yes", // unknown or changed keys fail, even if the config says accept-new
    "-o", "UpdateHostKeys=no", // the test never writes known_hosts
    "-o", "ControlMaster=no",
    "-o", "ControlPath=none", // test a fresh connection, not a multiplexed one
    "-o", "ForwardAgent=no",
    "-o", "ClearAllForwardings=yes",
    "-o", "PermitLocalCommand=no",
    "-o", "RemoteCommand=none",
    "-o", "RequestTTY=no",
    "--", alias, "true",
  ];
}

/** Turns ssh's stderr into { kind, message, hint }. */
export function classify(code, stderr, timedOut = false) {
  const s = cleanStderr(stderr);
  const last = s.split("\n").filter(Boolean).pop() ?? "";
  const R = (kind, message, hint = null) => ({ kind, message, hint, detail: s });
  if (code === 0) return { kind: "ok", message: "Connected and authenticated with the key", hint: null, detail: s };
  if (code === 127 && /not found/.test(s)) return R("no_ssh", "The ssh program wasn't found");
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key for .* has changed/i.test(s)) {
    return R("host_key_changed", "The server's host key has CHANGED since you last connected", "This can mean the server was reinstalled, or that someone is intercepting the connection. Confirm the new fingerprint with the server's provider before removing the old key with `ssh-keygen -R <host>`. Herdr won't do this for you.");
  }
  if (/No (\S+ )?host key is known for|Host key verification failed/i.test(s)) {
    return R("host_key_unknown", "The server's host key isn't trusted yet", "Review the fingerprint and accept it yourself (Review host key).");
  }
  if (/Bad configuration option|terminating, \d+ bad configuration|garbage at end of line|Bad owner or permissions on/i.test(s)) return R("config", "ssh rejected the configuration", last);
  if (/UNPROTECTED PRIVATE KEY FILE|bad permissions/i.test(s)) return R("key_permissions", "ssh refuses the key: its permissions are too open", "Run chmod 600 on the key file.");
  if (/no such identity|Load key .*: No such file/i.test(s)) return R("key_missing", "The private key file wasn't found", last);
  if (/Load key .*: (invalid format|error in libcrypto)|invalid format/i.test(s)) return R("key_invalid", "The key file isn't a private key ssh can read", last);
  if (/Could not resolve hostname|nodename nor servname|Name or service not known|Temporary failure in name resolution/i.test(s)) return R("dns", "The hostname couldn't be resolved (DNS)", last);
  if (/Connection refused/i.test(s)) return R("refused", "The server refused the connection (nothing listening on that port?)", last);
  if (timedOut || /timed out|Operation timed out/i.test(s)) return R("timeout", "The server didn't answer in time (unreachable, firewalled, or wrong port)", last);
  if (/No route to host|Network is unreachable|Host is down/i.test(s)) return R("unreachable", "The server is unreachable", last);
  if (/Permission denied \(|Too many authentication failures|Authentication failed/i.test(s)) {
    return R("auth", "Authentication failed: the server didn't accept this key for this user", "Check the username and that the public key is in the server's authorized_keys. If the key has a passphrase, add it to the agent first: ssh-add --apple-use-keychain <key> (macOS) or ssh-add <key>.");
  }
  if (/Connection closed by|Connection reset by|kex_exchange_identification/i.test(s)) return R("closed", "The server closed the connection during the handshake", last);
  return R("error", last || `ssh exited with ${code}`);
}

/** Fingerprints of what the server presents right now (unauthenticated scan, for comparison). */
export async function scanHostKeys(runner, fsp, tmpFile, { hostname, port }) {
  const r = await runner("ssh-keyscan", ["-T", "5", "-p", String(port), "--", hostname], { timeout: 12000 });
  const lines = r.stdout.split("\n").filter((l) => l && !l.startsWith("#"));
  if (!lines.length) return { error: cleanStderr(r.stderr) || "the server didn't present a host key" };
  await fsp.writeFile(tmpFile, lines.join("\n") + "\n", { mode: 0o600 });
  try {
    const f = await runner("ssh-keygen", ["-l", "-f", tmpFile], { timeout: 5000 });
    const keys = f.stdout.split("\n").filter(Boolean).map((l) => {
      const m = /^(\d+)\s+(\S+)\s+.*\((\w[\w-]*)\)$/.exec(l.trim());
      return m ? { bits: Number(m[1]), fingerprint: m[2], type: m[3] } : { fingerprint: l.trim() };
    });
    return { keys };
  } finally {
    await fsp.unlink(tmpFile).catch(() => {});
  }
}

/** Whether known_hosts already has a key for host[:port]. */
export async function knownHost(runner, { hostname, port }) {
  const name = port === 22 ? hostname : `[${hostname}]:${port}`;
  const r = await runner("ssh-keygen", ["-F", name], { timeout: 5000 });
  return r.code === 0 && r.stdout.trim().length > 0;
}
