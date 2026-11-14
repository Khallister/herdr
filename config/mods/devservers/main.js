// Dev: listening TCP ports (lsof) and Docker containers for the current project, or for everything.
// Roles (props.role): single view (default), meant for a right-panel tab. No props needed.
// Header: "This project | All" switch and a refresh button. Port rows: Open, Kill (click twice in 3 s).
// Container rows: Start/Stop/Restart, Logs and Shell (new tab), open published ports.
// nextCommand(): "refresh" (reload now), "toggle" (This project <-> All). Suggested keys: none needed.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, focused, run, exec, theme, home, window, nextCommand } from "herdr";

const POLL = 10000;
const T = 5000;
const tilde = (p) => (p === home() ? "~" : p.startsWith(home() + "/") ? `~/${p.slice(home().length + 1)}` : p);
const base = (p) => p.replace(/\/+$/, "").split("/").pop();
const inside = (p, dir) => p === dir || p.startsWith(dir + "/");
const DOCKER_PROC = /^(com\.docker|vpnkit|docker|Docker|qemu|limactl|colima)/i;
const SYSTEM_PROC = /^(ControlCenter|rapportd|launchd|identityservicesd|sharingd|WiFiAgent|AirPlay|Spotlight|ReportCrash|Google Chrome|Slack|Dropbox|figma_agent|Raycast|Notion|Cursor|ARDAgent|remoted|mDNSResponder|trustd|apsd)/i;
const ICON = (n) => `mods/devservers/${n}.svg`;

function lsofParse(text) {
  const rows = [];
  let cur = null;
  for (const line of text.split("\n")) {
    if (!line) continue;
    const k = line[0], v = line.slice(1);
    if (k === "p") cur = { pid: Number(v), command: "", ports: new Set() };
    else if (!cur) continue;
    else if (k === "c") cur.command = v;
    else if (k === "n") {
      const m = v.match(/:(\d+)$/);
      if (m) cur.ports.add(Number(m[1]));
    }
    if (k === "c" && cur && !rows.includes(cur)) rows.push(cur);
  }
  return rows;
}

