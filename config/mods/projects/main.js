// Projects: every folder under a projects root (config.json "root", "~" allowed), one row each.
// Click: go to the space already working there, else open a new space with a terminal in it.
// The Claude button opens a new space running claude there. ⚙ picks the root (saved to config.json).
// Roles (props.role): the list (default); "switch", the Spaces | Projects header of the
// sidebar stack (props.stack, default "sidebar-switch").

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, panes, run, exec, theme, home, appHome, layout, readTextFile, writeTextFile, pickFolder, props } from "herdr";

const REFRESH = 30000;
const configPath = () => `${appHome()}/mods/projects/config.json`;
const expand = (p) => (p === "~" ? home() : p.startsWith("~/") ? `${home()}/${p.slice(2)}` : p);
const tilde = (p) => (p === home() ? "~" : p.startsWith(home() + "/") ? `~/${p.slice(home().length + 1)}` : p);
const base = (p) => p.replace(/\/+$/, "").split("/").pop();
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// Local spaces by the project folder they work in (any terminal inside it, else where it was made).
export function spacesByProject(dirs, sp, ps) {
  const inside = (path, dir) => path === dir || path.startsWith(dir + "/");
  const byTab = {};
  for (const p of ps) if (p.cwd) (byTab[p.tab] ??= []).push(p.cwd);
  const out = {};
  for (const s of sp) {
    if (s.machine) continue;
    const places = [...(s.tabs ?? []).flatMap((t) => byTab[t.id] ?? []), s.folder].filter(Boolean);
    for (const dir of dirs) if (places.some((c) => inside(c, dir))) (out[dir] ??= []).push(s);
  }
  return out;
}

function Switch(t) {
  const stackId = props()?.stack ?? "sidebar-switch";
  const stack = find(layout(), stackId);
  const active = stack?.active ?? stack?.children?.[0]?.id;
  const pill = (id, label) =>
    h_flex().id(`switch-${id}`).h(24).px(10).items_center().rounded(6).text_size(11.5).cursor_pointer()
      .text_color(active === id ? t.foreground : t.dim)
      .when(active === id, (el) => el.bg(t.selected))
      .when(active !== id, (el) => el.hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .on_click(() => run("layout.select", { stack: stackId, child: id }))
      .child(label);
  const kids = stack?.children ?? [];
  return h_flex().size_full().bg(t.chrome).px(10).gap(4).items_center()
    .children(kids.map((k) => pill(k.id, k.id === "projects" ? "Projects" : k.id === "spaces" ? "Spaces" : k.id)));
}

export default class Projects extends View {
  init(_props, cx) {
    if (props()?.role === "switch") return;
    this.root = null;
    this.dirs = [];
    this.error = null;
    this.filter = "";
    this.input = InputState.new({ placeholder: "Filter projects…" });
    this.input.on("change", (_e, cx) => { this.filter = this.input.value(); cx.notify(); });
    this.reload(cx);
    cx.timer.every(REFRESH, (cx) => this.reload(cx));
  }

  reload(cx) {
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(configPath());
        const cfg = text ? JSON.parse(text) : {};
        this.root = expand(String(cfg.root ?? "~/Projects")).replace(/\/+$/, "");
        const r = await exec("find", ["-L", this.root, "-mindepth", "1", "-maxdepth", "1", "-type", "d", "-not", "-name", ".*"]);
        if (r.code !== 0 && !r.stdout.trim()) throw new Error(r.stderr.trim() || `can't read ${this.root}`);
        this.dirs = r.stdout.split("\n").filter(Boolean).sort((a, b) => (base(a).toLowerCase() < base(b).toLowerCase() ? -1 : 1));
        this.error = null;
      } catch (e) {
        this.error = String(e?.message ?? e);
        this.dirs = [];
      }
      cx.notify();
    });
  }

  choose(cx) {
    cx.spawn(async (cx) => {
      const dir = await pickFolder({ prompt: "Projects folder" });
      if (!dir) return;
      const before = await readTextFile(configPath());
      let cfg = {};
      try { cfg = before ? JSON.parse(before) : {}; } catch {}
      cfg.root = tilde(dir.replace(/\/+$/, ""));
      await writeTextFile(configPath(), JSON.stringify(cfg, null, 2) + "\n", before);
      this.reload(cx);
    });
  }

  open(dir, open, argv) {
    if (!argv && open.length) {
      const pick = open.find((s) => s.active) ?? open[0];
      run("space.select", { id: pick.id });
    } else {
      run("space.new", { folder: dir, ...(argv ? { argv } : {}) });
    }
  }

  row(dir, open, t) {
    const status = open.map((s) => s.status).filter(Boolean).sort((a, b) => RANK[b] - RANK[a])[0] ?? null;
    const active = open.some((s) => s.active);
    const name = base(dir);
    return h_flex().id(`project-${name}`).h(28).flex_none().px(8).gap(8).items_center().rounded(8).cursor_pointer()
      .when(active, (el) => el.bg(t.selected))
      .when(!active, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click(() => this.open(dir, open))
      .child(div().w(8).flex_none().text_size(10)
        .text_color(status ? t[status] ?? t.unknown : t.dim)
        .child(open.length ? "●" : ""))
      .child(div().flex_1().min_w(0).truncate().text_color(open.length ? t.foreground : t.muted).child(name))
      .when(open.length > 1, (el) => el.child(div().text_size(10.5).text_color(t.dim).child(`${open.length}`)))
      .child(div().id(`project-claude-${name}`).size(20).flex_none().flex().items_center().justify_center().rounded(5)
        .opacity(0.55).hover((s) => s.bg(t.raised).opacity(1))
        .tooltip("New space with Claude Code")
        .on_click((_e, cx) => { cx.stop_propagation(); this.open(dir, open, ["claude"]); })
        .child(image("icons/claude.svg").size(13)));
  }

  render(cx) {
    const t = theme();
    if (props()?.role === "switch") return Switch(t);
    const q = this.filter.trim().toLowerCase();
    const dirs = q ? this.dirs.filter((d) => base(d).toLowerCase().includes(q)) : this.dirs;
    const byDir = spacesByProject(this.dirs, spaces(), panes());
    const iconButton = (id, icon, tip, onClick) =>
      div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim)
        .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip).on_click(onClick).child(icon);
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(31).pl(16).pr(6).gap(2).items_center().text_size(11.5).text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().tooltip(this.root ?? "").child(this.root ? tilde(this.root) : "Projects"))
        .child(iconButton("projects-refresh", "↻", "Refresh", (_e, cx) => this.reload(cx)))
        .child(iconButton("projects-root", "⚙", "Choose projects folder", (_e, cx) => this.choose(cx))))
      .child(div().px(8).pb(6).flex_none()
        .child(Input.new(this.input).h(26).px(8).rounded(6).border_1().border_color(t.border).bg(t.background).text_size(12).text_color(t.foreground)))
      .child(v_flex().flex_1().min_h(0).px(8).pb(14).overflow_y_scrollbar()
        .when(Boolean(this.error), (el) => el.child(div().px(8).py(6).text_size(12).text_color(t.blocked).child(this.error)))
        .when(!this.error && this.root !== null && dirs.length === 0, (el) => el.child(div().px(8).py(6).text_size(12).text_color(t.dim).child(q ? "No matches" : "No folders here")))
        .children(dirs.map((d) => this.row(d, byDir[d] ?? [], t))));
  }
}
