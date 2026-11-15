// Validation of the fields a person types. Everything that ends up in a config line passes
// through here first: no control characters (so no newline/directive injection), no quotes,
// and each field restricted to the characters its value can legitimately hold.

import path from "node:path";
import net from "node:net";

const CONTROL = new RegExp("[\\x00-\\x1f\\x7f\\u2028\\u2029]");

export function expandHome(p, home) {
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

/** How a key path is written into the config: `~/...` under home, else absolute. */
export function configPath(abs, home) {
  const rel = path.relative(home, abs);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? `~/${rel.split(path.sep).join("/")}` : abs;
}

export function validateAlias(v) {
  if (!v) return "Enter a connection name";
  if (CONTROL.test(v)) return "Must not contain control characters or line breaks";
  if (v.length > 63) return "At most 63 characters";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v)) return "Letters, digits, '.', '_' and '-' only, starting with a letter or digit (no spaces or wildcards)";
  return null;
}

export function validateHostname(v) {
  if (!v) return "Enter a hostname or IP address";
  if (CONTROL.test(v)) return "Must not contain control characters or line breaks";
  const bare = v.startsWith("[") && v.endsWith("]") ? v.slice(1, -1) : v;
  if (net.isIP(bare)) return null;
  if (/^\d+(\.\d+){3}$/.test(v)) return "Not a valid IPv4 address";
  if (v.length > 253) return "Hostname too long";
  const labels = v.replace(/\.$/, "").split(".");
  for (const l of labels) {
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(l) && !/^[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9])?$/.test(l)) {
      return "Not a valid hostname (letters, digits, '-' and dots)";
    }
  }
  return null;
}

export function validateUser(v) {
  if (!v) return "Enter the remote username";
  if (CONTROL.test(v)) return "Must not contain control characters or line breaks";
  if (v.length > 64) return "At most 64 characters";
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(v)) return "Letters, digits, '.', '_' and '-' only";
  return null;
}

export function parsePort(v) {
  const s = String(v ?? "").trim();
  if (s === "") return { port: 22 };
  if (!/^\d{1,5}$/.test(s)) return { error: "Port must be a number from 1 to 65535" };
  const n = Number(s);
  if (n < 1 || n > 65535) return { error: "Port must be from 1 to 65535" };
  return { port: n };
}

/**
 * Checks a private key path without reading the key: it must be absolute (after ~), a regular
 * file, readable, not a .pub file. `fs` is node:fs/promises-like.
 * Returns { error } or { abs, written, warnings }.
 */
export async function checkKeyPath(v, { home, fs }) {
  if (!v) return { error: "Choose a private key file" };
  if (CONTROL.test(v)) return { error: "Must not contain control characters or line breaks" };
  if (v.includes('"')) return { error: "Must not contain double quotes" };
  if (/%|\$\{/.test(v)) return { error: "ssh tokens (%h, ${VAR}) aren't supported here; enter a real path" };
  const expanded = expandHome(v.trim(), home);
  if (!path.isAbsolute(expanded)) return { error: "Use an absolute path or one starting with ~/" };
  const abs = path.normalize(expanded);
  let st;
  try {
    st = await fs.stat(abs);
  } catch (e) {
    return { error: e.code === "ENOENT" ? `No file at ${abs}` : `Can't check ${abs}: ${e.code ?? e.message}` };
  }
  if (!st.isFile()) return { error: `${abs} is not a file` };
  try {
    await fs.access(abs, 4 /* R_OK */);
  } catch {
    return { error: `${abs} isn't readable by you` };
  }
  const warnings = [];
  if (abs.endsWith(".pub")) return { error: "That's the public key (.pub); choose the private key next to it" };
  if ((st.mode & 0o077) !== 0) warnings.push(`${abs} is readable by other users (mode ${(st.mode & 0o777).toString(8)}); ssh refuses such keys. Fix: chmod 600 ${abs}`);
  if (st.size > 64 * 1024) warnings.push("That file is unusually large for a private key");
  return { abs, written: configPath(abs, home), warnings };
}

/** Validates all form fields. Returns { errors: {field: msg}, warnings: [], fields }. */
export async function validateFields(input, ctx) {
  const errors = {};
  const alias = String(input.alias ?? "").trim();
  const hostname = String(input.hostname ?? "").trim().replace(/^\[(.*)\]$/, "$1");
  const user = String(input.user ?? "").trim();
  const e1 = validateAlias(alias); if (e1) errors.alias = e1;
  const e2 = validateHostname(hostname); if (e2) errors.hostname = e2;
  const e3 = validateUser(user); if (e3) errors.user = e3;
  const p = parsePort(input.port);
  if (p.error) errors.port = p.error;
  const k = await checkKeyPath(String(input.identityFile ?? "").trim(), ctx);
  if (k.error) errors.identityFile = k.error;
  return {
    errors,
    warnings: k.warnings ?? [],
    fields: { alias, hostname, user, port: p.port ?? null, identityFile: k.written ?? null, identityAbs: k.abs ?? null },
  };
}
