// Run: node mods/agent-board/logic.test.mjs (no Herdr window required).
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const source = fs.readFileSync(new URL("./main.js", import.meta.url), "utf8")
  .replace(/^import .*;$/gm, "")
  .replace("export default class AgentBoard", "class AgentBoard")
  .replace(/export function/g, "function");
let list = [];
const calls = [];
const sandbox = {
  View: class {}, Date,
  agents: () => list,
  spaces: () => [{ tabs: [{ id: "tab", changed_at: Date.now() - 400000, working_since: Date.now() - 800000 }] }],
  run: (...args) => calls.push(args),
  props: () => ({ overlay: "board" }),
  closeOverlay: id => calls.push(["close", id]),
};
vm.runInNewContext(source + "\nglobalThis.api = { AgentBoard, contextUsed, elapsed };", sandbox);
const { AgentBoard, contextUsed, elapsed } = sandbox.api;

assert.equal(contextUsed("Opus 5.5 | herdr-app ███ 16%", "claude-code"), 16);
assert.equal(contextUsed("\x1b[32m82% context left\x1b[0m", "codex"), 18);
assert.equal(contextUsed("The tests are 80% complete", "claude-code"), null);
assert.equal(contextUsed("101% context left", "codex"), null);
assert.equal(contextUsed("context: 0%", "claude"), 0);
assert.equal(contextUsed("0% context left", "codex"), 100);
assert.equal(contextUsed(""), null);
assert.equal(elapsed(300001), "5m");
assert.equal(elapsed(-1), "<1m");

const board = new AgentBoard();
board.changed = new Map();
board.context = new Map();
list = [
  { address: "idle", status: "idle", tab: "tab" },
  { address: "working", status: "working", tab: "tab" },
  { address: "done", status: "done", tab: "tab" },
  { address: "blocked", status: "blocked", tab: "tab" },
  { address: "pin", status: "idle", tab: "tab", pinned: true },
];
assert.equal(board.sorted().map(a => a.address).join(","), "pin,blocked,done,working,idle");
board.changed.get("blocked").since = 1;
list.push({ address: "blocked-new", status: "blocked", tab: "tab" });
assert.equal(board.sorted()[1].address, "blocked");
board.oldest();
assert.equal(calls[0][0], "agent.focus");
assert.equal(calls[0][1].terminal, "blocked");
assert.equal(calls[1][0], "close");
list = list.filter(a => a.status !== "blocked");
calls.length = 0;
board.oldest();
assert.equal(calls[0][1].terminal, "done");
list.find(a => a.address === "working").status = "done";
board.track();
assert.ok(Date.now() - board.changed.get("working").since < 1000);
assert.equal(board.changed.has("blocked"), false);
let cancelled = 0;
board.timers = [{ cancel() { cancelled++; } }, { cancel() { cancelled++; } }];
board.close();
assert.equal(cancelled, 2);
assert.equal(board.closed, true);
console.log("PASS: context, durations, pin/urgency/age sorting, oldest fallback, status transitions, cleanup");
