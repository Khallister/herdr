// Project notes: side panel for the current space's project (git root of its first terminal's folder).
// Tabs: Memory (recent claude-mem observations/summaries of that project, via the worker on
// localhost:37701, falling back to a read-only look at ~/.claude-mem/claude-mem.db) and
// CLAUDE.md / AGENTS.md (rendered markdown, Edit/Save with conflict check, or Create).
// No props.role, no nextCommand commands. Remote spaces are skipped with a message.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextView, Editor, EditorState } from "gpui-base";
import { spaces, panes, focused, run, exec, theme, home, readTextFile, writeTextFile, settings } from "herdr";

const WORKER = "http://localhost:37701";
const LIMIT = 30;
const DOCS = ["CLAUDE.md", "AGENTS.md"];
const TEMPLATE = "# Project notes\n\n## Overview\n\n## Commands\n\n## Conventions\n";
const base = (p) => p.replace(/\/+$/, "").split("/").pop();

const age = (ms) => {
  const m = Math.floor(ms / 60000);
  return m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
};
const TYPE = { bugfix: ["ansi1", "B"], feature: ["ansi2", "F"], change: ["ansi4", "C"], discovery: ["ansi6", "D"], decision: ["ansi5", "?"], refactor: ["ansi3", "R"], summary: ["accent", "S"] };

function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}

const list = (v) => {
  if (Array.isArray(v)) return v;
  if (typeof v === "string" && v.trim().startsWith("[")) { try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch {} }
  return [];
};

function normObs(o) {
  const facts = list(o.facts), files = [...list(o.files_modified), ...list(o.files_read)];
  const body = [o.subtitle ? `*${o.subtitle}*` : "", o.narrative ?? o.text ?? "",
    facts.length ? facts.map((f) => `- ${f}`).join("\n") : "",
    files.length ? "Files: " + [...new Set(files)].slice(0, 8).map((f) => `\`${f}\``).join(", ") : ""].filter(Boolean).join("\n\n");
  return { key: `o${o.id}`, type: o.type ?? "change", title: o.title || o.subtitle || "(untitled)", body, at: Number(o.created_at_epoch) || 0 };
}

function normSum(s) {
  const part = (h, v) => (v ? `**${h}**\n\n${v}` : "");
  const body = [part("Investigated", s.investigated), part("Learned", s.learned), part("Completed", s.completed), part("Next steps", s.next_steps), s.notes ?? ""].filter(Boolean).join("\n\n");
  return { key: `s${s.id}`, type: "summary", title: s.request || "Session summary", body, at: Number(s.created_at_epoch) || 0 };
}

