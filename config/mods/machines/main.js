// Machines: this computer and every machine from `hc machine ls`, each a card with load, memory,
// disk, uptime and its Docker containers, read over `exec(..., {on})` every 30 s while the window
// is in front. A machine that needs a login offers it in a Herdr terminal (type the password
// there); a reachable one offers a new space on it and `hc machine update`.
// Commands (nextCommand): "refresh".

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, hc, run, theme, window, notify, nextCommand } from "herdr";

const REFRESH = 30000;
// One portable probe: key=value lines, Linux and macOS.
const PROBE = `
export LC_ALL=C
echo "os=$(uname -sr)"
echo "host=$(hostname -s 2>/dev/null || hostname)"
echo "cpus=$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu)"
echo "uptime=$(uptime)"
if [ -r /proc/meminfo ]; then
  awk '/MemTotal/{t=$2}/MemAvailable/{a=$2}END{print "mem=" (t-a)*1024 " " t*1024}' /proc/meminfo
else
  ps=$(sysctl -n hw.pagesize); total=$(sysctl -n hw.memsize)
  vm_stat | awk -v ps="$ps" -v total="$total" '/Pages active/{a=$3}/Pages wired/{w=$4}/occupied by compressor/{c=$5}END{gsub("\\\\.","",a);gsub("\\\\.","",w);gsub("\\\\.","",c);print "mem=" (a+w+c)*ps " " total}'
fi
df -kP / | awk 'NR==2{print "disk=" $3*1024 " " $2*1024}'
if command -v docker >/dev/null 2>&1; then
  docker ps -a --format 'ctr={{.Names}}\t{{.State}}\t{{.Status}}' 2>/dev/null || echo "docker=down"
fi
`;

export function parseProbe(text) {
  const out = { containers: [] };
  for (const line of text.split("\n")) {
    const i = line.indexOf("=");
    if (i < 0) continue;
    const k = line.slice(0, i), v = line.slice(i + 1).trim();
    if (k === "ctr") { const [name, state, status] = v.split("\t"); out.containers.push({ name, state, status }); }
    else if (k === "mem" || k === "disk") { const [used, total] = v.split(" ").map(Number); out[k] = { used, total }; }
    else out[k] = v;
  }
  const load = /load averages?:\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(out.uptime ?? "");
  out.load = load ? load.slice(1).map(Number) : null;
  const up = /up\s+(.*?),\s+\d+\s+users?/.exec(out.uptime ?? "") ?? /up\s+(.*?),\s+load/.exec(out.uptime ?? "");
  out.up = up ? up[1].replace(/,\s*$/, "").replace(/\s+/g, " ") : null;
  out.cpus = Number(out.cpus) || null;
  return out;
}

const gb = (n) => (n / 1024 ** 3 >= 100 ? `${Math.round(n / 1024 ** 3)}G` : `${(n / 1024 ** 3).toFixed(1)}G`);

export default class Machines extends View {
  init(_props, cx) {
    this.list = []; // { name (null: this computer), state, why, target }
    this.data = {}; // key -> probe result | { error }
    this.busy = {};
    this.open = {};
    this.refresh(cx);
    cx.timer.every(REFRESH, (cx) => { if (window()?.active !== false) this.refresh(cx); });
    cx.spawn(async (cx) => {
      for (;;) { if (String(await nextCommand()) === "refresh") this.refresh(cx); cx.notify(); }
    });
  }

