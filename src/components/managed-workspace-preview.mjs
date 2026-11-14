"use client";
import { createElement as h } from "react";

// Independent fidelity review component. Not mounted on the homepage.
export function ManagedWorkspacePreview({ projection }) {
  return h("section", { "aria-label": "Migration data review" }, projection.workspace.boards.map(board => h("article", { key: board.id },
    h("h2", null, board.name), board.tasks.map(task => h("p", { key: task.id }, task.title)),
    !Object.hasOwn(board, "widgets") ? h("p", { "data-widget-presence": "absent" }, "Widget 缺省") :
      h("div", { "data-widget-presence": "present" }, board.widgets.length ? board.widgets.map(widget => h("article", { key: widget.id, "data-widget-id": widget.id, "data-manual-size": widget.manualSize, style: { minHeight: widget.height, gridColumn: `span ${widget.span}` } }, h("strong", null, widget.type), h("pre", null, JSON.stringify(widget.config)))) : "Widget 空清單"))));
}
