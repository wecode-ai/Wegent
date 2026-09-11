// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Children, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  KanbanBoard,
  KanbanColumn,
  KanbanColumnDropzone,
  type KanbanDndAdapter,
} from "./KanbanBoard";

const DndContext = ({ children }: { children?: ReactNode }) => children;
const DragOverlay = ({ children }: { children?: ReactNode }) => children;

function dndAdapter(isOver = false): KanbanDndAdapter {
  return {
    DndContext,
    DragOverlay,
    useDroppable: () => ({
      isOver,
      setNodeRef: vi.fn(),
    }),
  };
}

function elementChildren(element: ReactElement): ReactElement[] {
  return Children.toArray(element.props.children).filter(
    (child): child is ReactElement =>
      typeof child === "object" && child !== null && "props" in child,
  );
}

describe("KanbanColumnDropzone", () => {
  it("preserves the Wework dropzone classes, test id and active drag hint", () => {
    const element = KanbanColumnDropzone({
      children: <article>Issue</article>,
      dnd: dndAdapter(true),
      dragHint: "移到这里：等待开始",
      dropId: "todo-column:pending",
      testId: "cloud-todo-column-dropzone-pending",
    });
    const children = elementChildren(element);

    expect(element.props["data-testid"]).toBe(
      "cloud-todo-column-dropzone-pending",
    );
    expect(element.props.className).toContain(
      "relative min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-y-contain px-2 pb-2 pt-2 transition-colors",
    );
    expect(element.props.className).toContain(
      "rounded-xl bg-muted ring-1 ring-inset ring-focus/50",
    );
    expect(children[0].props["data-testid"]).toBe(
      "cloud-todo-column-drag-hint-pending",
    );
    expect(children[0].props.children).toBe("移到这里：等待开始");
  });
});

describe("KanbanColumn", () => {
  it("renders the original column shell and actionable empty state through generic data", () => {
    const onCreate = vi.fn();
    const column = { key: "inbox", label: "收集箱", dotClass: "bg-zinc-400" };
    const element = KanbanColumn({
      activeDragItemId: "ISSUE-1",
      column,
      dnd: dndAdapter(),
      dropIdPrefix: "todo-column:",
      getColumnDotClassName: (value) => value.dotClass,
      getColumnDragHint: () => undefined,
      getColumnEmptyState: () => ({
        action: {
          ariaLabel: "在收集箱中新建 Issue",
          label: "创建第一个 Issue",
          onClick: onCreate,
        },
        hint: "先记录一个需要推进的问题、目标或交付。",
      }),
      getColumnItems: () => [],
      getColumnKey: (value) => value.key,
      getColumnLabel: (value) => value.label,
      getColumnWidthClassName: () => "w-[292px]",
      getItemKey: () => "",
      renderAddIcon: () => <svg />,
      renderDragOverlay: () => null,
      renderItem: () => null,
      testIdPrefix: "cloud-todo",
    });
    const [header, dropzone] = elementChildren(element);
    const dropzoneChildren = Children.toArray(dropzone.props.children);
    const emptyButton = dropzoneChildren.find(
      (child) =>
        typeof child === "object" &&
        child !== null &&
        "props" in child &&
        child.props["data-testid"] === "cloud-todo-column-empty-add-inbox",
    ) as ReactElement;

    expect(element.props["data-testid"]).toBe("cloud-todo-column-inbox");
    expect(element.props.className).toContain(
      "group flex max-h-full shrink-0 flex-col rounded-2xl bg-muted p-0.5 transition-[width]",
    );
    expect(element.props.className).toContain("w-[292px]");
    expect(element.props.className).toContain(
      "outline-dashed outline-1 -outline-offset-1 outline-border",
    );
    expect(header.type).toBe("header");
    expect(dropzone.type).toBe(KanbanColumnDropzone);
    expect(dropzone.props.dropId).toBe("todo-column:inbox");
    expect(emptyButton.props["aria-label"]).toBe("在收集箱中新建 Issue");
    expect(emptyButton.props.className).toContain(
      "flex min-h-24 w-full flex-col items-center justify-center gap-1 rounded-xl border border-dashed",
    );

    emptyButton.props.onClick();
    expect(onCreate).toHaveBeenCalledOnce();
  });
});

describe("KanbanBoard", () => {
  it("owns the DndContext, column container and DragOverlay structure", () => {
    const contextProps = { sensors: ["pointer"], onDragEnd: vi.fn() };
    const element = KanbanBoard({
      activeDragItemId: null,
      columns: [{ key: "pending" }],
      dnd: dndAdapter(),
      dndContextProps: contextProps,
      dropIdPrefix: "todo-column:",
      getColumnDotClassName: () => "bg-zinc-400",
      getColumnDragHint: () => undefined,
      getColumnEmptyState: () => undefined,
      getColumnItems: () => [],
      getColumnKey: (column) => column.key,
      getColumnLabel: () => "待开始",
      getColumnWidthClassName: () => "w-[292px]",
      getItemKey: () => "",
      renderAddIcon: () => null,
      renderDragOverlay: () => <article>Dragging</article>,
      renderItem: () => null,
      testIdPrefix: "cloud-todo",
    });
    const [columns, overlay] = elementChildren(element);

    expect(element.type).toBe(DndContext);
    expect(element.props.sensors).toEqual(["pointer"]);
    expect(element.props.onDragEnd).toBe(contextProps.onDragEnd);
    expect(columns.props.className).toBe(
      "flex h-full min-h-0 items-start gap-3.5 px-6",
    );
    expect(elementChildren(columns)[0].type).toBe(KanbanColumn);
    expect(overlay.type).toBe(DragOverlay);
    expect(overlay.props.dropAnimation).toBeNull();
  });
});
