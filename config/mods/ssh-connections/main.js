// SSH Connections: the hosts in ~/.ssh/config (and what it includes), with add / edit / remove,
// a non-interactive connection test, host key review, and the Herdr machine for each host.
//
// Opened as a dialog: `mod.open ssh-connections` (cmd-shift-h, or the Machines panel's "SSH").
// Everything touching ~/.ssh runs in bin/sshcm.mjs (Node, argv only, no shell): it previews every
// change as a diff, writes atomically with a backup, validates with OpenSSH and then checks the
// effective result with `ssh -G`. Private key files are referenced by path, never read.
// Herdr machines are separate: `hc machine add|ls|login|rm`, as the Machines panel uses them.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, hc, home, appHome, run, theme, props, closeOverlay, notify, pickFolder, settings } from "herdr";
import { findMachine, machineState, parseAddResult, addArgs } from "./machine.js";

const I = (name) => `mods/workspace-chrome/${name}.svg`;
const ORIGIN = { managed: "Herdr-managed", user: "~/.ssh/config", included: "Included file" };
const FIELDS = [
  ["alias", "Connection name", "production-vps", "Used as the ssh Host alias and the Herdr machine name"],
  ["hostname", "Hostname / IP", "192.0.2.10", null],
  ["user", "Username", "deploy", null],
  ["port", "Port", "22", "Optional, defaults to 22"],
  ["identityFile", "Private key path", "~/.ssh/id_ed25519", "Only the path is stored; the key never leaves this machine"],
];
const short = (p) => (p && p.startsWith(home() + "/") ? `~/${p.slice(home().length + 1)}` : p);

export default class SshConnections extends View {
  init(_props, cx) {
    this.view = "list"; // list | form | preview | done
    this.data = null; // helper `list`
    this.error = null;
    this.machines = [];
    this.openRow = null;
    this.tests = {}; // alias -> { busy } | helper test result
    this.keys = {}; // alias -> hostkey result
    this.mach = {}; // alias -> { busy, msg, interactive, confirmForget }
    this.node = null;
    this.inputs = {};
    for (const [k, , ph] of FIELDS) {
      this.inputs[k] = InputState.new({ placeholder: ph });
      this.inputs[k].on("change", (_e, cx) => { this.formErrors[k] = null; this.formTest = null; cx.notify(); });
    }
    this.formErrors = {};
    this.formTest = null;
    this.keyChoices = [];
    this.handle = cx.focus_handle();
    this.reload(cx);
  }

  // ------------------------------------------------------------ helper process

