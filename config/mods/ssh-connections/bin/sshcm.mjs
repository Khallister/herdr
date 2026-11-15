#!/usr/bin/env node
// CLI behind the SSH Connections mod: `node sshcm.mjs <command> '<json>'` prints one JSON object.
// Commands: list, plan, apply, test, hostkey, keys. Never reads or prints private key contents.

import fs from "node:fs/promises";
import os from "node:os";
import { createService } from "../lib/service.mjs";
import { systemRunner } from "../lib/sshrun.mjs";

const [cmd, json] = process.argv.slice(2);
const svc = createService({ fs, home: os.userInfo().homedir, runner: systemRunner, platform: process.platform, tmpdir: os.tmpdir() });
const handlers = { list: () => svc.list(), plan: (a) => svc.plan(a), apply: (a) => svc.apply(a), test: (a) => svc.test(a), hostkey: (a) => svc.hostkey(a), keys: (a) => svc.keys(a) };

try {
  if (!handlers[cmd]) throw new Error(`unknown command ${cmd}; use ${Object.keys(handlers).join(", ")}`);
  const arg = json ? JSON.parse(json) : {};
  const out = await handlers[cmd](arg);
  process.stdout.write(JSON.stringify(out) + "\n");
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(e?.message ?? e) }) + "\n");
}
