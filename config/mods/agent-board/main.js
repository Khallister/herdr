// Agent board: live urgency, time in status, context usage and rtk savings.
// Props: overlay identifies the window to close; no role variants.
// Commands: oldest jumps to the oldest blocked agent, then oldest done;
// focus restores keyboard navigation. No changes to global agent order.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle } from "gpui-base";
import { agents, spaces, theme, run, hc, exec, props, closeOverlay, nextCommand } from "herdr";

const STATUSES = ["blocked", "done", "working", "idle"];
const ROOT = "mods/agent-board/";
const clean = text => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "");

export function contextUsed(text, app = "") {
  const lines = clean(text).split(/\r?\n/).slice(-12).reverse();
  for (const line of lines) {
    const left = line.match(/(\d{1,3})\s*%\s*context\s+left/i);
    if (left && +left[1] <= 100) return 100 - +left[1];
    // Claude's status line includes its model or a context meter. Avoid
    // treating arbitrary percentages in an agent's prose as context usage.
    if (/claude/i.test(app) && /(?:opus|sonnet|haiku|context|[█▓▒░▰▱])/i.test(line)) {
      const matches = [...line.matchAll(/(\d{1,3})\s*%/g)];
      const used = matches.at(-1);
      if (used && +used[1] <= 100) return +used[1];
    }
  }
  return null;
}

