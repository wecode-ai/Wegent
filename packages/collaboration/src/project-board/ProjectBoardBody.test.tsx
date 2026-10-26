// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom

import { act, Children, type ReactElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { ProjectBoardColumnSortPicker } from "./ProjectBoardColumnSortPicker";
import { createProjectBoardSortLabels } from "./projectBoardSorting";
import { ProjectBoardCardContext } from "./projectBoardCardContext";
import { KanbanBoard } from "../kanban/KanbanBoard";
import {
  ProjectBoardBody,
  ProjectBoardScrollArea,
  type ProjectBoardBodyProps,
  type ProjectBoardStatePort,
} from "./ProjectBoardBody";

function descendants(node: ReactNode): ReactElement[] {
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement;
  return [
    element,
    ...Children.toArray(element.props.children).flatMap((child) =>
      descendants(child),
    ),
  ];
}

function boardState(): ProjectBoardStatePort {
  return {
    externalGroupFilter: "",
    externalQuery: "",
    focusExecutionColumns: false,
    groupBy: "status",
    groupFilter: "",
    query: "",
    getColumnSort: () => ["priority-desc"],
    quickCreateStatus: null,
    scrollRef: { current: null },
    selectGroupBy: vi.fn(),
    selectColumnSort: vi.fn(),
    setExternalGroupFilter: vi.fn(),
    setExternalQuery: vi.fn(),
    setGroupFilter: vi.fn(),
    setQuery: vi.fn(),
    setQuickCreateStatus: vi.fn(),
    toggleFocusExecutionColumns: vi.fn(),
  };
}

function props(): ProjectBoardBodyProps<{ id: string }> {
  return {
    activeDragItemId: null,
    boardError: null,
    boardItemsLoading: false,
    breadcrumb: [],
    columns: [
      {
        dotClass: "bg-zinc-400",
        groupValue: "inbox",
        key: "inbox",
        label: "收集箱",
        status: "inbox",
      },
    ],
    currentParent: null,
    currentParentId: null,
    dnd: {
      DndContext: ({ children }) => children,
      DragOverlay: ({ children }) => children,
      useDroppable: () => ({ isOver: false, setNodeRef: vi.fn() }),
    },
    dndContextProps: {},
    externalGroupLabel: "记录",
    externalGroupValues: [],
    externalManagedLabel: "数据由钉钉托管 · AI 可直接管理",
    externalSearchPlaceholder: "搜索记录",
    focusLabels: { enter: "展开", exit: "退出", title: "专注视图" },
    getColumnDragHint: () => undefined,
    getColumnEmptyState: () => undefined,
    getColumnItems: () => [],
    getItemKey: (item) => item.id,
    groupFields: [{ id: "status", name: "状态" }],
    isExternalBoard: false,
    isMyTasksBoard: false,
    layerCount: 0,
    onBreadcrumbSelect: vi.fn(),
    onSaveGlobalGroupBy: vi.fn(),
    renderDragOverlay: () => null,
    renderExternalGroupPicker: () => null,
    renderGroupPicker: () => null,
    renderItem: () => null,
    renderSkeleton: () => null,
    rootLabel: "Issue",
    rootUnitLabel: "个 Issue",
    saveGlobalDisabled: false,
    saveGlobalLabel: "应用到全局",
    searchPlaceholder: "搜索 Issue",
    showQuickStart: false,
    showSaveGlobal: false,
    state: boardState(),
  };
}

describe("ProjectBoardBody", () => {
  it("keeps card nodes mounted when successful drop feedback moves or clears", () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const container = document.createElement("div");
    const root = createRoot(container);
    const options = props();
    options.renderItem = (item) => <button>{item.id}</button>;
    const renderCards = () => {
      const board = descendants(ProjectBoardBody(options)).find(
        (node) => node.type === KanbanBoard,
      )!;
      act(() =>
        root.render(
          ["first", "second"].map((id) => (
            <div key={id}>
              {board.props.renderItem({ id }, options.columns[0])}
            </div>
          )),
        ),
      );
    };
    try {
      renderCards();
      const cards = [...container.querySelectorAll("button")];
      for (const itemId of ["first", "second", null]) {
        options.dropFeedback = itemId
          ? { itemId, columnKey: "inbox", message: "Moved" }
          : null;
        renderCards();
        const current = [...container.querySelectorAll("button")];
        expect(current[0]).toBe(cards[0]);
        expect(current[1]).toBe(cards[1]);
        expect(
          container.querySelector('[data-testid="board-drop-highlight"]')
            ?.textContent ?? null,
        ).toBe(itemId);
      }
    } finally {
      act(() => root.unmount());
    }
  });

  it("scopes copies of the same Issue to their current group and column", () => {
    const options = props();
    options.state.groupBy = "tag";
    const board = descendants(ProjectBoardBody(options)).find(
      (node) => node.type === KanbanBoard,
    )!;
    const item = { id: "shared-issue" };
    const contexts = ["tag-backend", "tag-shared"].map((columnKey) => {
      const rendered = board.props.renderItem(item, {
        ...options.columns[0],
        key: columnKey,
      });
      expect(rendered.type).toBe(ProjectBoardCardContext.Provider);
      return rendered.props.value;
    });
    expect(contexts).toEqual([
      { groupBy: "tag", columnKey: "tag-backend" },
      { groupBy: "tag", columnKey: "tag-shared" },
    ]);
    options.state.groupBy = "priority";
    expect(
      board.props.renderItem(item, {
        ...options.columns[0],
        key: "priority-high",
      }).props.value,
    ).toEqual({ groupBy: "priority", columnKey: "priority-high" });
  });

  it("renders sorting in each lane header and preserves existing header actions", () => {
    const options = props();
    options.sortLabels = createProjectBoardSortLabels((key) => key);
    options.renderColumnHeaderActions = () => (
      <button data-testid="existing-header-action" />
    );
    const board = descendants(ProjectBoardBody(options)).find(
      (node) => node.type === KanbanBoard,
    )!;
    const header = board.props.renderColumnHeaderActions(
      options.columns[0],
      [],
    );
    const picker = descendants(header).find(
      (node) => node.type === ProjectBoardColumnSortPicker,
    )!;
    expect(
      descendants(header).some(
        (node) => node.props["data-testid"] === "existing-header-action",
      ),
    ).toBe(true);
    expect(picker.props.columnKey).toBe("inbox");
    expect(picker.props.value).toEqual(["priority-desc"]);
    picker.props.onChange(["priority-desc", "created-desc"]);
    expect(options.state.selectColumnSort).toHaveBeenCalledWith("inbox", [
      "priority-desc",
      "created-desc",
    ]);
    expect(options.state.selectGroupBy).not.toHaveBeenCalled();
    options.isExternalBoard = true;
    const externalBoard = descendants(ProjectBoardBody(options)).find(
      (node) => node.type === KanbanBoard,
    )!;
    expect(
      descendants(
        externalBoard.props.renderColumnHeaderActions(options.columns[0], []),
      ).some((node) => node.type === ProjectBoardColumnSortPicker),
    ).toBe(false);
  });

  it("owns the original toolbar, breadcrumb, scroll viewport and Kanban composition", () => {
    const tree = ProjectBoardBody(props());
    expect(tree.props["data-board-cursor-policy"]).toBe("arrow");
    const nodes = descendants(tree);

    expect(
      nodes.find((node) => node.props["data-testid"] === "cloud-board-toolbar"),
    ).toBeDefined();
    expect(
      nodes.find(
        (node) => node.props["data-testid"] === "cloud-todo-board-breadcrumb",
      ),
    ).toBeDefined();
    expect(
      nodes.find((node) => node.type === ProjectBoardScrollArea),
    ).toBeDefined();
    expect(nodes.find((node) => node.type === KanbanBoard)).toBeDefined();
  });

  it("owns the horizontal scroll viewport and visible scrollbar", () => {
    const tree = ProjectBoardScrollArea({
      children: <div>board</div>,
      viewportRef: { current: null },
    });
    const nodes = descendants(tree);

    expect(
      nodes.find((node) => node.props["data-testid"] === "cloud-board-scroll"),
    ).toBeDefined();
    expect(
      nodes.find((node) => node.props["data-testid"] === "cloud-board-scroll")
        ?.props.className,
    ).toContain("overflow-x-auto");
    expect(
      nodes.find((node) => node.props["data-testid"] === "cloud-board-scroll")
        ?.props.className,
    ).not.toContain("[&>div]");
  });
});
