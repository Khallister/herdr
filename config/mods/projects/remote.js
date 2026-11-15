// Remote targets for launch recipes: `"machine": "<Herdr machine name>"` in .herdr.json.
// Pure functions (no imports) so node can test them; launch.js supplies the live data.
// A recipe that names a machine never falls back to running locally.

/** Checks `recipe.machine` against `hc machine ls --json` machines. */
export function checkRecipeMachine(recipe, machines) {
  if (recipe?.machine == null || recipe.machine === "") return { ok: true, machine: null };
  const name = recipe.machine;
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._@:-]*$/.test(name)) {
    return { ok: false, error: `"machine" must be the name of a Herdr machine, got ${JSON.stringify(name)}` };
  }
  const m = (machines ?? []).find((x) => x.name === name);
  if (!m) {
    const known = (machines ?? []).filter((x) => !x.temporary).map((x) => x.name);
    return { ok: false, error: `This recipe runs on machine "${name}", which isn't registered in Herdr${known.length ? ` (registered: ${known.join(", ")})` : ""}. Add it in SSH Connections (cmd-shift-h) or with \`hc machine add ${name}\`. Nothing was started.` };
  }
  if (m.state === "needs_login") {
    return { ok: false, error: `Machine "${name}" needs a login before anything can run there: run \`hc machine login ${name}\` (Machines panel: Log in). Nothing was started.` };
  }
  return { ok: true, machine: name };
}

/** Confirms the machine answers before anything is started. `probe()` runs `true` there. */
export async function confirmReachable(name, probe) {
  let r;
  try {
    r = await probe();
  } catch (e) {
    return { ok: false, error: `Machine "${name}" can't be reached: ${String(e?.message ?? e)}. Nothing was started; check the connection in SSH Connections.` };
  }
  if (r?.code !== 0) {
    return { ok: false, error: `Machine "${name}" didn't run a test command (exit ${r?.code}${r?.stderr ? `: ${String(r.stderr).trim().split("\n").pop()}` : ""}). Nothing was started.` };
  }
  return { ok: true };
}
