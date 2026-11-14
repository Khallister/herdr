// Attention: floating strip with the agents that need you (status blocked or done).
// Empty list = empty div(), which hides the floating block. Click focuses the agent;
// right-click on a "done" row hides it locally until its status changes.
// Layout: vertical on left/right edges (mirrored on the right so the status dot and program
// icon sit on the edge side, the part a peek drawer shows), chips on top/bottom.
// No props.role, no nextCommand commands.

import { View, div, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, run, theme, placement } from "herdr";

const DEMO = false;
const WIDTH = 240;

const age = (ms) => {
  const m = Math.floor(ms / 60000);
  return m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
};

const demoAgents = () => [
  { address: "demo1", status: "blocked", space_name: "herdr", tab_name: "1", title: "Waiting for permission", program: { name: "Claude", icon: null, tile: "#d97757" } },
  { address: "demo2", status: "done", space_name: "api", tab_name: "fix login", title: "Finished refactor", program: { name: "Codex", icon: null, tile: "#334155" } },
];

export default class Attention extends View {
  init(_props, cx) {
    this.since = {}; // address -> { status, at }
    this.seen = {}; // address -> status hidden by right-click
    cx.timer.every(30000, (cx) => { if (this.count > 0) cx.notify(); });
  }

  list() {
    const all = DEMO ? demoAgents() : agents();
    const now = Date.now();
    const live = new Set();
    const out = [];
    for (const a of all) {
      live.add(a.address);
      if (a.status !== "blocked" && a.status !== "done") { delete this.since[a.address]; delete this.seen[a.address]; continue; }
      const s = this.since[a.address];
      if (!s || s.status !== a.status) this.since[a.address] = { status: a.status, at: now };
      if (this.seen[a.address] && this.seen[a.address] !== a.status) delete this.seen[a.address];
      if (this.seen[a.address] === a.status) continue;
      out.push(a);
    }
    for (const k of Object.keys(this.since)) if (!live.has(k)) { delete this.since[k]; delete this.seen[k]; }
    // blocked first, then the longest waiting
    out.sort((x, y) => (x.status === y.status ? this.since[x.address].at - this.since[y.address].at : x.status === "blocked" ? -1 : 1));
    return out;
  }

  dot(a, t) {
    const d = div().w(8).h(8).rounded(4).flex_none().bg(a.status === "blocked" ? t.blocked : t.done);
    return a.status === "blocked" ? d.loop("opacity", { from: 0.35, to: 1, period: 1100 }) : d;
  }

  icon(a, t) {
    const p = a.program ?? {};
    const box = div().size(18).flex_none().flex().items_center().justify_center().rounded(4);
    return p.icon
      ? box.child(image(p.icon).size(14))
      : box.bg(p.tile ?? t.raised).text_size(10).text_color(t.foreground).child([...(p.name ?? "?")][0]?.toUpperCase() ?? "?");
  }

  act(a, cx) {
    if (DEMO) return;
    run("agent.focus", { terminal: a.address });
  }

  row(a, t, mirror) {
    const since = age(Date.now() - this.since[a.address].at);
    const where = [a.space_name, a.tab_name].filter(Boolean).join(" · ");
    const edge = [this.dot(a, t), this.icon(a, t)];
    const body = v_flex().flex_1().min_w(0).justify_center()
      .child(div().truncate().text_size(12).text_color(t.foreground).child(where))
      .child(div().truncate().text_size(10.5).text_color(t.dim).child(a.title || a.program?.name || ""));
    const time = div().flex_none().text_size(10.5).text_color(t.dim).child(since);
    const parts = mirror ? [time, body, ...edge.reverse()] : [...edge, body, time];
    return h_flex().id(`att-${a.address}`).h(30).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.act(a, cx))
      .on_mouse_down("right", (_e, cx) => {
        if (a.status === "done") { this.seen[a.address] = "done"; cx.notify(); }
      })
      .children(parts);
  }

  chip(a, t) {
    const where = a.space_name || a.tab_name || a.program?.name || "";
    return h_flex().id(`att-${a.address}`).h(26).flex_none().px(8).gap(6).items_center().rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.act(a, cx))
      .on_mouse_down("right", (_e, cx) => {
        if (a.status === "done") { this.seen[a.address] = "done"; cx.notify(); }
      })
      .child(this.dot(a, t)).child(this.icon(a, t))
      .child(div().text_size(12).text_color(t.foreground).child(where))
      .child(div().text_size(10.5).text_color(t.dim).child(age(Date.now() - this.since[a.address].at)));
  }

  render(cx) {
    const list = this.list();
    this.count = list.length;
    if (!list.length) return div();
    const t = theme();
    const pl = placement();
    const vertical = pl ? pl.vertical : true;
    const mirror = (pl?.edge ?? "right") === "right";
    const label = `Needs you · ${list.length}`;
    if (!vertical) {
      return h_flex().gap(4).items_center().px(4)
        .child(div().px(6).flex_none().text_size(11.5).text_color(t.dim).child(label))
        .children(list.map((a) => this.chip(a, t)));
    }
    return v_flex().w(WIDTH).gap(2).py(4).px(4)
      .child(div().h(20).px(8).flex().items_center().when(mirror, (el) => el.justify_end())
        .text_size(11.5).text_color(t.dim).child(label))
      .children(list.map((a) => this.row(a, t, mirror)));
  }
}