  async findNode() {
    if (this.node) return this.node;
    for (const c of ["node", `${home()}/.local/share/vite-plus/bin/node`, "/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]) {
      const r = await exec(c, ["--version"], { timeout: 5000 }).catch(() => null);
      if (r?.code === 0 && /^v(\d+)/.test(r.stdout) && Number(/^v(\d+)/.exec(r.stdout)[1]) >= 18) return (this.node = c);
    }
    throw new Error("SSH Connections needs Node.js 18 or newer (node wasn't found on PATH)");
  }

  async helper(cmd, arg = {}) {
    const node = await this.findNode();
    const r = await exec(node, [`${appHome()}/mods/ssh-connections/bin/sshcm.mjs`, cmd, JSON.stringify(arg)], { timeout: 60000 });
    try {
      return JSON.parse(r.stdout.trim().split("\n").pop());
    } catch {
      return { ok: false, error: (r.stderr || r.stdout || `helper exited ${r.code}`).trim().split("\n").slice(-3).join(" ") };
    }
  }

  reload(cx) {
    cx.spawn(async (cx) => {
      try {
        const [d] = await Promise.all([this.helper("list"), this.loadMachines()]);
        this.data = d.ok ? d : null;
        this.error = d.ok ? null : d.error;
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      cx.notify();
    });
  }

  async loadMachines() {
    const r = await hc(["machine", "ls", "--json"]).catch(() => null);
    try { this.machines = JSON.parse(r?.stdout ?? "{}").machines ?? []; } catch { this.machines = []; }
  }

  // ------------------------------------------------------------ actions

  startForm(host, cx) {
    this.form = host ? { mode: "edit", original: host.alias } : { mode: "add", original: null };
    const d = host?.declared ?? {}, e = host?.effective ?? {};
    const v = host
      ? { alias: host.alias, hostname: d.hostname ?? e.hostname ?? "", user: d.user ?? e.user ?? "", port: d.port ?? String(e.port ?? ""), identityFile: d.identityfile ?? short(e.identityFile) ?? "" }
      : { alias: "", hostname: "", user: "", port: "", identityFile: "" };
    for (const [k] of FIELDS) this.inputs[k].set_value(v[k] ?? "");
    this.formErrors = {};
    this.formTest = null;
    this.allowDuplicate = false;
    this.view = "form";
    this.inputs.alias.focus();
    cx.spawn(async (cx) => {
      const r = await this.helper("keys", { dir: "~/.ssh" }).catch(() => null);
      this.keyChoices = r?.ok ? r.keys : [];
      cx.notify();
    });
    cx.notify();
  }

  fields() {
    const out = {};
    for (const [k] of FIELDS) out[k] = this.inputs[k].value();
    return out;
  }

  op(extra = {}) {
    return this.form.mode === "edit"
      ? { action: "edit", originalAlias: this.form.original, fields: this.fields(), allowDuplicate: this.allowDuplicate, ...extra }
      : { action: "add", fields: this.fields(), allowDuplicate: this.allowDuplicate, ...extra };
  }

  preview(op, cx) {
    this.busyPlan = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const p = await this.helper("plan", op);
      this.busyPlan = false;
      if (!p.ok) { this.formErrors._ = p.error; cx.notify(); return; }
      this.formErrors = { ...p.errors };
      if (Object.keys(p.errors ?? {}).length) { cx.notify(); return; }
      this.plan = { ...p, op };
      this.view = "preview";
      cx.notify();
    });
  }

