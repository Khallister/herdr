// Run: node --test mods/ssh-connections/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { findMachine, parseAddResult, machineState, addArgs } from "../machine.js";
import { checkRecipeMachine, confirmReachable } from "../../projects/remote.js";

const conn = { alias: "prod-vps", effective: { hostname: "192.0.2.10", user: "deploy", port: 22 } };

test("22. existing Herdr machine registration is found by name, target or address", () => {
  assert.equal(findMachine([{ name: "prod-vps", state: "connected" }], conn).match, "name");
  assert.equal(findMachine([{ name: "x", target: "prod-vps" }], conn).match, "target");
  assert.equal(findMachine([{ name: "192.0.2.10", target: "deploy@192.0.2.10" }], conn).match, "address");
  assert.equal(findMachine([{ name: "prod-vps", temporary: true }], conn), null);
  assert.equal(findMachine([], conn), null);
  assert.equal(machineState({ state: "needs_login" }).kind, "login");
  assert.deepEqual(addArgs("prod-vps"), ["machine", "add", "prod-vps", "--name", "prod-vps", "--json"]);
});

test("23. failed Herdr machine registration: interactive vs hard errors", () => {
  assert.equal(parseAddResult({ code: 0, stdout: "{}" }).ok, true);
  const login = parseAddResult({ code: 1, stdout: JSON.stringify({ error: { kind: "host_key", message: "unknown host key" } }) });
  assert.equal(login.interactive, true);
  const hard = parseAddResult({ code: 1, stdout: "", stderr: "ssh: Could not resolve hostname prod-vps" });
  assert.match(hard.error, /resolve/);
});

test("24. recipe referencing a missing remote machine fails with no local fallback", () => {
  const r = checkRecipeMachine({ machine: "ghost", tabs: [] }, [{ name: "prod-vps", state: "connected" }]);
  assert.equal(r.ok, false);
  assert.match(r.error, /isn't registered/);
  assert.match(r.error, /Nothing was started/);
  assert.equal(checkRecipeMachine({ tabs: [] }, []).machine, null); // no machine: local, as before
  assert.equal(checkRecipeMachine({ machine: "a b" }, []).ok, false);
});

test("25. recipe needing a machine that isn't connected doesn't run", async () => {
  const login = checkRecipeMachine({ machine: "prod-vps" }, [{ name: "prod-vps", state: "needs_login" }]);
  assert.match(login.error, /needs a login/);
  const down = await confirmReachable("prod-vps", async () => { throw new Error("machine unreachable"); });
  assert.equal(down.ok, false);
  assert.match(down.error, /can't be reached/);
  const fails = await confirmReachable("prod-vps", async () => ({ code: 255, stderr: "Connection refused" }));
  assert.equal(fails.ok, false);
  assert.equal((await confirmReachable("prod-vps", async () => ({ code: 0 }))).ok, true);
});
