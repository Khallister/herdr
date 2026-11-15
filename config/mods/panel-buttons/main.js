// Tab-bar buttons for extra right-panel tabs (children of the layout's "panel-body" stack):
// Dev (devservers), Notes (project-notes), Machines. Same look and toggle as the tab bar's
// Files / Changes. Adds their ids to shared "workspace.panels" so the tab bar remembers the
// open panel per space for them too. props.items overrides [{id, label, icon}].
// Commands (nextCommand): "toggle:<id>" (e.g. key "panel-buttons.toggle:devservers").

import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { run, theme, layout, shared, setShared, props, nextCommand } from "herdr";

const ITEMS = [
  { id: "filetree", label: "Tree", icon: "mods/filetree/folder.svg" },
  { id: "devservers", label: "Dev", icon: "mods/panel-buttons/dev.svg" },
  { id: "project-notes", label: "Notes", icon: "mods/panel-buttons/notes.svg" },
  { id: "machines", label: "Machines", icon: "mods/panel-buttons/machines.svg" },
];

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

function toggle(id) {
  const panel = find(layout(), "panel"), body = find(layout(), "panel-body");
  if (!body?.children?.some((c) => c.id === id)) return;
  if (panel && !panel.hidden && body.active === id) run("layout.hide", { id: "panel" });
  else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
}

export default class PanelButtons extends View {
  init(_props, cx) {
    const ids = this.items().map((i) => i.id);
    const enabled = shared("workspace.panels") ?? ["files", "changes"];
    // Built-in Files / Changes are replaced by filetree: keep them out of the tab bar.
    const DISABLED = ["files", "changes"];
    const missing = ids.filter((id) => !enabled.includes(id));
    const kept = enabled.filter((id) => !DISABLED.includes(id));
    if (missing.length || kept.length !== enabled.length) setShared("workspace.panels", [...kept, ...missing]);
    cx.spawn(async (cx) => {
      for (;;) {
        const c = String(await nextCommand());
        if (c.startsWith("toggle:")) toggle(c.slice(7));
        cx.notify();
      }
    });
  }

  items() {
    return props()?.items ?? ITEMS;
  }

  render() {
    const t = theme();
    const panel = find(layout(), "panel"), body = find(layout(), "panel-body");
    const has = new Set((body?.children ?? []).map((c) => c.id));
    const stop = (_e, cx) => cx.stop_propagation();
    return h_flex().size_full().gap(3).items_center().justify_end().pr(4).bg(t.chrome).border_b(1).border_color(t.border)
      .children(this.items().filter((i) => has.has(i.id)).map((i) => {
        const on = panel && !panel.hidden && body?.active === i.id;
        return h_flex().id(`panel-${i.id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
          .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
          .hover((s) => s.bg(t.hover)).on_mouse_down("left", stop)
          .on_click(() => toggle(i.id))
          .child(svg(i.icon).size(14)).child(i.label);
      }));
  }
}