  refresh(cx) {
    cx.spawn(async (cx) => {
      let remote = [];
      try {
        const r = await hc(["machine", "ls", "--json"]);
        remote = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary);
      } catch {}
      this.list = [{ name: null, state: "connected" }, ...remote];
      cx.notify();
      await Promise.all(this.list.map(async (m) => {
        const key = m.name ?? "";
        if (m.name && m.state === "needs_login") { this.data[key] = null; return; }
        try {
          const r = await exec("sh", ["-c", PROBE], { on: m.name, timeout: 10000 });
          this.data[key] = r.code === 0 || r.stdout ? parseProbe(r.stdout) : { error: r.stderr.trim() || `exit ${r.code}` };
        } catch (e) {
          this.data[key] = { error: String(e?.message ?? e) };
        }
        cx.notify();
      }));
    });
  }

  act(key, label, cx, args) {
    this.busy[key] = label;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await hc(args).catch((e) => ({ code: 1, stderr: String(e) }));
      if (r.code !== 0) notify({ title: `${label} failed`, body: (r.stderr || r.stdout).trim().split("\n").pop(), level: "error" });
      delete this.busy[key];
      this.refresh(cx);
    });
  }

  bar(t, label, used, total, detail) {
    const ratio = total ? Math.max(0, Math.min(1, used / total)) : 0;
    const color = ratio > 0.9 ? t.blocked : ratio > 0.75 ? t.done : t.accent;
    return v_flex().gap(3)
      .child(h_flex().text_size(11.5).child(div().flex_1().text_color(t.muted).child(label)).child(div().text_color(t.dim).child(detail)))
      .child(div().h(4).w_full().rounded(2).bg(t.raised).child(div().h_full().rounded(2).bg(color).w(`${Math.round(ratio * 100)}%`)));
  }

  button(t, id, label, onClick) {
    return div().id(id).h(24).px(8).flex().items_center().rounded(6).text_size(11.5).text_color(t.foreground)
      .bg(t.raised).cursor_pointer().hover((s) => s.bg(t.hover)).on_click(onClick).child(label);
  }

  card(m, t) {
    const key = m.name ?? "";
    const d = this.data[key];
    const id = key || "local";
    const login = m.state === "needs_login";
    const stateColor = login ? t.blocked : d?.error ? t.blocked : d ? t.working : t.dim;
    const running = d?.containers?.filter((c) => c.state === "running").length ?? 0;
    return v_flex().id(`machine-${id}`).flex_none().gap(8).p(10).rounded(8).border_1().border_color(t.border).bg(t.background)
      .child(h_flex().gap(8).items_center()
        .child(div().size(7).rounded(4).bg(stateColor))
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(m.name ?? "This computer"))
        .when(Boolean(this.busy[key]), (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).text_color(t.dim).spin(900)))
        .child(div().text_size(11).text_color(t.dim).truncate().child(d?.host && d.host !== m.name ? d.host : m.target ?? "")))
      .when(login, (el) => el
        .child(div().text_size(12).text_color(t.blocked).child("Needs a login (password or code)."))
        .child(h_flex().gap(6)
          .child(this.button(t, `login-${id}`, "Log in in a terminal", () => run("tab.new", { name: `login ${m.name}`, argv: ["hc", "machine", "login", m.name] })))
          .child(this.button(t, `retry-${id}`, "Retry", (_e, cx) => this.refresh(cx)))))
      .when(!login && Boolean(d?.error), (el) => el.child(div().text_size(12).text_color(t.blocked).child(d.error)))
      .when(!login && Boolean(d) && !d.error, (el) => el
        .child(div().text_size(11.5).text_color(t.dim).truncate().child([d.os, d.up ? `up ${d.up}` : null].filter(Boolean).join(" · ")))
        .when(Boolean(d.load), (e) => e.child(this.bar(t, "Load", d.load[0], d.cpus ?? 1, `${d.load.map((x) => x.toFixed(2)).join(" ")}${d.cpus ? ` / ${d.cpus} cpu` : ""}`)))
        .when(Boolean(d.mem), (e) => e.child(this.bar(t, "Memory", d.mem.used, d.mem.total, `${gb(d.mem.used)} / ${gb(d.mem.total)}`)))
        .when(Boolean(d.disk), (e) => e.child(this.bar(t, "Disk /", d.disk.used, d.disk.total, `${gb(d.disk.used)} / ${gb(d.disk.total)}`)))
        .when(d.docker === "down", (e) => e.child(div().text_size(11.5).text_color(t.dim).child("Docker: not running")))
        .when(d.containers.length > 0, (e) => e
          .child(h_flex().id(`ctr-toggle-${id}`).gap(6).items_center().cursor_pointer().text_size(11.5).text_color(t.muted)
            .on_click((_e, cx) => { this.open[key] = !this.open[key]; cx.notify(); })
            .child(this.open[key] ? "▾" : "▸")
            .child(`Containers · ${running} running / ${d.containers.length}`))
          .when(Boolean(this.open[key]), (e2) => e2.children(d.containers.map((c) =>
            h_flex().gap(6).pl(14).items_center().text_size(11.5)
              .child(div().size(6).rounded(3).bg(c.state === "running" ? t.working : c.state === "restarting" ? t.blocked : t.dim))
              .child(div().flex_1().min_w(0).truncate().child(c.name))
              .child(div().text_color(t.dim).truncate().child(c.status))))))
        .child(h_flex().gap(6)
          .when(Boolean(m.name), (e) => e
            .child(this.button(t, `space-${id}`, "New space there", () => run("space.new", { machine: m.name })))
            .child(this.button(t, `update-${id}`, "Update hc", (_e, cx) => this.act(key, "Update hc", cx, ["machine", "update", m.name]))))));
  }

  render() {
    const t = theme();
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13).text_color(t.foreground)
      .child(h_flex().h(31).flex_none().pl(16).pr(6).items_center().text_size(11.5).text_color(t.dim)
        .child(div().flex_1().child("Machines"))
        .child(div().id("machines-refresh").size(26).flex().items_center().justify_center().rounded(6)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => this.refresh(cx)).child("↻")))
      .child(v_flex().flex_1().min_h(0).px(10).pb(14).gap(8).overflow_y_scrollbar()
        .children(this.list.map((m) => this.card(m, t))));
  }
}
