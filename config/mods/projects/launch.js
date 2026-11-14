// Project launch recipes: <project>/.herdr.json (or config.json "defaultRecipe") describes the
// space a project opens as. Commands are sent one by one; each step waits until Herdr shows what
// the last one made (a space, a tab, a pane), so later steps can name it.
//
// {
//   "name": "optional space name",
//   "tabs": [
//     { "name": "dev", "panes": [
//         { "argv": ["claude"], "task": "optional first message" },
//         { "argv": ["pnpm", "dev"], "split": "right" },
//         { "mod": "devservers", "split": "down", "of": 1 } ] },
//     { "name": "git", "panes": [{ "argv": ["lazygit"] }] } ]
// }
// A pane without argv/mod is a shell. "split" is right (default) or down, "of" the index of the
// pane in that tab to split (default: the previous one). A tab's first pane must be a terminal
// in the first tab (space.new can't start a mod), any pane elsewhere.

import { spaces, panes, run, readTextFile } from "herdr";

export const RECIPE_FILE = ".herdr.json";

export const TEMPLATE = {
  tabs: [
    { name: "dev", panes: [{ argv: ["claude"] }, { split: "right" }] },
    { name: "git", panes: [{ argv: ["lazygit"] }] },
  ],
};

export async function readRecipe(dir) {
  const text = await readTextFile(`${dir}/${RECIPE_FILE}`);
  if (text == null) return null;
  const r = JSON.parse(text);
  if (!Array.isArray(r.tabs) || !r.tabs.length) throw new Error(`${RECIPE_FILE}: "tabs" must be a non-empty list`);
  return r;
}

async function until(cx, what, find, ms = 8000) {
  for (let waited = 0; waited < ms; waited += 100) {
    const found = find();
    if (found) return found;
    await cx.sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const terminalArgs = (p) => ({ ...(p.argv ? { argv: p.argv } : {}), ...(p.task ? { task: p.task } : {}) });
const tabPanes = (tabId) => panes().filter((p) => p.tab === tabId);

// Opens `dir` as a new space following `recipe`. Returns the space id.
export async function launch(cx, dir, recipe) {
  const known = new Set(spaces().map((s) => s.id));
  const [first, ...more] = recipe.tabs;
  const lead = first.panes?.[0] ?? {};
  run("space.new", { folder: dir, ...(recipe.name ? { name: recipe.name } : {}), ...(first.name ? { tab: first.name } : {}), ...terminalArgs(lead) });
  const space = await until(cx, "the new space", () => spaces().find((s) => !known.has(s.id) && s.tabs?.length));
  const firstTab = space.tabs[0].id;
  await fillTab(cx, firstTab, first.panes ?? [{}], 1);

  for (const tab of more) {
    const before = new Set((spaces().find((s) => s.id === space.id)?.tabs ?? []).map((t) => t.id));
    const head = tab.panes?.[0] ?? {};
    run("tab.new", { space: space.id, folder: dir, ...(tab.name ? { name: tab.name } : {}),
      ...(head.mod ? { mod: head.mod, ...(head.props ? { props: head.props } : {}) } : terminalArgs(head)) });
    const made = await until(cx, `tab ${tab.name ?? ""}`, () => spaces().find((s) => s.id === space.id)?.tabs.find((t) => !before.has(t.id)));
    await fillTab(cx, made.id, tab.panes ?? [{}], 1);
  }
  if (more.length) run("tab.select", { id: firstTab });
  return space.id;
}

async function fillTab(cx, tabId, list, from) {
  const made = [await until(cx, "the tab's first pane", () => tabPanes(tabId)[0])];
  for (let i = from; i < list.length; i++) {
    const p = list[i];
    const target = made[Number.isInteger(p.of) ? p.of : made.length - 1] ?? made[made.length - 1];
    const known = new Set(tabPanes(tabId).map((x) => x.pane));
    run("pane.split", { pane: target.pane, direction: p.split === "down" ? "down" : "right",
      ...(p.mod ? { mod: p.mod, ...(p.props ? { props: p.props } : {}) } : terminalArgs(p)) });
    made.push(await until(cx, `pane ${i + 1}`, () => tabPanes(tabId).find((x) => !known.has(x.pane))));
  }
  run("pane.focus", { pane: made[0].pane });
}
