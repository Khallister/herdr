// Lossless OpenSSH client config reader and editor.
//
// The file is kept as its original lines; parsing only annotates them. Edits replace, insert
// or delete whole lines of one block, so every other byte (comments, spacing, unrelated
// blocks, Include and Match lines) is written back exactly as it was read.
//
// Tokenizing follows OpenSSH's readconf.c / argv_split(): a keyword ends at whitespace or
// "=", one optional "=" separates it from its arguments, arguments are split on whitespace,
// single and double quotes group, backslash escapes a quote/backslash/space, and an unquoted
// argument starting with "#" ends the line (a trailing comment).
//
// Precedence is NOT reimplemented here: effective settings come from `ssh -G`. This module only
// answers structural questions (where is a Host declared, can that block be edited safely,
// which patterns or Match blocks might also apply).

import path from "node:path";

export const MAX_INCLUDE_DEPTH = 16; // ssh's READCONF_MAX_DEPTH

/** Splits one config line. Returns null for blank and comment-only lines. */
export function tokenizeLine(raw) {
  const line = raw.replace(/\r$/, "");
  let i = 0;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) i++;
  if (i >= line.length || line[i] === "#") return null;
  const indent = line.slice(0, i);
  const kwStart = i;
  while (i < line.length && !/[\s=]/.test(line[i])) i++;
  const keyword = line.slice(kwStart, i);
  // separator: whitespace, at most one "=", whitespace
  while (i < line.length && (line[i] === " " || line[i] === "\t")) i++;
  if (line[i] === "=") i++;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) i++;
  const valueStart = i;
  const args = [];
  let commentIdx = -1;
  let error = null;
  while (i < line.length) {
    while (i < line.length && (line[i] === " " || line[i] === "\t")) i++;
    if (i >= line.length) break;
    if (line[i] === "#") { commentIdx = i; break; }
    let arg = "";
    let quote = null;
    let any = false;
    while (i < line.length) {
      const c = line[i];
      if (quote) {
        if (c === "\\" && (line[i + 1] === quote || line[i + 1] === "\\")) { arg += line[i + 1]; i += 2; continue; }
        if (c === quote) { quote = null; i++; continue; }
        arg += c; i++; continue;
      }
      if (c === " " || c === "\t") break;
      if (c === "\\" && /["'\\ ]/.test(line[i + 1] ?? "")) { arg += line[i + 1]; i += 2; any = true; continue; }
      if (c === '"' || c === "'") { quote = c; any = true; i++; continue; }
      arg += c; any = true; i++;
    }
    if (quote) { error = "unterminated quote"; }
    if (any || arg) args.push(arg);
  }
  let valueEnd = commentIdx >= 0 ? commentIdx : line.length;
  while (valueEnd > valueStart && /\s/.test(line[valueEnd - 1])) valueEnd--;
  return {
    indent,
    keyword,
    key: keyword.toLowerCase(),
    args,
    valueStart,
    valueEnd,
    comment: commentIdx >= 0 ? line.slice(valueEnd) : "",
    error,
  };
}

/** True when `s` holds a wildcard (`*`, `?`) or negation as ssh's match_pattern sees them. */
export const isPattern = (s) => /[*?]/.test(s) || s.startsWith("!");

/** ssh's match_pattern(): `*` any run, `?` one char, case-insensitive for host names. */
export function globMatch(pattern, text) {
  const p = pattern.toLowerCase(), t = text.toLowerCase();
  let pi = 0, ti = 0, star = -1, mark = 0;
  while (ti < t.length) {
    if (pi < p.length && (p[pi] === "?" || p[pi] === t[ti])) { pi++; ti++; }
    else if (pi < p.length && p[pi] === "*") { star = pi++; mark = ti; }
    else if (star >= 0) { pi = star + 1; ti = ++mark; }
    else return false;
  }
  while (pi < p.length && p[pi] === "*") pi++;
  return pi === p.length;
}

/** ssh's match_hostname over a Host line's patterns (comma lists are split too). */
export function hostPatternsMatch(patterns, host) {
  let positive = false;
  for (const raw of patterns) {
    for (const pat of raw.split(",")) {
      if (!pat) continue;
      if (pat.startsWith("!")) { if (globMatch(pat.slice(1), host)) return false; }
      else if (globMatch(pat, host)) positive = true;
    }
  }
  return positive;
}

/**
 * Parses text into lines + blocks. A block is the global preamble (kind "global"), or a
 * `Host`/`Match` line and every line until the next one.
 */
export function parseConfig(text) {
  const src = text ?? "";
  const newline = src.includes("\r\n") ? "\r\n" : "\n";
  const trailingNewline = src.length === 0 || src.endsWith("\n");
  const lines = src.length === 0 ? [] : src.replace(/\r?\n$/, "").split(/\r?\n/);
  const blocks = [{ kind: "global", start: 0, end: 0, header: null, patterns: [], directives: [] }];
  const errors = [];
  lines.forEach((raw, index) => {
    const tok = tokenizeLine(raw);
    if (!tok) return;
    if (tok.error) errors.push({ line: index, message: tok.error });
    if (tok.key === "host" || tok.key === "match") {
      blocks[blocks.length - 1].end = index;
      blocks.push({ kind: tok.key, start: index, end: lines.length, header: { index, ...tok }, patterns: tok.args, directives: [] });
    } else {
      blocks[blocks.length - 1].directives.push({ index, ...tok });
    }
  });
  blocks[blocks.length - 1].end = lines.length;
  return { lines, newline, trailingNewline, blocks, errors };
}

export function serialize(doc) {
  if (!doc.lines.length) return "";
  return doc.lines.join(doc.newline) + (doc.trailingNewline ? doc.newline : "");
}

/** Expands Include arguments the way ssh does for a user config. */
export function includeTargets(arg, home) {
  let p = arg;
  if (p === "~" || p.startsWith("~/")) p = path.join(home, p.slice(1));
  else if (!path.isAbsolute(p)) p = path.join(home, ".ssh", p);
  return path.normalize(p);
}

/** Glob expansion (`*`, `?` per path segment), sorted like glob(3). `fs` is node:fs/promises-like. */
export async function expandGlob(pattern, fs) {
  if (!/[*?[]/.test(pattern)) return [pattern];
  const parts = pattern.split(path.sep);
  let bases = [parts[0] === "" ? path.sep : parts[0]];
  for (let i = 1; i < parts.length; i++) {
    const seg = parts[i];
    if (!seg) continue;
    const next = [];
    for (const base of bases) {
      if (!/[*?]/.test(seg)) { next.push(path.join(base, seg)); continue; }
      let names = [];
      try { names = await fs.readdir(base); } catch { continue; }
      for (const n of names.sort()) {
        if (n.startsWith(".") && !seg.startsWith(".")) continue;
        if (globMatchCase(seg, n)) next.push(path.join(base, n));
      }
    }
    bases = next;
  }
  return bases;
}

// File globs are case-sensitive, unlike host patterns.
function globMatchCase(pattern, text) {
  const re = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
  return re.test(text);
}

/**
 * Reads ~/.ssh/config and everything it includes.
 * Returns { files: [{ path, origin, doc, exists, include?: { from, line, conditional } }], problems }.
 * origin: "user" (~/.ssh/config), "managed" (Herdr's file), "included" (any other included file).
 */
export async function loadConfigTree({ fs, home, mainPath, managedPath }) {
  const files = [];
  const problems = [];
  const seen = new Set();
  async function visit(file, origin, include, depth) {
    if (depth > MAX_INCLUDE_DEPTH) { problems.push({ path: file, message: "Include nesting deeper than 16 levels; ssh stops here too" }); return; }
    if (seen.has(file)) return; // ssh would loop until the depth limit; we read each file once
    seen.add(file);
    let text = null;
    try {
      text = await fs.readFile(file, "utf8");
    } catch (e) {
      if (e.code !== "ENOENT") problems.push({ path: file, message: `can't read: ${e.code ?? e.message}` });
    }
    const doc = parseConfig(text ?? "");
    const entry = { path: file, origin, doc, exists: text != null, include };
    files.push(entry);
    for (const err of doc.errors) problems.push({ path: file, line: err.line + 1, message: err.message });
    for (const block of doc.blocks) {
      for (const d of block.directives) {
        if (d.key !== "include") continue;
        d.includeFiles = [];
        for (const arg of d.args) {
          const targets = await expandGlob(includeTargets(arg, home), fs);
          for (const t of targets) {
            d.includeFiles.push(path.normalize(t));
            const o = path.normalize(t) === path.normalize(managedPath) ? "managed" : "included";
            await visit(path.normalize(t), o, { from: file, line: d.index + 1, conditional: block.kind !== "global" || Boolean(include?.conditional), block: block.kind === "global" ? null : `${block.header.keyword} ${block.patterns.join(" ")}` }, depth + 1);
          }
        }
      }
    }
  }
  await visit(path.normalize(mainPath), "user", null, 0);
  return { files, problems };
}

export const EDITABLE_KEYS = ["hostname", "user", "port", "identityfile"];

/**
 * Every explicit host alias (a Host argument with no wildcard or negation), in the order ssh
 * reads them, with whether Herdr can edit its block and why not.
 */
export function collectHosts(tree, { mainPath }) {
  const byAlias = new Map();
  const rules = []; // wildcard Host blocks and Match blocks: read-only, shown for context
  // Walk in the order ssh reads: an Include's files are read where the Include line is.
  const byPath = new Map(tree.files.map((f) => [f.path, f]));
  const ordered = [];
  const walked = new Set();
  (function walk(f) {
    if (!f || walked.has(f.path)) return;
    walked.add(f.path);
    for (const block of f.doc.blocks) {
      ordered.push([f, block]);
      for (const d of block.directives) for (const p of d.includeFiles ?? []) walk(byPath.get(p));
    }
  })(tree.files[0]);
  for (const f of tree.files) if (!walked.has(f.path)) for (const block of f.doc.blocks) ordered.push([f, block]);
  for (const [f, block] of ordered) {
    {
      if (block.kind === "match") {
        rules.push({ kind: "match", path: f.path, origin: f.origin, line: block.start + 1, text: f.doc.lines[block.start].trim(), keys: block.directives.map((d) => d.keyword) });
        continue;
      }
      if (block.kind !== "host") continue;
      const explicit = block.patterns.filter((p) => !isPattern(p) && !p.includes(","));
      if (explicit.length < block.patterns.length) {
        rules.push({ kind: "host", path: f.path, origin: f.origin, line: block.start + 1, patterns: block.patterns, text: f.doc.lines[block.start].trim(), keys: block.directives.map((d) => d.keyword) });
      }
      for (const alias of explicit) {
        const def = { path: f.path, origin: f.origin, line: block.start + 1, block, file: f, patterns: block.patterns };
        if (!byAlias.has(alias)) byAlias.set(alias, { alias, defs: [] });
        byAlias.get(alias).defs.push(def);
      }
    }
  }
  const hosts = [];
  for (const { alias, defs } of byAlias.values()) {
    const first = defs[0];
    hosts.push({
      alias,
      path: first.path,
      origin: first.origin,
      line: first.line,
      patterns: first.patterns,
      conditional: Boolean(first.file.include?.conditional),
      definedAt: defs.map((d) => ({ path: d.path, line: d.line })),
      readOnlyReason: editBlockProblem(alias, defs, mainPath),
    });
  }
  return { hosts, rules };
}

function editBlockProblem(alias, defs, mainPath) {
  const d = defs[0];
  if (defs.length > 1) return `"${alias}" is declared ${defs.length} times (${defs.map((x) => `${path.basename(x.path)}:${x.line}`).join(", ")}); ssh merges them, so editing one would be misleading`;
  if (d.origin === "included") return `declared in an included file (${d.path}); Herdr only edits ~/.ssh/config and its own ~/.ssh/herdr/hosts.conf`;
  if (d.origin === "user" && path.normalize(d.path) !== path.normalize(mainPath)) return "not in ~/.ssh/config";
  if (d.file.include?.conditional) return `its file is included inside "${d.file.include.block}", so it only applies conditionally`;
  if (d.patterns.length !== 1) return `its Host line lists several patterns (${d.patterns.join(" ")}); editing would change all of them`;
  const counts = {};
  for (const x of d.block.directives) {
    if (x.key === "include") return `its block contains an Include (line ${x.index + 1})`;
    if (x.error) return `line ${x.index + 1} has ${x.error}`;
    counts[x.key] = (counts[x.key] ?? 0) + 1;
  }
  for (const k of EDITABLE_KEYS) if ((counts[k] ?? 0) > 1) return `it has ${counts[k]} ${k} lines`;
  return null;
}

/** Blocks (wildcard Host, Match) that may also apply to `alias`, other than its own. */
export function rulesAffecting(tree, alias) {
  const out = [];
  for (const f of tree.files) {
    for (const block of f.doc.blocks) {
      if (block.kind === "match") {
        out.push({ kind: "match", path: f.path, line: block.start + 1, text: f.doc.lines[block.start].trim(), keys: block.directives.map((d) => d.keyword), certain: false });
      } else if (block.kind === "host" && block.patterns.some(isPattern) && hostPatternsMatch(block.patterns, alias)) {
        out.push({ kind: "host", path: f.path, line: block.start + 1, text: f.doc.lines[block.start].trim(), keys: block.directives.map((d) => d.keyword), certain: true });
      } else if (block.kind === "global" && f.origin !== "user" && block.directives.some((d) => d.key !== "include")) {
        // a file's preamble applies to everything when the file is included unconditionally
        if (!f.include?.conditional) out.push({ kind: "global", path: f.path, line: (block.directives[0]?.index ?? 0) + 1, text: "(top of file)", keys: block.directives.filter((d) => d.key !== "include").map((d) => d.keyword), certain: true });
      }
    }
  }
  const main = tree.files.find((f) => f.origin === "user");
  const pre = main?.doc.blocks[0].directives.filter((d) => d.key !== "include") ?? [];
  if (pre.length) out.push({ kind: "global", path: main.path, line: pre[0].index + 1, text: "(top of ~/.ssh/config)", keys: pre.map((d) => d.keyword), certain: true });
  return out;
}

// ---------------------------------------------------------------- editing

/** Quotes an argument for a config line when it needs it. Callers have already rejected `"` and control chars. */
export function quoteArg(v) {
  return /[\s#'\\]/.test(v) || v === "" ? `"${v}"` : v;
}

/**
 * Renders a new Host block. `fields`: { alias, hostname, user, port, identityFile }
 * `extra`: [[keyword, value]] appended after the fields.
 */
export function renderHostBlock(fields, extra = []) {
  const pairs = [["HostName", fields.hostname], ["User", fields.user], ["Port", String(fields.port)], ["IdentityFile", fields.identityFile], ...extra];
  return [`Host ${fields.alias}`, ...pairs.filter(([, v]) => v != null && v !== "").map(([k, v]) => `    ${k} ${quoteArg(v)}`)];
}

function clone(doc) {
  return { ...doc, lines: [...doc.lines] };
}

/** Appends lines as a new block, separated from what is above by one blank line. */
export function appendBlock(doc, blockLines) {
  const out = clone(doc);
  if (out.lines.length && out.lines[out.lines.length - 1].trim() !== "") out.lines.push("");
  out.lines.push(...blockLines);
  out.trailingNewline = true;
  return parseConfig(serialize(out));
}

function lastDirectiveIndex(block) {
  return block.directives.length ? block.directives[block.directives.length - 1].index : block.start;
}

/**
 * Sets HostName/User/Port/IdentityFile inside one Host block. Existing lines keep their indent,
 * keyword spelling and trailing comment; missing keys are inserted after the block's last
 * directive. Throws if the block isn't safely editable (callers check readOnlyReason first).
 */
export function editHostBlock(doc, blockStart, values) {
  const block = doc.blocks.find((b) => b.start === blockStart && b.kind === "host");
  if (!block) throw new Error("block not found");
  const out = clone(doc);
  const names = { hostname: "HostName", user: "User", port: "Port", identityfile: "IdentityFile" };
  const indent = block.directives[0]?.indent || "    ";
  const inserts = [];
  for (const key of EDITABLE_KEYS) {
    if (!(key in values)) continue;
    const value = values[key] == null ? null : String(values[key]);
    const lines = block.directives.filter((d) => d.key === key);
    if (lines.length > 1) throw new Error(`block has ${lines.length} ${key} lines`);
    if (lines.length === 1) {
      const d = lines[0];
      if (value == null) { out.lines[d.index] = null; continue; } // removal
      const raw = doc.lines[d.index].replace(/\r$/, "");
      out.lines[d.index] = raw.slice(0, d.valueStart) + quoteArg(value) + d.comment;
    } else if (value != null) {
      inserts.push(`${indent}${names[key]} ${quoteArg(value)}`);
    }
  }
  if (inserts.length) out.lines.splice(lastDirectiveIndex(block) + 1, 0, ...inserts);
  out.lines = out.lines.filter((l) => l !== null);
  return parseConfig(serialize(out));
}

/** Renames the single pattern on a Host line, keeping everything else on that line. */
export function renameHostBlock(doc, blockStart, alias) {
  const block = doc.blocks.find((b) => b.start === blockStart && b.kind === "host");
  if (!block || block.patterns.length !== 1) throw new Error("only single-alias Host lines can be renamed");
  const out = clone(doc);
  const raw = doc.lines[block.start].replace(/\r$/, "");
  out.lines[block.start] = raw.slice(0, block.header.valueStart) + alias + block.header.comment;
  return parseConfig(serialize(out));
}

/**
 * Deletes one Host block: its header and directives, and comment lines inside it, but not the
 * blank/comment lines that trail it (those usually introduce the next block).
 */
export function removeHostBlock(doc, blockStart) {
  const block = doc.blocks.find((b) => b.start === blockStart && b.kind === "host");
  if (!block) throw new Error("block not found");
  const out = clone(doc);
  let end = lastDirectiveIndex(block) + 1;
  // swallow one blank line so blocks don't drift apart
  let start = block.start;
  if (start > 0 && out.lines[start - 1].trim() === "" && (end >= out.lines.length || out.lines[end]?.trim() === "")) start--;
  out.lines.splice(start, end - start);
  while (out.lines.length && out.lines[0].trim() === "" && start === 0) { out.lines.shift(); }
  return parseConfig(serialize(out));
}

/** Where (if anywhere) `doc` already includes `managedPath`. */
export function findInclude(doc, managedPath, home) {
  for (const block of doc.blocks) {
    for (const d of block.directives) {
      if (d.key !== "include") continue;
      if (d.args.some((a) => includeTargets(a, home) === path.normalize(managedPath))) {
        return { line: d.index + 1, conditional: block.kind !== "global", block: block.kind === "global" ? null : doc.lines[block.start].trim(), first: block.kind === "global" && block.directives[0] === d };
      }
    }
  }
  return null;
}

/** Puts the managed Include on the first line, ahead of every Host/Match so its entries win. */
export function prependInclude(doc, includeArg) {
  const out = clone(doc);
  const head = ["# Herdr SSH connections: hosts added in Herdr live in this file.", `Include ${quoteArg(includeArg)}`];
  out.lines = [...head, ...(out.lines.length ? [""] : []), ...out.lines];
  out.trailingNewline = true;
  return parseConfig(serialize(out));
}

// ---------------------------------------------------------------- preview

/** Line diff (LCS) as hunks with `context` lines around changes. */
export function diffLines(before, after, context = 2) {
  const a = before === "" ? [] : before.replace(/\n$/, "").split("\n");
  const b = after === "" ? [] : after.replace(/\n$/, "").split("\n");
  const n = a.length, m = b.length;
  if (n * m > 4_000_000) return [{ op: "note", text: "(file too large to diff)" }];
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { ops.push({ op: " ", text: a[i], ln: j + 1 }); i++; j++; }
    else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) { ops.push({ op: "+", text: b[j], ln: j + 1 }); j++; }
    else { ops.push({ op: "-", text: a[i] }); i++; }
  }
  const keep = ops.map(() => false);
  ops.forEach((o, k) => { if (o.op !== " ") for (let x = Math.max(0, k - context); x <= Math.min(ops.length - 1, k + context); x++) keep[x] = true; });
  const out = [];
  let gap = false;
  ops.forEach((o, k) => {
    if (keep[k]) { out.push(o); gap = false; }
    else if (!gap) { out.push({ op: "…", text: "" }); gap = true; }
  });
  return out;
}