  confirm(cx) {
    const { op, snapshot } = this.plan;
    this.busyApply = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await this.helper("apply", { ...op, snapshot });
      this.busyApply = false;
      this.result = r;
      this.view = r.ok ? "done" : "preview";
      if (!r.ok) this.plan = { ...this.plan, applyError: r.error };
      const d = await this.helper("list");
      if (d.ok) this.data = d;
      await this.loadMachines();
      cx.notify();
    });
  }

  test(key, arg, cx) {
    const set = (v) => (key === "_form" ? (this.formTest = v) : (this.tests[key] = v));
    set({ busy: true });
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await this.helper("test", arg);
      set(r.ok ? r.result : { kind: "error", message: r.error ?? "test failed" });
      if (r.errors) this.formErrors = { ...r.errors };
      cx.notify();
    });
  }

  reviewHostKey(alias, cx) {
    this.keys[alias] = { busy: true };
    cx.notify();
    cx.spawn(async (cx) => {
      this.keys[alias] = await this.helper("hostkey", { alias });
      cx.notify();
    });
  }

  // OpenSSH's own prompt shows the fingerprint and waits for "yes": the person decides.
  trustInTerminal(alias) {
    run("tab.new", { name: `host key ${alias}`, argv: ["ssh", "-o", "StrictHostKeyChecking=ask", "-o", "BatchMode=no", "-o", "UpdateHostKeys=no", "-o", "ControlPath=none", "--", alias, "true"] });
    this.close();
  }

  register(alias, cx) {
    this.mach[alias] = { busy: "Registering" };
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await hc(addArgs(alias)).catch((e) => ({ code: 1, stdout: "", stderr: String(e) }));
      const res = parseAddResult(r);
      await this.loadMachines();
      this.mach[alias] = res.ok ? { msg: "Registered as a Herdr machine." } : res.interactive ? { msg: res.message, interactive: true } : { msg: res.error, failed: true };
      cx.notify();
    });
  }

  check(name, alias, cx) {
    this.mach[alias] = { busy: "Connecting" };
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await exec("true", [], { on: name, timeout: 15000 }).catch((e) => ({ code: -1, stderr: String(e?.message ?? e) }));
      await this.loadMachines();
      this.mach[alias] = r.code === 0 ? { msg: `Herdr reached ${name}: remote commands and terminals work.` } : { msg: `Herdr couldn't reach ${name}: ${(r.stderr || `exit ${r.code}`).trim()}`, failed: true };
      cx.notify();
    });
  }

  forget(name, alias, cx) {
    this.mach[alias] = { busy: "Forgetting" };
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await hc(["machine", "rm", name]).catch((e) => ({ code: 1, stderr: String(e) }));
      await this.loadMachines();
      this.mach[alias] = r.code === 0 ? { msg: `Herdr forgot ${name}. Its terminals keep running there; the ssh entry is unchanged.` } : { msg: (r.stderr || r.stdout).trim(), failed: true };
      cx.notify();
    });
  }

  close() {
    closeOverlay(props().overlay);
  }

  // ------------------------------------------------------------ pieces

  btn(t, id, label, onClick, o = {}) {
    return div().id(id).h(26).px(10).flex().flex_none().items_center().rounded(7).text_size(12).font_medium()
      .when(Boolean(o.primary), (el) => el.bg(t.solid).text_color(t.solid_foreground))
      .when(!o.primary, (el) => el.bg(t.raised).border_1().border_color(t.input).text_color(o.danger ? t.blocked : t.foreground))
      .when(Boolean(o.disabled), (el) => el.opacity(0.4))
      .when(!o.disabled, (el) => el.cursor_pointer().hover((s) => (o.primary ? s.opacity(0.88) : s.bg(t.hover))).on_click((e, cx) => { cx.stop_propagation(); onClick(e, cx); }))
      .child(label);
  }

  badge(t, text, color) {
    return div().flex_none().px(6).py(1).rounded(5).text_size(10.5).text_color(color).bg(color + "1c").child(text);
  }

  note(t, text, color = t.muted) {
    return div().text_size(12).line_height("17px").text_color(color).child(text);
  }

  spinner(t) {
    return svg(I("spinner")).size(12).text_color(t.working).spin(900);
  }

  testLine(t, res) {
    if (!res) return null;
    if (res.busy) return h_flex().gap(6).items_center().child(this.spinner(t)).child(this.note(t, "Testing ssh (no password prompts, 8 s timeout)…"));
    const ok = res.kind === "ok";
    return v_flex().gap(3)
      .child(h_flex().gap(6).items_center()
        .child(div().size(7).rounded(4).bg(ok ? t.ansi2 : t.blocked))
        .child(this.note(t, `${ok ? "SSH OK" : "SSH failed"}: ${res.message}`, ok ? t.foreground : t.blocked)))
      .when(Boolean(res.hint), (el) => el.child(this.note(t, res.hint)))
      .when(!ok && Boolean(res.detail), (el) => el.child(div().text_size(11).text_color(t.dim).font_family(this.mono()).child(res.detail.split("\n").slice(-3).join("\n"))))
      .when(ok, (el) => el.child(this.note(t, "This checks ssh only; registering it as a Herdr machine is a separate step.", t.dim)));
  }

  mono() {
    return settings().font_family || "JetBrains Mono";
  }

  // ------------------------------------------------------------ list view

  hostRow(t, h) {
    const id = h.alias;
    const e = h.effective ?? {};
    const open = this.openRow === id;
    const found = findMachine(this.machines, h);
    const ms = machineState(found?.machine);
    const test = this.tests[id];
    const dot = test?.kind === "ok" ? t.ansi2 : test && !test.busy ? t.blocked : t.dim;
    const addr = e.error ? e.error : `${e.user ?? "?"}@${e.hostname ?? "?"}${e.port && e.port !== 22 ? `:${e.port}` : ""}`;
    return v_flex().flex_none().rounded(8).when(open, (el) => el.bg(t.background).border_1().border_color(t.border))
      .child(h_flex().id(`row-${id}`).h(40).px(10).gap(10).items_center().rounded(8).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.openRow = open ? null : id; cx.notify(); })
        .child(div().size(7).rounded(4).bg(dot))
        .child(div().flex_none().text_size(13).font_semibold().text_color(t.foreground).child(h.alias))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(addr))
        .child(this.badge(t, h.includedFrom && h.origin === "included" ? "Included" : ORIGIN[h.origin], h.origin === "managed" ? t.accent : t.muted))
        .when(Boolean(found), (el) => el.child(this.badge(t, ms.kind === "login" ? "Machine: login" : "Machine", ms.kind === "login" ? t.blocked : t.ansi2)))
        .when(!h.editable, (el) => el.child(this.badge(t, "Read-only", t.dim))))
      .when(open, (el) => el.child(this.hostDetail(t, h, found, ms)));
  }

  hostDetail(t, h, found, ms) {
    const id = h.alias, e = h.effective ?? {};
    const kv = (k, v) => h_flex().gap(8).text_size(12).child(div().w(92).flex_none().text_color(t.dim).child(k)).child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(v ?? "—"));
    const mach = this.mach[id] ?? {};
    const keyRes = this.keys[id];
    const test = this.tests[id];
    const m = found?.machine;
    return v_flex().px(14).pb(12).pt(2).gap(8)
      .child(v_flex().gap(3)
        .child(kv("Hostname", e.hostname))
        .child(kv("User", e.user))
        .child(kv("Port", e.port != null ? String(e.port) : null))
        .child(kv("Identity", e.identityFile))
        .when(Boolean(e.proxyJump), (el) => el.child(kv("ProxyJump", e.proxyJump)))
        .child(kv("Source", `${short(h.path)}:${h.line}${h.includedFrom ? ` (included from ${short(h.includedFrom.path)}:${h.includedFrom.line})` : ""}`)))
      .child(this.note(t, "Values are what ssh uses (ssh -G), including inherited defaults.", t.dim))
      .when(!h.editable, (el) => el.child(this.note(t, `Read-only here: ${h.readOnlyReason}. Edit the file by hand if needed.`)))
      .child(h_flex().gap(6).flex_wrap()
        .child(this.btn(t, `test-${id}`, "Test", (_e, cx) => this.test(id, { alias: id }, cx), { disabled: test?.busy }))
        .when(h.editable, (el) => el
          .child(this.btn(t, `edit-${id}`, "Edit", (_e, cx) => this.startForm(h, cx)))
          .child(this.btn(t, `rm-${id}`, "Remove", (_e, cx) => { this.form = { mode: "remove" }; this.preview({ action: "remove", alias: id }, cx); }, { danger: true })))
        .child(this.btn(t, `term-${id}`, "SSH in a terminal", () => { run("tab.new", { name: id, argv: ["ssh", "--", id] }); this.close(); })))
      .when(Boolean(test), (el) => el.child(this.testLine(t, test)))
      .when(test?.kind === "host_key_unknown" || Boolean(keyRes), (el) => el.child(this.hostKeyBox(t, id, keyRes)))
      .child(div().h(1).bg(t.border))
      .child(h_flex().gap(8).items_center()
        .child(div().size(7).rounded(4).bg(ms.kind === "ok" ? t.ansi2 : ms.kind === "none" ? t.dim : t.blocked))
        .child(this.note(t, m ? `${ms.label}${found.match !== "name" ? ` (registered as "${m.name}")` : ""}` : "Not registered as a Herdr machine", t.foreground))
        .when(Boolean(mach.busy), (el) => el.child(this.spinner(t)).child(this.note(t, mach.busy))))
      .child(h_flex().gap(6).flex_wrap()
        .when(!m, (el) => el.child(this.btn(t, `reg-${id}`, "Register as Herdr machine", (_e, cx) => this.register(id, cx), { primary: true, disabled: Boolean(mach.busy) })))
        .when(Boolean(m) && ms.kind === "login", (el) => el.child(this.btn(t, `login-${id}`, "Log in in a terminal", () => { run("tab.new", { name: `login ${m.name}`, argv: ["hc", "machine", "login", m.name] }); this.close(); }, { primary: true })))
        .when(Boolean(m) && ms.kind !== "login", (el) => el
          .child(this.btn(t, `conn-${id}`, "Connect", (_e, cx) => this.check(m.name, id, cx), { disabled: Boolean(mach.busy) }))
          .child(this.btn(t, `space-${id}`, "New space there", () => { run("space.new", { machine: m.name }); this.close(); })))
        .when(Boolean(m), (el) => el.child(mach.confirmForget
          ? this.btn(t, `forget2-${id}`, `Really forget ${m.name}?`, (_e, cx) => this.forget(m.name, id, cx), { danger: true })
          : this.btn(t, `forget-${id}`, "Forget machine", (_e, cx) => { this.mach[id] = { confirmForget: true }; cx.notify(); }, { danger: true }))))
      .when(Boolean(mach.msg), (el) => el.child(this.note(t, mach.msg, mach.failed || mach.interactive ? t.blocked : t.muted)))
      .when(Boolean(mach.interactive), (el) => el.child(h_flex().gap(6)
        .child(this.btn(t, `reg-term-${id}`, "Finish in a terminal", () => { run("tab.new", { name: `add ${id}`, argv: ["hc", "machine", "add", id, "--name", id] }); this.close(); }, { primary: true }))
        .child(this.note(t, "It needs an answer (a password, a host key, or installing herdr-core there).", t.dim))));
  }

  hostKeyBox(t, alias, res) {
    return v_flex().p(10).gap(6).rounded(8).bg(t.blocked + "10").border_1().border_color(t.blocked + "38")
      .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child("Host key not trusted yet"))
      .child(this.note(t, "Herdr never accepts host keys by itself. Compare the fingerprint with one from a trusted source (your provider's console, or `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` run on the server), then accept it in ssh's own prompt."))
      .when(!res, (el) => el.child(h_flex().child(this.btn(t, `hk-${alias}`, "Show the server's fingerprints", (_e, cx) => this.reviewHostKey(alias, cx)))))
      .when(Boolean(res?.busy), (el) => el.child(h_flex().gap(6).child(this.spinner(t)).child(this.note(t, "Scanning…"))))
      .when(Boolean(res) && !res.busy && !res.ok, (el) => el.child(this.note(t, res.error ?? "scan failed", t.blocked)))
      .when(Boolean(res?.ok), (el) => el
        .child(this.note(t, `${res.hostname}:${res.port} presents (unauthenticated scan):`, t.dim))
        .children(res.keys.map((k) => div().text_size(11.5).font_family(this.mono()).text_color(t.foreground).child(`${k.type ?? ""} ${k.fingerprint}`)))
        .when(res.known, (e) => e.child(this.note(t, "known_hosts already has a key for this host; if ssh still fails, the key may have changed.", t.blocked))))
      .child(h_flex().gap(6).items_center()
        .child(this.btn(t, `hk-trust-${alias}`, "Verify and accept in a terminal", () => this.trustInTerminal(alias)))
        .child(this.note(t, "ssh shows the fingerprint; type yes only if it matches.", t.dim)));
  }

  listView(t) {
    const d = this.data;
    const inc = d?.managedIncluded;
    return v_flex().gap(10)
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().text_size(11.5).font_medium().text_color(t.dim).child(d ? `${d.hosts.length} host${d.hosts.length === 1 ? "" : "s"} in your ssh config` : "Reading ~/.ssh/config…"))
        .child(this.btn(t, "refresh", "↻", (_e, cx) => this.reload(cx)))
        .child(this.btn(t, "add", "Add connection", (_e, cx) => this.startForm(null, cx), { primary: true })))
      .when(Boolean(this.error), (el) => el.child(this.note(t, this.error, t.blocked)))
      .when(Boolean(d) && !d.mainExists, (el) => el.child(this.note(t, "~/.ssh/config doesn't exist yet; adding a connection creates it (mode 600).", t.dim)))
      .when(Boolean(inc) && (!inc?.first || inc?.conditional), (el) => el.child(this.note(t, `The Include of ~/.ssh/herdr/hosts.conf (line ${inc.line}) isn't first in ~/.ssh/config${inc.conditional ? `, and sits inside "${inc.block}"` : ""}: earlier settings can override Herdr's entries.`, t.blocked)))
      .children((d?.problems ?? []).map((p) => this.note(t, `${short(p.path)}${p.line ? `:${p.line}` : ""}: ${p.message}`, t.blocked)))
      .child(v_flex().gap(2).children((d?.hosts ?? []).map((h) => this.hostRow(t, h))))
      .when((d?.rules ?? []).length > 0, (el) => el
        .child(h_flex().id("rules-toggle").pt(6).gap(6).cursor_pointer().text_size(11.5).text_color(t.dim)
          .on_click((_e, cx) => { this.rulesOpen = !this.rulesOpen; cx.notify(); })
          .child(this.rulesOpen ? "▾" : "▸").child(`Patterns and Match rules (read-only) · ${d.rules.length}`))
        .when(Boolean(this.rulesOpen), (e2) => e2.children(d.rules.map((r) =>
          v_flex().pl(16).gap(1)
            .child(div().text_size(12).font_family(this.mono()).text_color(t.foreground).child(r.text))
            .child(this.note(t, `${short(r.path)}:${r.line}${r.keys.length ? ` · sets ${r.keys.join(", ")}` : ""}`, t.dim))))));
  }

  // ------------------------------------------------------------ form

  formView(t) {
    const edit = this.form.mode === "edit";
    const field = ([k, label, , hint]) => v_flex().gap(4)
      .child(div().text_size(11.5).font_medium().text_color(t.muted).child(label))
      .child(Input.new(this.inputs[k]).w_full().h(32).px(10).items_center().rounded(7).border_1()
        .border_color(this.formErrors[k] ? t.blocked : t.input).bg(t.background).text_size(13).text_color(t.foreground))
      .when(Boolean(this.formErrors[k]), (el) => el.child(this.note(t, this.formErrors[k], t.blocked)))
      .when(!this.formErrors[k] && Boolean(hint), (el) => el.child(this.note(t, hint, t.dim)));
    return v_flex().gap(12)
      .child(div().text_size(13.5).font_semibold().child(edit ? `Edit ${this.form.original}` : "Add connection"))
      .children(FIELDS.slice(0, 3).map(field))
      .child(h_flex().gap(10).items_start().child(div().w(110).child(field(FIELDS[3]))).child(div().flex_1().child(field(FIELDS[4]))))
      .child(h_flex().gap(6).flex_wrap().items_center()
        .children(this.keyChoices.slice(0, 8).map((k) => div().id(`key-${k.written}`).px(8).py(3).rounded(6).bg(t.raised).cursor_pointer()
          .hover((s) => s.bg(t.hover)).text_size(11.5).text_color(t.foreground)
          .on_click((_e, cx) => { this.inputs.identityFile.set_value(k.written); this.formErrors.identityFile = null; cx.notify(); })
          .child(k.written)))
        .child(this.btn(t, "browse", "Browse folder…", (_e, cx) => cx.spawn(async (cx) => {
          const dir = await pickFolder({ prompt: "List keys" });
          if (!dir) return;
          const r = await this.helper("keys", { dir });
          this.keyChoices = r.ok ? r.keys : [];
          if (!r.ok) this.formErrors.identityFile = r.error;
          else if (!r.keys.length) this.formErrors.identityFile = `No private keys found in ${dir}`;
          cx.notify();
        }))))
      .child(this.note(t, "Browse lists key files in a folder (the system picker here only picks folders). Herdr checks the file exists and is readable, without opening it.", t.dim))
      .when(Boolean(this.formErrors._), (el) => el.child(this.note(t, this.formErrors._, t.blocked)))
      .when(Boolean(this.formTest), (el) => el.child(this.testLine(t, this.formTest)))
      .when(this.formTest?.kind === "host_key_unknown", (el) => el.child(this.note(t, "Save first, then use Review host key on the saved entry to accept it safely.", t.dim)))
      .child(h_flex().gap(8).pt(4)
        .child(this.btn(t, "cancel", "Cancel", (_e, cx) => { this.view = "list"; cx.notify(); }))
        .child(div().flex_1())
        .child(this.btn(t, "form-test", "Test connection", (_e, cx) => this.test("_form", { fields: this.fields() }, cx), { disabled: this.formTest?.busy }))
        .child(this.btn(t, "review", this.busyPlan ? "Checking…" : "Review changes", (_e, cx) => this.preview(this.op(), cx), { primary: true, disabled: this.busyPlan })));
  }

  // ------------------------------------------------------------ preview / done

  diff(t, c) {
    const color = { "+": t.ansi2, "-": t.blocked, " ": t.muted, "…": t.dim, note: t.dim };
    return v_flex().gap(4)
      .child(h_flex().gap(8).items_center().child(div().text_size(12).font_semibold().child(c.label)).when(c.created, (el) => el.child(this.badge(t, "new file", t.accent))))
      .child(v_flex().p(8).rounded(7).bg(t.background).border_1().border_color(t.border).font_family(this.mono()).text_size(11.5)
        .children(c.diff.map((l) => div().px(4).text_color(color[l.op] ?? t.muted).when(l.op === "+" || l.op === "-", (el) => el.bg(color[l.op] + "16"))
          .child(l.op === "…" ? "  …" : `${l.op === "note" ? "" : l.op} ${l.text}`))));
  }

  previewView(t) {
    const p = this.plan;
    const dup = p.conflicts.find((c) => c.kind === "duplicate");
    const exists = p.conflicts.find((c) => c.kind === "alias_exists");
    const title = p.action === "remove" ? `Remove ${p.op.alias}` : p.action === "edit" ? `Save changes to ${p.op.originalAlias}` : `Add ${p.fields?.alias}`;
    return v_flex().gap(12)
      .child(div().text_size(13.5).font_semibold().child(title))
      .when(Boolean(p.blocked), (el) => el.child(this.note(t, p.blocked, t.blocked)))
      .when(Boolean(p.applyError), (el) => el.child(this.note(t, `Not saved: ${p.applyError}`, t.blocked)))
      .when(Boolean(exists?.editable), (el) => el.child(h_flex().child(this.btn(t, "edit-existing", `Edit existing "${exists.alias}" instead`, (_e, cx) => {
        const h = this.data?.hosts.find((x) => x.alias === exists.alias);
        if (h) this.startForm(h, cx);
      }))))
      .when(Boolean(dup), (el) => el.child(v_flex().gap(6)
        .child(this.note(t, `"${dup.alias}" (${short(dup.path)}:${dup.line}) already reaches the same server, user, port and key.`))
        .child(h_flex().gap(6)
          .child(this.btn(t, "use-existing", `Use "${dup.alias}"`, (_e, cx) => { this.view = "list"; this.openRow = dup.alias; cx.notify(); }, { primary: true }))
          .when(!p.op.allowDuplicate, (e2) => e2.child(this.btn(t, "dup-anyway", "Save under the new name anyway", (_e, cx) => { this.allowDuplicate = true; this.preview(this.op(), cx); }))))))
      .when(p.reuse && !dup, (el) => el.child(h_flex().child(this.btn(t, "reuse", `Use "${p.reuse}"`, (_e, cx) => { this.view = "list"; this.openRow = p.reuse; cx.notify(); }, { primary: true }))))
      .children(p.warnings.map((w) => this.note(t, `⚠ ${w}`)))
      .children(p.changes.map((c) => this.diff(t, c)))
      .when(p.changes.length > 0, (el) => el.child(this.note(t, "Saving backs up the current files to ~/.ssh/herdr/backups, writes atomically, has OpenSSH validate the result, and refuses if a file changed since this preview.", t.dim)))
      .child(h_flex().gap(8).pt(4)
        .child(this.btn(t, "back", "Back", (_e, cx) => { this.view = p.action === "remove" ? "list" : "form"; cx.notify(); }))
        .child(div().flex_1())
        .child(this.btn(t, "confirm", this.busyApply ? "Saving…" : p.action === "remove" ? "Remove entry" : "Confirm and save", (_e, cx) => this.confirm(cx),
          { primary: p.action !== "remove", danger: p.action === "remove", disabled: Boolean(p.blocked) || !p.changes.length || this.busyApply })));
  }

  doneView(t) {
    const r = this.result;
    const alias = r.action === "remove" ? r.op?.alias ?? this.plan?.op.alias : r.fields?.alias;
    return v_flex().gap(10)
      .child(div().text_size(13.5).font_semibold().child(r.action === "remove" ? `Removed ${alias}` : `Saved ${alias}`))
      .child(this.note(t, `Written: ${(r.written ?? []).map(short).join(", ") || "nothing"}${r.backups?.length ? ` · backup: ${r.backups.map(short).join(", ")}` : ""}`, t.dim))
      .child(r.verified
        ? this.note(t, r.action === "remove" ? "ssh no longer has this alias." : "Confirmed with ssh -G: ssh now uses exactly these settings.", t.ansi2)
        : this.note(t, `Saved, but ssh's effective configuration differs: ${r.mismatches.join("; ")}. Another entry or an earlier directive overrides it; check ~/.ssh/config.`, t.blocked))
      .child(h_flex().gap(8).pt(4)
        .child(this.btn(t, "done-list", "Back to connections", (_e, cx) => { this.view = "list"; this.openRow = r.action === "remove" ? null : alias; cx.notify(); }, { primary: true }))
        .when(r.action !== "remove", (el) => el.child(this.btn(t, "done-test", "Test it now", (_e, cx) => { this.view = "list"; this.openRow = alias; this.test(alias, { alias }, cx); }))));
  }

  render() {
    const t = theme();
    const body = this.view === "form" ? this.formView(t) : this.view === "preview" ? this.previewView(t) : this.view === "done" ? this.doneView(t) : this.listView(t);
    return v_flex().id("ssh-connections").track_focus(this.handle).size_full().min_h(0).bg(t.popover).text_color(t.foreground)
      .child(h_flex().flex_none().px(18).pt(16).pb(4).items_center()
        .child(svg(I("server")).size(15).text_color(t.muted).mr(8))
        .child(div().flex_1().text_size(15).font_semibold().child("SSH connections"))
        .child(div().id("ssh-esc").px(6).py(2).rounded(5).text_size(11).text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(() => this.close()).child("Esc")))
      .child(div().flex_none().px(18).pb(10).text_size(12.3).line_height("18px").text_color(t.muted)
        .child("Hosts from ~/.ssh/config and its includes. New ones go to ~/.ssh/herdr/hosts.conf, included first so they apply as written."))
      .child(v_flex().id("ssh-body").flex_1().min_h(0).px(18).pb(18).overflow_y_scrollbar().child(body));
  }
}