export function elapsed(ms) {
  const minutes = Math.floor(Math.max(0, ms) / 60000);
  return minutes < 1 ? "<1m" : minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${Math.floor(minutes / 1440)}d ${Math.floor(minutes / 60) % 24}h`;
}

const tokens = n => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
const icon = (a, t) => a.program?.icon
  ? (a.program.tint ? svg(a.program.icon).text_color(t.foreground) : image(a.program.icon)).size(16).flex_none()
  : div().size(16).flex_none();

export default class AgentBoard extends View {
  init(_props, cx) {
    this.closed = false;
    this.changed = new Map();
    this.context = new Map();
    this.selected = null;
    this.width = 760;
    this.gain = null;
    this.gainError = null;
    this.handle = cx.focus_handle();
    this.scroll = ScrollHandle.new();
    this.handle.focus();
    this.track();
    this.pollContext(cx);
    this.pollGain(cx);
    this.timers = [
      cx.timer.every(20000, cx => { this.pollContext(cx); cx.notify(); }),
      cx.timer.every(60000, cx => this.pollGain(cx)),
    ];
    cx.spawn(async cx => {
      while (!this.closed) {
        const command = await nextCommand();
        if (this.closed) return;
        if (command === "oldest") this.oldest();
        if (command === "focus") this.handle.focus();
        cx.notify();
      }
    });
  }

  close() {
    this.closed = true;
    for (const timer of this.timers ?? []) timer.cancel();
  }

  track() {
    const now = Date.now();
    const list = agents();
    const tabs = new Map(spaces().flatMap(s => s.tabs).map(t => [t.id, t]));
    const live = new Set(list.map(a => a.address));
    for (const a of list) {
      const previous = this.changed.get(a.address);
      if (!previous) {
        const tab = tabs.get(a.tab);
        // Tab timestamps are an initial estimate, shared by split agents.
        const seed = a.status === "working" ? tab?.working_since ?? tab?.changed_at : tab?.changed_at;
        this.changed.set(a.address, { status: a.status, since: typeof seed === "number" && seed > 0 ? Math.min(seed, now) : now });
      } else if (previous.status !== a.status) {
        this.changed.set(a.address, { status: a.status, since: now });
      }
    }
    for (const address of this.changed.keys()) if (!live.has(address)) {
      this.changed.delete(address);
      this.context.delete(address);
    }
    return list;
  }

  sorted() {
    return this.track().sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))
      || STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status)
      || this.changed.get(a.address).since - this.changed.get(b.address).since
      || a.address.localeCompare(b.address));
  }

  focus(a) {
    if (!a) return;
    run("agent.focus", { terminal: a.address });
    if (props().overlay) closeOverlay(props().overlay);
  }

  oldest() {
    const list = this.track();
    const waiting = list.filter(a => a.status === "blocked");
    const candidates = waiting.length ? waiting : list.filter(a => a.status === "done");
    candidates.sort((a, b) => this.changed.get(a.address).since - this.changed.get(b.address).since);
    this.focus(candidates[0]);
  }

  pollContext(cx) {
    if (this.closed || this.contextBusy) return;
    this.contextBusy = true;
    const list = agents();
    cx.spawn(async cx => {
      try {
        // Sequential reads bound load on the core for large agent lists.
        for (const a of list) {
          if (this.closed) return;
          try {
            const r = await hc(["read", a.address, "--lines", "8"]);
            if (this.closed) return;
            this.context.set(a.address, r.code === 0
              ? { value: contextUsed(r.stdout, `${a.app ?? ""} ${a.program?.key ?? ""}`), error: null }
              : { value: null, error: (r.stderr || `hc exited ${r.code}`).trim() });
          } catch (error) {
            if (this.closed) return;
            this.context.set(a.address, { value: null, error: String(error) });
          }
        }
      } finally { this.contextBusy = false; }
      if (!this.closed) cx.notify();
    });
  }

  pollGain(cx) {
    if (this.closed || this.gainBusy || this.noRtk) return;
    this.gainBusy = true;
    cx.spawn(async cx => {
      try {
        const r = await exec("rtk", ["gain", "--format", "json"], { timeout: 5000 });
        if (this.closed) return;
        if (r.code !== 0) throw new Error((r.stderr || `rtk exited ${r.code}`).trim());
        const s = JSON.parse(r.stdout).summary;
        if (!Number.isFinite(s?.total_saved) || !Number.isFinite(s?.avg_savings_pct)) throw new Error("Unrecognized rtk summary");
        this.gain = `rtk: ${tokens(s.total_saved)} tokens saved (${s.avg_savings_pct.toFixed(0)}%)`;
        this.gainError = null;
      } catch (error) {
        if (this.closed) return;
        const message = String(error);
        this.noRtk = /not found|no such file|not installed|cannot find/i.test(message) && !/database/i.test(message);
        this.gain = null;
        this.gainError = this.noRtk ? null : message;
      } finally { this.gainBusy = false; }
      if (!this.closed) cx.notify();
    });
  }

  button(id, label, asset, action, t, active = false) {
    return div().id(id).size(22).flex_none().flex().items_center().justify_center().rounded(5)
      .text_color(active ? t.accent : t.muted).opacity(active ? 1 : 0.6).cursor_pointer()
      .hover(s => s.bg(t.hover).opacity(1)).tooltip(label)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); action(); })
      .child(svg(ROOT + asset + ".svg").size(13));
  }

  row(a, t, rail, compact) {
    const age = Date.now() - this.changed.get(a.address).since;
    const overdue = a.status === "blocked" && age > 300000;
    const context = this.context.get(a.address);
    const used = context?.value;
    const color = used > 70 ? t.blocked : used > 50 ? t.done : t.accent;
    const dot = a.status === "working"
      ? svg("mods/workspace-chrome/spinner.svg").size(12).text_color(t.working).spin(900)
      : div().size(7).rounded(4).bg(t[a.status]).when(overdue, el => el.loop("opacity", { from: 0.35, to: 1, period: 1200 }));
    return h_flex().id(`agent-${a.address}`).h(30).flex_none().px(rail ? 4 : 8).gap(rail ? 4 : 8).rounded(7).items_center()
      .when(overdue, el => el.bg(t.blocked + "26"))
      .when(a.address === this.selected, el => el.border_1().border_color(t.accent))
      .hover(s => s.bg(t.hover)).cursor_pointer()
      .tooltip(`${a.space_name} / ${a.tab_name} · ${a.title}\n${a.status} · ${elapsed(age)} · ${a.address}`)
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.handle.focus(); })
      .on_click(() => this.focus(a))
      .child(icon(a, t)).child(div().w(12).flex_none().flex().items_center().justify_center().child(dot))
      .when(!rail, el => el.child(h_flex().flex_1().min_w(0).gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(`${a.space_name} / ${a.tab_name}`))
        .when(!compact, el => el.child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(a.title || a.program?.name || a.address)))))
      .when(!rail, el => el.child(div().w(44).flex_none().text_right().text_size(11.5).text_color(overdue ? t.blocked : t.muted).child(elapsed(age))))
      .when(!rail, el => el.child(v_flex().w(compact ? 34 : 64).flex_none().gap(3)
        .tooltip(context?.error ? `Context unavailable: ${context.error}` : "Estimated context used")
        .child(div().text_size(11).text_right().text_color(t.muted).child(used == null ? "–" : `${used}%`))
        .child(div().w_full().h(3).rounded(2).bg(t.border)
          .child(div().w((compact ? 34 : 64) * (used ?? 0) / 100).h(3).rounded(2).bg(color)))))
      .when(rail, el => el.child(div().flex_1()))
      .child(this.button(`peek-${a.address}`, "Peek", "eye", () => run("terminal.peek", { terminal: a.address }), t))
      .child(this.button(`pin-${a.address}`, a.pinned ? "Unpin" : "Pin", a.pinned ? "pin-off" : "pin", () => run("terminal.pin", { terminal: a.address, pinned: !a.pinned }), t, a.pinned));
  }

  render() {
    const t = theme();
    const list = this.sorted();
    const rail = this.width < 160;
    const compact = this.width < 540;
    if (!list.some(a => a.address === this.selected)) this.selected = list[0]?.address ?? null;
    const waiting = list.some(a => a.status === "blocked" || a.status === "done");
    return v_flex().id("agent-board").size_full().min_h(0).bg(t.chrome).text_size(13).text_color(t.foreground).p(rail ? 4 : 12).gap(8)
      .track_focus(this.handle)
      .on_size_change((size, cx) => { if (size.width !== this.width) { this.width = size.width; cx.notify(); } })
      .on_key_down((e, cx) => {
        if (e.key === "escape") { if (props().overlay) closeOverlay(props().overlay); return; }
        const rows = this.sorted();
        if (e.key === "enter") this.focus(rows.find(a => a.address === this.selected));
        else if ((e.key === "up" || e.key === "down") && rows.length) {
          const i = Math.max(0, rows.findIndex(a => a.address === this.selected));
          const next = (i + (e.key === "down" ? 1 : rows.length - 1)) % rows.length;
          this.selected = rows[next].address;
          this.scroll.scroll_to_item(next);
          cx.stop_propagation(); cx.notify();
        }
      })
      .child(h_flex().h(26).flex_none().gap(8).items_center()
        .child(div().flex_1().truncate().font_semibold().text_size(11.5).child(rail ? "Agents" : "Agent board"))
        .when(!rail, el => el.child(div().id("oldest").px(8).py(4).rounded(6).text_size(11.5)
          .text_color(waiting ? t.accent : t.dim).cursor_pointer().hover(s => s.bg(t.hover))
          .tooltip("Jump to oldest waiting")
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click(() => this.oldest()).child(compact ? "Oldest waiting" : "Jump to oldest waiting")))
        .child(this.button("close-board", "Close", "x", () => { if (props().overlay) closeOverlay(props().overlay); }, t)))
      .when(!rail, el => el.child(h_flex().gap(compact ? 8 : 16).flex_none().children(STATUSES.map(status =>
        h_flex().gap(4).items_center().child(div().size(6).rounded(3).bg(t[status]))
          .child(div().text_size(11.5).text_color(t.muted).child(`${status} ${list.filter(a => a.status === status).length}`))))))
      .when(!rail && !!this.gain, el => el.child(div().text_size(11.5).text_color(t.dim).child(this.gain)))
      .when(!rail && !!this.gainError, el => el.child(div().text_size(11.5).text_color(t.muted).tooltip(this.gainError).child("rtk: savings unavailable")))
      .when(!rail, el => el.child(h_flex().px(8).gap(8).text_size(11).text_color(t.dim)
        .child(div().flex_1().child(compact ? "Agent" : "Agent / terminal"))
        .child(div().w(44).text_right().child("In status"))
        .child(div().w(compact ? 34 : 64).text_right().child("Used"))
        .child(div().w(52))))
      .child(v_flex().id("board-list").flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.scroll).gap(2)
        .children(list.map(a => this.row(a, t, rail, compact)))
        .when(!list.length, el => el.child(div().p(8).text_color(t.dim).child(rail ? "–" : "No agents reporting status."))))
      .when(!rail, el => el.child(div().text_size(11).text_color(t.dim).child("↑ ↓ select · Enter focus · Esc close")));
  }
}