async function fromWorker(project) {
  const q = `project=${encodeURIComponent(project)}&limit=${LIMIT}`;
  const get = async (path) => {
    const r = await fetch(`${WORKER}${path}?${q}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    return Array.isArray(j) ? j : j.items ?? j.observations ?? j.summaries ?? [];
  };
  const [o, s] = await Promise.all([get("/api/observations"), get("/api/summaries").catch(() => [])]);
  return [...o.map(normObs), ...s.map(normSum)];
}

async function fromDb(project) {
  const db = `${home()}/.claude-mem/claude-mem.db`;
  const esc = project.replace(/'/g, "''");
  const run1 = async (sql) => {
    const r = await exec("sqlite3", ["-readonly", "-json", db, sql], { timeout: 10000 });
    if (r.code !== 0) throw new Error(r.stderr.trim() || "sqlite3 failed");
    return r.stdout.trim() ? JSON.parse(r.stdout) : [];
  };
  const o = await run1(`select * from observations where project='${esc}' order by created_at_epoch desc limit ${LIMIT}`);
  const s = await run1(`select * from session_summaries where project='${esc}' order by created_at_epoch desc limit ${LIMIT}`);
  return [...o.map(normObs), ...s.map(normSum)];
}

export default class ProjectNotes extends View {
  init(_props, cx) {
    this.key = null;
    this.root = null;
    this.remote = null;
    this.projErr = null;
    this.tab = "memory";
    this.mem = { items: [], err: null, loading: false, src: null };
    this.open = null;
    this.filter = "";
    this.input = InputState.new({ placeholder: "Search memory…" });
    this.input.on("change", (_e, cx) => { this.filter = this.input.value(); cx.notify(); });
    this.doc = { name: null, text: null, path: null, names: [] };
    this.editing = false;
    this.editor = null;
    this.docMsg = null;
    cx.timer.every(60000, (cx) => { if (this.tab === "memory" && this.root) this.loadMem(cx); });
  }

  // Resolve the project, then reload both tabs.
  refresh(cx) {
    cx.spawn(async (cx) => {
      const key = this.key;
      this.editing = false; this.editor = null; this.docMsg = null; this.open = null;
      if (this.remote || !this.cwd) { this.root = null; cx.notify(); return; }
      try {
        const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: this.cwd, timeout: 10000 });
        this.root = r.code === 0 && r.stdout.trim() ? r.stdout.trim() : this.cwd;
        this.projErr = null;
      } catch (e) { this.root = this.cwd; }
      if (key !== this.key) return;
      cx.notify();
      this.loadMem(cx);
      this.loadDoc(cx);
    });
  }

  loadMem(cx) {
    const root = this.root;
    if (!root) return;
    this.mem.loading = true;
    cx.spawn(async (cx) => {
      const project = base(root);
      let items = null, err = null, src = "worker";
      try { items = await fromWorker(project); } catch (e) { err = String(e?.message ?? e); }
      if (!items) {
        try { items = await fromDb(project); src = "db"; err = null; } catch { items = []; err = "claude-mem worker not running"; }
      }
      if (root !== this.root) return;
      items.sort((a, b) => b.at - a.at);
      this.mem = { items: items.slice(0, LIMIT), err, loading: false, src };
      cx.notify();
    });
  }

  loadDoc(cx, pick) {
    const root = this.root;
    if (!root) return;
    cx.spawn(async (cx) => {
      const names = [];
      let texts = {};
      for (const n of DOCS) {
        let text = null;
        try { text = await readTextFile(`${root}/${n}`); } catch {}
        if (text !== null) { names.push(n); texts[n] = text; }
      }
      if (root !== this.root) return;
      const name = pick && names.includes(pick) ? pick : names.includes(this.doc.name) ? this.doc.name : names[0] ?? null;
      this.doc = { name, text: name ? texts[name] : null, path: name ? `${root}/${name}` : null, names };
      cx.notify();
    });
  }

  startEdit() {
    const t = theme();
    this.editor = EditorState.new({ language: "markdown", value: this.doc.text ?? "", font_family: settings().font_family, font_size: 12, line_numbers: false, soft_wrap: true,
      syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3 } });
    this.editing = true;
    this.docMsg = null;
  }

  save(cx) {
    const { path, text } = this.doc;
    const next = this.editor.value();
    cx.spawn(async (cx) => {
      try {
        const now = await readTextFile(path);
        if (now !== text) { this.docMsg = { kind: "conflict", text: "File changed on disk. Not saved." }; cx.notify(); return; }
        await writeTextFile(path, next, text);
        this.doc.text = next;
        this.editing = false; this.editor = null; this.docMsg = null;
      } catch (e) {
        this.docMsg = { kind: "conflict", text: `Not saved: ${String(e?.message ?? e)}` };
      }
      cx.notify();
    });
  }

  create(cx) {
    const path = `${this.root}/CLAUDE.md`;
    cx.spawn(async (cx) => {
      try { await writeTextFile(path, TEMPLATE, null); this.docMsg = null; this.loadDoc(cx, "CLAUDE.md"); }
      catch (e) { this.docMsg = { kind: "error", text: String(e?.message ?? e) }; cx.notify(); }
    });
  }

  btn(t, id, label, onClick, primary) {
    return div().id(id).h(24).px(10).flex_none().flex().items_center().rounded(6).text_size(11.5).cursor_pointer()
      .text_color(primary ? t.solid_foreground : t.foreground).bg(primary ? t.solid : t.raised)
      .hover((s) => s.bg(primary ? t.solid : t.hover)).on_click(onClick).child(label);
  }

  seg(t, id, label, active, onClick) {
    return div().id(id).h(24).px(10).flex().items_center().rounded(6).text_size(11.5).cursor_pointer()
      .text_color(active ? t.foreground : t.dim)
      .when(active, (el) => el.bg(t.selected))
      .when(!active, (el) => el.hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .on_click(onClick).child(label);
  }

  note(t, text, color) {
    return div().px(16).py(8).text_size(12).text_color(color ?? t.dim).child(text);
  }

  memoryView(t, cx) {
    const m = this.mem, q = this.filter.trim().toLowerCase();
    const items = q ? m.items.filter((i) => `${i.title} ${i.body}`.toLowerCase().includes(q)) : m.items;
    const now = Date.now();
    const row = (i) => {
      const [col, glyph] = TYPE[i.type] ?? ["dim", "·"];
      const c = t[col] ?? t.dim, open = this.open === i.key;
      return v_flex().flex_none().child(
        h_flex().id(`mem-${i.key}`).min_h(28).flex_none().px(8).gap(8).items_center().rounded(8).cursor_pointer()
          .when(open, (el) => el.bg(t.selected)).when(!open, (el) => el.hover((s) => s.bg(t.hover)))
          .on_click((_e, cx) => { this.open = open ? null : i.key; cx.notify(); })
          .child(div().w(16).h(16).flex_none().flex().items_center().justify_center().rounded(4).text_size(9.5).text_color(c).border_1().border_color(c).tooltip(i.type).child(glyph))
          .child(div().flex_1().min_w(0).py(4).text_color(t.foreground).when(!open, (el) => el.truncate()).child(i.title))
          .child(div().flex_none().text_size(10.5).text_color(t.dim).child(i.at ? age(now - i.at) : "")),
      ).when(open, (el) => el.child(div().px(14).py(6).text_size(12.5).text_color(t.muted)
        .child(TextView.markdown(`mem-md-${i.key}`, i.body || "_No details._").selectable(true))));
    };
    return v_flex().flex_1().min_h(0)
      .child(div().px(8).pb(6).flex_none()
        .child(Input.new(this.input).h(26).px(8).rounded(6).border_1().border_color(t.border).bg(t.background).text_size(12).text_color(t.foreground)))
      .child(v_flex().flex_1().min_h(0).px(8).pb(14).overflow_y_scrollbar()
        .when(m.err, (el) => el.child(v_flex().gap(8).items_start().child(this.note(t, m.err, t.blocked)).child(div().px(16).child(this.btn(t, "mem-retry", "Retry", (_e, cx) => this.loadMem(cx))))))
        .when(!m.err && m.loading && !m.items.length, (el) => el.child(this.note(t, "Loading…")))
        .when(!m.err && !m.loading && !items.length, (el) => el.child(this.note(t, q ? "No matches" : `No memories for ${base(this.root)}`)))
        .when(m.src === "db" && !m.err, (el) => el.child(this.note(t, "Worker offline: read from database", t.dim)))
        .children(items.map(row)));
  }

  docView(t, cx) {
    const d = this.doc;
    const msg = this.docMsg;
    const msgEl = msg ? this.note(t, msg.text, t.blocked) : null;
    if (!d.name) {
      return v_flex().flex_1().min_h(0).gap(8).child(this.note(t, "No CLAUDE.md or AGENTS.md in this project."))
        .child(div().px(16).child(this.btn(t, "doc-create", "Create CLAUDE.md", (_e, cx) => this.create(cx), true)))
        .when(msgEl, (el) => el.child(msgEl));
    }
    const bar = h_flex().h(28).flex_none().px(12).gap(6).items_center()
      .children(d.names.length > 1 ? d.names.map((n) => this.seg(t, `doc-${n}`, n, n === d.name && true, (_e, cx) => { if (!this.editing) this.loadDoc(cx, n); })) : [div().text_size(11.5).text_color(t.dim).child(d.name)])
      .child(div().flex_1())
      .when(!this.editing, (el) => el.child(this.btn(t, "doc-edit", "Edit", (_e, cx) => { this.startEdit(); cx.notify(); })))
      .when(this.editing, (el) => el.child(this.btn(t, "doc-cancel", "Cancel", (_e, cx) => { this.editing = false; this.editor = null; this.docMsg = null; cx.notify(); }))
        .child(this.btn(t, "doc-save", "Save", (_e, cx) => this.save(cx), true)));
    return v_flex().flex_1().min_h(0).child(bar).when(msgEl, (el) => el.child(msgEl))
      .child(this.editing
        ? div().flex_1().min_h(0).mx(8).mb(8).rounded(6).border_1().border_color(t.border).overflow_hidden().child(Editor.new(this.editor))
        : v_flex().flex_1().min_h(0).px(14).pb(14).text_size(13).text_color(t.foreground).overflow_y_scrollbar()
          .child(TextView.markdown(`doc-md-${d.name}`, d.text || "_Empty file._").selectable(true)));
  }

  render(cx) {
    const t = theme();
    const f = focused();
    const s = spaces().find((x) => x.id === f?.space);
    const remote = s?.machine ?? null;
    const cwd = s && !remote ? place(s, panes()) : null;
    const key = `${remote ?? ""}|${cwd ?? ""}|${s?.id ?? ""}`;
    if (key !== this.key && !(this.cwd === cwd && this.remote === remote && cwd)) {
      this.key = key; this.cwd = cwd; this.remote = remote;
      cx.timer.after(0, (cx) => this.refresh(cx));
    } else this.key = key;

    const iconButton = (id, label, tip, onClick) =>
      div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim)
        .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip).on_click(onClick).child(label);
    const head = h_flex().h(31).pl(16).pr(6).gap(2).items_center().text_size(11.5).text_color(t.dim)
      .child(div().flex_1().min_w(0).truncate().tooltip(this.root ?? "").child(this.root ? base(this.root) : "Notes"))
      .child(iconButton("notes-refresh", "↻", "Refresh", (_e, cx) => { if (this.root) { this.loadMem(cx); if (!this.editing) this.loadDoc(cx); } }));
    const tabs = h_flex().px(12).pb(6).gap(4).flex_none()
      .child(this.seg(t, "tab-memory", "Memory", this.tab === "memory", (_e, cx) => { this.tab = "memory"; cx.notify(); }))
      .child(this.seg(t, "tab-doc", this.doc.name ?? "CLAUDE.md", this.tab === "doc", (_e, cx) => { this.tab = "doc"; cx.notify(); }));

    const shell = (...kids) => v_flex().size_full().min_h(0).bg(t.chrome).text_size(13).child(head).children(kids);
    if (remote) return shell(this.note(t, `Remote space (${remote}): project notes are local only.`));
    if (!cwd) return shell(this.note(t, "No folder for this space."));
    if (!this.root) return shell(this.note(t, "Looking for the project…"));
    return shell(tabs, this.tab === "memory" ? this.memoryView(t, cx) : this.docView(t, cx));
  }
}