export default class Devservers extends View {
  init(_props, cx) {
    this.mode = "project";
    this.key = null;
    this.proj = { name: "", root: null, remote: false };
    this.ports = [];
    this.containers = [];
    this.dockerErr = null;
    this.portErr = null;
    this.compose = false;
    this.busy = {};
    this.confirm = null;
    this.systemOpen = false;
    this.loading = false;
    this.width = 360;
    this.lastRender = Date.now();
    this.rootCache = {};
    cx.timer.every(POLL, (cx) => {
      if (window().active && Date.now() - this.lastRender < 60000) this.refresh(cx);
    });
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "refresh") this.refresh(cx);
        if (c === "toggle") { this.mode = this.mode === "project" ? "all" : "project"; this.refresh(cx); }
        cx.notify();
      }
    });
  }

  // The current project's folder, like the Spaces list: first pane's cwd in the space, else its folder.
  where() {
    const f = focused();
    const s = spaces().find((x) => x.id === f?.space);
    if (!s) return { machine: null, folder: null };
    const tabs = new Set((s.tabs ?? []).map((c) => c.id));
    const folder = panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
    return { machine: s.machine ?? null, folder };
  }

  async resolveRoot(folder) {
    if (this.rootCache[folder]) return this.rootCache[folder];
    let root = folder;
    try {
      const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: folder, timeout: T });
      if (r.code === 0 && r.stdout.trim()) root = r.stdout.trim();
    } catch {}
    this.rootCache[folder] = root;
    return root;
  }

  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    const { machine, folder } = this.where();
    cx.spawn(async (cx) => {
      try {
        if (machine) { this.proj = { name: "", root: null, remote: true }; this.ports = []; this.containers = []; return; }
        const root = folder ? await this.resolveRoot(folder) : null;
        this.proj = { name: root ? base(root) : "", root, remote: false };
        const [ports, docker, compose] = await Promise.all([this.loadPorts(), this.loadDocker(root), this.hasCompose(root)]);
        this.ports = ports;
        this.compose = compose;
        void docker;
      } catch (e) {
        this.portErr = String(e?.message ?? e);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  async hasCompose(root) {
    if (!root) return false;
    try {
      const r = await exec("find", [root, "-maxdepth", "1", "(", "-name", "docker-compose.y*ml", "-o", "-name", "compose.y*ml", ")"], { timeout: T });
      return r.code === 0 && r.stdout.trim().length > 0;
    } catch { return false; }
  }

  async loadPorts() {
    this.portErr = null;
    let r;
    try {
      r = await exec("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"], { timeout: T });
    } catch (e) {
      this.portErr = "lsof unavailable";
      return [];
    }
    if (r.code !== 0 && !r.stdout.trim()) return [];
    const procs = lsofParse(r.stdout);
    const cwd = {};
    if (procs.length) {
      try {
        const c = await exec("lsof", ["-a", "-p", procs.map((p) => p.pid).join(","), "-d", "cwd", "-Fn"], { timeout: T });
        let pid = null;
        for (const line of c.stdout.split("\n")) {
          if (line[0] === "p") pid = Number(line.slice(1));
          else if (line[0] === "n" && pid != null) cwd[pid] = line.slice(1);
        }
      } catch {}
    }
    const out = [];
    for (const p of procs) for (const port of p.ports) out.push({ pid: p.pid, command: p.command, port, cwd: cwd[p.pid] ?? "" });
    return out.sort((a, b) => a.port - b.port);
  }

  async loadDocker(root) {
    let r;
    try {
      r = await exec("docker", ["ps", "-a", "--format", "{{json .}}"], { timeout: T });
    } catch (e) {
      this.dockerErr = "Docker is not installed";
      this.containers = [];
      return;
    }
    if (r.code !== 0) {
      this.dockerErr = /Cannot connect|daemon|connect/i.test(r.stderr) ? "Docker is not running" : r.stderr.trim().split("\n")[0] || "Docker error";
      this.containers = [];
      return;
    }
    this.dockerErr = null;
    const list = [];
    for (const line of r.stdout.split("\n")) {
      if (!line.trim()) continue;
      try { list.push(JSON.parse(line)); } catch {}
    }
    const meta = {};
    if (list.length) {
      try {
        const i = await exec("docker", ["inspect", "--format",
          '{{.Id}}|{{index .Config.Labels "com.docker.compose.project.working_dir"}}|{{index .Config.Labels "com.docker.compose.project"}}',
          ...list.map((c) => c.ID)], { timeout: T });
        for (const line of i.stdout.split("\n")) {
          const [id, dir, proj] = line.split("|");
          if (id) meta[id.slice(0, 12)] = { dir: dir ?? "", proj: proj ?? "" };
        }
      } catch {}
    }
    this.containers = list.map((c) => {
      const m = meta[String(c.ID).slice(0, 12)] ?? { dir: "", proj: "" };
      const ports = [...new Set([...String(c.Ports ?? "").matchAll(/:(\d+)->/g)].map((x) => Number(x[1])))];
      const mine = Boolean(root) && ((m.dir && inside(m.dir, root)) || (m.proj && m.proj.toLowerCase() === base(root).toLowerCase()));
      return { id: c.ID, name: c.Names, image: c.Image, state: String(c.State ?? "").toLowerCase(), status: c.Status ?? "", ports, group: m.proj, mine };
    });
  }

  act(cx, c, verb) {
    this.busy[c.id] = verb;
    cx.notify();
    cx.spawn(async (cx) => {
      try { await exec("docker", [verb, c.id], { timeout: 30000 }); } catch {}
      delete this.busy[c.id];
      this.loading = false;
      this.refresh(cx);
    });
  }

  kill(cx, p) {
    const now = Date.now();
    if (this.confirm?.pid === p.pid && now < this.confirm.until) {
      this.confirm = null;
      cx.spawn(async (cx) => {
        try { await exec("kill", [String(p.pid)], { timeout: T }); } catch {}
        this.loading = false;
        cx.timer.after(600, (cx) => this.refresh(cx));
      });
    } else {
      this.confirm = { pid: p.pid, until: now + 3000 };
      cx.timer.after(3000, (cx) => cx.notify());
    }
    cx.notify();
  }

  btn(t, id, icon, tip, onClick, color) {
    return div().id(id).size(22).flex_none().flex().items_center().justify_center().rounded(5)
      .text_color(color ?? t.dim).hover((s) => s.bg(t.raised).text_color(t.foreground)).cursor_pointer()
      .tooltip(tip).on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
      .child(svg(ICON(icon)).size(13));
  }

  header(t) {
    const tab = (id, label) => h_flex().id(`dev-mode-${id}`).h(22).px(8).items_center().rounded(5).text_size(11.5).cursor_pointer()
      .text_color(this.mode === id ? t.foreground : t.dim)
      .when(this.mode === id, (el) => el.bg(t.selected))
      .when(this.mode !== id, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => { this.mode = id; cx.notify(); })
      .child(label);
    return h_flex().h(31).flex_none().pl(16).pr(6).gap(4).items_center().text_size(11.5).text_color(t.dim)
      .child(div().flex_1().min_w(0).truncate().child(`Dev${this.proj.name ? " · " + this.proj.name : ""}`))
      .child(tab("project", "This project"))
      .child(tab("all", "All"))
      .child(this.btn(t, "dev-refresh", "refresh", "Refresh", (cx) => { this.loading = false; this.refresh(cx); }));
  }

  section(t, title, count, extra, open, onToggle) {
    return h_flex().h(26).flex_none().px(8).mt(4).gap(6).items_center().text_size(11.5).text_color(t.dim)
      .child(div().id(`dev-sec-${title}`).flex_1().min_w(0).truncate().when(Boolean(onToggle), (el) => el.cursor_pointer().on_click((_e, cx) => { onToggle(); cx.notify(); }))
        .child(`${onToggle ? (open ? "▾ " : "▸ ") : ""}${title}${count != null ? "  " + count : ""}`))
      .children(extra ?? []);
  }

  portRow(t, p) {
    const sure = this.confirm?.pid === p.pid && Date.now() < this.confirm.until;
    return h_flex().id(`port-${p.pid}-${p.port}`).h(28).flex_none().px(8).gap(8).items_center().rounded(8)
      .hover((s) => s.bg(t.hover))
      .child(div().w(50).flex_none().text_color(t.accent).child(`:${p.port}`))
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().text_color(t.foreground).text_size(12.5).child(`${p.command}  `))
        .when(Boolean(p.cwd) && this.mode === "all", (el) => el.child(div().truncate().text_size(10).text_color(t.dim).child(tilde(p.cwd)))))
      .child(div().text_size(10.5).text_color(t.dim).child(String(p.pid)))
      .child(this.btn(t, `open-${p.pid}-${p.port}`, "open", "Open in browser", () => exec("open", [`http://localhost:${p.port}`]).catch(() => {})))
      .child(sure
        ? div().id(`kill-${p.pid}-${p.port}`).h(22).px(6).flex_none().flex().items_center().rounded(5).text_size(11).cursor_pointer()
          .bg(t.blocked).text_color(t.background).on_click((_e, cx) => this.kill(cx, p)).child("Sure?")
        : this.btn(t, `kill-${p.pid}-${p.port}`, "x", "Kill process", (cx) => this.kill(cx, p)));
  }

  containerRow(t, c) {
    const busy = this.busy[c.id];
    const running = c.state === "running";
    const bad = c.state === "restarting" || /unhealthy/i.test(c.status);
    const color = bad ? t.blocked : running ? t.working : t.dim;
    return h_flex().id(`ct-${c.id}`).h(28).flex_none().px(8).gap(8).items_center().rounded(8)
      .hover((s) => s.bg(t.hover))
      .child(div().w(8).flex_none().text_size(10).text_color(color).child("●"))
      .child(h_flex().flex_1().min_w(0).gap(6).items_center()
        .child(div().truncate().text_color(running ? t.foreground : t.muted).child(c.name))
        .child(div().truncate().flex_1().min_w(0).text_size(10.5).text_color(t.dim)
          .child(busy ? `${busy}…` : c.image.split("/").pop())))
      .children(c.ports.slice(0, 2).map((port) =>
        div().id(`ctp-${c.id}-${port}`).text_size(11).text_color(t.accent).cursor_pointer().flex_none()
          .tooltip("Open in browser").on_click(() => exec("open", [`http://localhost:${port}`]).catch(() => {}))
          .child(`:${port}`)))
      .child(busy
        ? div().size(22).flex_none().flex().items_center().justify_center().text_color(t.dim).child(svg(ICON("restart")).size(13).spin(900))
        : h_flex().gap(0).flex_none()
          .child(running
            ? this.btn(t, `stop-${c.id}`, "stop", "Stop", (cx) => this.act(cx, c, "stop"))
            : this.btn(t, `start-${c.id}`, "play", "Start", (cx) => this.act(cx, c, "start")))
          .when(running, (el) => el.child(this.btn(t, `rs-${c.id}`, "restart", "Restart", (cx) => this.act(cx, c, "restart"))))
          .child(this.btn(t, `logs-${c.id}`, "logs", "Logs", () => run("tab.new", { name: "logs " + c.name, argv: ["docker", "logs", "-f", "--tail", "200", c.id] })))
          .when(running, (el) => el.child(this.btn(t, `sh-${c.id}`, "shell", "Shell", () => run("tab.new", { name: c.name, argv: ["docker", "exec", "-it", c.id, "sh"] })))));
  }

  note(t, text, color) {
    return div().px(8).py(4).text_size(12).text_color(color ?? t.dim).child(text);
  }

  rail(t) {
    const items = [...this.ports.filter((p) => this.visible(p)).map((p) => ({ k: `p${p.pid}${p.port}`, l: String(p.port).slice(-3), tip: `:${p.port} ${p.command}`, c: t.accent })),
      ...this.shownContainers().map((c) => ({ k: c.id, l: "▪", tip: `${c.name} (${c.state})`, c: c.state === "running" ? t.working : t.dim }))];
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(11).pt(6).gap(2).overflow_y_scrollbar()
      .children(items.map((i) => h_flex().id(`rail-${i.k}`).flex_none().justify_center().tooltip(i.tip)
        .child(div().w(32).h(24).flex().items_center().justify_center().rounded(6).text_color(i.c).hover((s) => s.bg(t.hover)).child(i.l))));
  }

  userPort(p) { return !DOCKER_PROC.test(p.command) && !SYSTEM_PROC.test(p.command); }
  visible(p) {
    if (DOCKER_PROC.test(p.command)) return false;
    if (this.mode === "all") return true;
    return Boolean(this.proj.root) && Boolean(p.cwd) && inside(p.cwd, this.proj.root) && this.userPort(p);
  }
  shownContainers() {
    return this.mode === "all" ? this.containers : this.containers.filter((c) => c.mine);
  }

  render(cx) {
    const t = theme();
    this.lastRender = Date.now();
    const { machine, folder } = this.where();
    const key = JSON.stringify([machine, folder]);
    if (key !== this.key) {
      this.key = key;
      this.loading = false;
      cx.timer.after(0, (cx) => this.refresh(cx));
    }
    const shell = (...kids) => v_flex().id("dev-root").size_full().min_h(0).bg(t.chrome).text_size(13)
      .on_size_change((s, cx) => { if ((s.width < 160) !== (this.width < 160)) { this.width = s.width; cx.notify(); } else this.width = s.width; })
      .children(kids);
    if (this.width < 160) return shell(this.rail(t));
    if (machine) return shell(this.header(t), this.note(t, "Remote space: not supported yet"));

    const ports = this.ports.filter((p) => this.visible(p));
    const sys = this.mode === "all" ? this.ports.filter((p) => !DOCKER_PROC.test(p.command) && SYSTEM_PROC.test(p.command)) : [];
    const mainPorts = this.mode === "all" ? ports.filter((p) => !SYSTEM_PROC.test(p.command)) : ports;
    const cts = this.shownContainers();
    const groups = {};
    for (const c of cts) (groups[c.group || "Standalone"] ??= []).push(c);
    const composeBtn = (label, args) => h_flex().id(`compose-${label}`).h(20).px(6).items_center().rounded(5).text_size(11).cursor_pointer()
      .text_color(t.dim).hover((s) => s.bg(t.raised).text_color(t.foreground))
      .on_click(() => run("tab.new", { name: `compose ${label}`, folder: this.proj.root, argv: ["docker", "compose", ...args] }))
      .child(label);
    const empty = !mainPorts.length && !cts.length && !sys.length && !this.dockerErr;

    return shell(
      this.header(t),
      v_flex().flex_1().min_h(0).px(8).pb(14).overflow_y_scrollbar()
        .when(Boolean(this.portErr), (el) => el.child(this.note(t, this.portErr, t.blocked)))
        .when(empty && !this.loading, (el) => el.child(this.note(t, "No servers running")))
        .when(mainPorts.length > 0, (el) => el.child(this.section(t, "Ports", mainPorts.length)).children(mainPorts.map((p) => this.portRow(t, p))))
        .when(sys.length > 0, (el) => el.child(this.section(t, "System", sys.length, null, this.systemOpen, () => { this.systemOpen = !this.systemOpen; }))
          .when(this.systemOpen, (e) => e.children(sys.map((p) => this.portRow(t, p)))))
        .child(this.section(t, "Containers", this.dockerErr ? null : cts.length,
          this.compose && !this.dockerErr && this.mode === "project" ? [composeBtn("up -d", ["up", "-d"]), composeBtn("down", ["down"])] : []))
        .when(Boolean(this.dockerErr), (el) => el.child(h_flex().px(8).py(4).gap(8).items_center()
          .child(div().flex_1().min_w(0).text_size(12).text_color(t.dim).child(this.dockerErr))
          .when(this.dockerErr !== "Docker is not installed", (e) => e.child(h_flex().id("dev-start-docker").h(22).px(8).items_center().rounded(5).text_size(11.5).cursor_pointer()
            .bg(t.raised).text_color(t.foreground).hover((s) => s.bg(t.hover))
            .on_click(() => exec("open", ["-a", "Docker"]).catch(() => {})).child("Start Docker")))))
        .when(!this.dockerErr && cts.length === 0, (el) => el.child(this.note(t, this.mode === "project" ? "No containers for this project" : "No containers")))
        .children(Object.keys(groups).sort().flatMap((g) => [
          ...(Object.keys(groups).length > 1 || g !== "Standalone" ? [div().px(8).pt(4).pb(2).text_size(10.5).text_color(t.dim).child(g)] : []),
          ...groups[g].map((c) => this.containerRow(t, c))])),
    );
  }
}
