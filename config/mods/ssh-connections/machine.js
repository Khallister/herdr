// Herdr machine side of an SSH connection. Pure functions (no imports), so node can test them.
// An ssh config entry and a Herdr machine (`hc machine ls`) are separate things: this only
// relates them.

/** The registered Herdr machine for a connection, if any: by name, by ssh target, or by address. */
export function findMachine(machines, conn) {
  const list = (machines ?? []).filter((m) => !m.temporary);
  const byName = list.find((m) => m.name === conn.alias);
  if (byName) return { machine: byName, match: "name" };
  const byTarget = list.find((m) => m.target === conn.alias);
  if (byTarget) return { machine: byTarget, match: "target" };
  const e = conn.effective ?? {};
  if (e.hostname && e.user) {
    const forms = [`${e.user}@${e.hostname}`, `${e.user}@${e.hostname}:${e.port ?? 22}`];
    if (Number(e.port ?? 22) === 22) forms.push(e.hostname);
    const byAddr = list.find((m) => forms.includes(m.target));
    if (byAddr) return { machine: byAddr, match: "address" };
  }
  return null;
}

/** Human status of a Herdr machine from `hc machine ls --json`. */
export function machineState(m) {
  if (!m) return { kind: "none", label: "Not a Herdr machine" };
  if (m.state === "needs_login") return { kind: "login", label: "Herdr machine: needs a login" };
  if (m.state === "connected" || m.state === "ready" || m.state === "ok") return { kind: "ok", label: "Herdr machine: connected" };
  return { kind: "other", label: `Herdr machine: ${String(m.state ?? "unknown").replace(/_/g, " ")}` };
}

const INTERACTIVE = ["hc_missing", "incompatible", "login_needed", "auth_failed", "host_key"];

/** Reads `hc machine add --json`'s result: { ok } | { interactive, message } | { error }. */
export function parseAddResult(r) {
  if (r && r.code === 0) return { ok: true };
  let why;
  try {
    why = JSON.parse((r?.stdout || r?.stderr || "").trim()).error ?? null;
  } catch {
    why = null;
  }
  const message = (why?.message ?? (r?.stderr || r?.stdout || "hc didn't answer")).trim();
  if (INTERACTIVE.includes(why?.kind) || /password|passphrase|host key|permission denied|login/i.test(message)) {
    return { interactive: true, kind: why?.kind ?? null, message };
  }
  return { error: message || `hc exited ${r?.code}` };
}

/** Arguments for registering a configured alias as a Herdr machine of the same name. */
export const addArgs = (alias) => ["machine", "add", alias, "--name", alias, "--json"];
