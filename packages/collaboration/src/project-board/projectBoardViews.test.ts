// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { createCollaborationTranslator } from "../i18n";
import {
  boardDropHint,
  matchesBoardView,
  savedBoardColumns,
  type SavedBoardView,
} from "./projectBoardViews";
import {
  resolveStandardCloudBoardDrop,
  resolveStandardCloudBoardMutation,
  type StandardCloudBoardItem,
} from "./useStandardCloudBoardController";
import type { ProjectBoardColumn } from "./ProjectBoardBody";

const lane = (type: "status" | "tag", value: string): ProjectBoardColumn => ({
  key: `${type}:${value}`,
  type,
  groupValue: value,
  label: value,
  status: type === "status" ? value : "",
  dotClass: "bg-zinc-400",
});
const item: StandardCloudBoardItem = {
  id: "issue",
  parent_id: null,
  cloud_project_id: "project",
  status: "in_progress",
  tags: ["frontend", "urgent", "shared"],
  priority: "high",
  sort_order: 0,
  created_at: "2026-10-01",
  updated_at: "2026-10-01",
  version: 1,
};
const t = createCollaborationTranslator("zh-CN");

describe("mixed board lane moves", () => {
  it.each([
    ["status", "in_progress", "status", "in_review", "in_review", item.tags],
    [
      "status",
      "in_progress",
      "tag",
      "backend",
      "in_progress",
      [...item.tags, "backend"],
    ],
    ["tag", "frontend", "status", "pending", "pending", item.tags],
    [
      "tag",
      "frontend",
      "tag",
      "backend",
      "in_progress",
      ["urgent", "shared", "backend"],
    ],
    ["tag", "frontend", "tag", "shared", "in_progress", ["urgent", "shared"]],
  ] as const)(
    "%s:%s → %s:%s updates only the intended fields",
    (sourceType, sourceValue, targetType, targetValue, status, tags) => {
      const move = resolveStandardCloudBoardMutation({
        groupBy: "status",
        item,
        items: [item],
        beforeItemId: null,
        supportsOrder: false,
        sourceColumn: lane(sourceType, sourceValue),
        column: lane(targetType, targetValue),
      })!;
      expect(move.optimisticItems[0]).toMatchObject({ status, tags });
      expect(move.kind).toBe(targetType);
      expect(item.tags).toEqual(["frontend", "urgent", "shared"]);
    },
  );

  it("adding a tag to a completed Issue does not reopen it or issue a status update", () => {
    const move = resolveStandardCloudBoardMutation({
      groupBy: "status",
      item: { ...item, status: "completed" },
      items: [{ ...item, status: "completed" }],
      beforeItemId: null,
      sourceColumn: lane("status", "completed"),
      column: lane("tag", "backend"),
    })!;
    expect(move.kind).toBe("tag");
    expect(move).not.toHaveProperty("status");
    expect(move.optimisticItems[0].status).toBe("completed");
  });

  it.each([false, true])(
    "cross-type drops already matching the target never write (manual=%s)",
    (manualSort) => {
      for (const [sourceColumn, column] of [
        [lane("status", "in_progress"), lane("tag", "frontend")],
        [lane("tag", "frontend"), lane("status", "in_progress")],
      ]) {
        expect(
          resolveStandardCloudBoardMutation({
            groupBy: "status",
            item,
            items: [item],
            beforeItemId: null,
            sourceColumn,
            column,
            manualSort,
          }),
        ).toBeNull();
      }
    },
  );

  it("resolves a drop onto another appearance of the same Item using its target lane", () => {
    const column = lane("tag", "shared");
    expect(
      resolveStandardCloudBoardDrop({
        activeItemId: item.id,
        beforeItemId: item.id,
        columnDropKey: column.key,
        sourceColumnKey: lane("tag", "frontend").key,
        columns: [lane("tag", "frontend"), column],
        extensions: {},
        groupBy: "status",
        items: [item],
      }),
    ).toEqual({
      beforeItemId: null,
      itemId: item.id,
      column,
      sourceColumn: lane("tag", "frontend"),
    });
  });

  it("ignores dropping onto the original appearance of the same Item", () => {
    const column = lane("tag", "frontend");
    expect(
      resolveStandardCloudBoardDrop({
        activeItemId: item.id,
        beforeItemId: item.id,
        columnDropKey: column.key,
        sourceColumnKey: column.key,
        columns: [column],
        extensions: {},
        groupBy: "status",
        items: [item],
      }),
    ).toBeNull();
  });

  it("explains addition versus replacement before a drop", () => {
    expect(
      boardDropHint(
        item,
        lane("tag", "backend"),
        lane("status", "in_progress"),
        "status",
        t,
      ),
    ).toContain("保留当前状态和其他标签");
    expect(
      boardDropHint(
        item,
        lane("tag", "shared"),
        lane("tag", "frontend"),
        "status",
        t,
      ),
    ).toContain("移除「frontend」");
    expect(
      boardDropHint(
        item,
        lane("status", "in_review"),
        lane("tag", "frontend"),
        "status",
        t,
      ),
    ).toContain("保留所有标签");
  });
});

describe("saved board projection", () => {
  const view: SavedBoardView = {
    id: "mixed",
    name: "Mixed",
    columns: [
      { id: "progress", type: "status", value: "in_progress" },
      { id: "frontend", type: "tag", value: "frontend" },
    ],
    filter: { tags: ["frontend", "missing"], match: "all" },
  };

  it("preserves mixed column order and localizes status labels", () => {
    expect(
      savedBoardColumns(
        view,
        [{ id: "in_progress", name: "进行中", color: "blue" }],
        [],
      ),
    ).toMatchObject([
      { key: "progress", type: "status", label: "进行中" },
      { key: "frontend", type: "tag", label: "frontend" },
    ]);
  });
  it("keeps missing tag predicates rather than broadening the view", () => {
    expect(matchesBoardView(item, view)).toBe(false);
    expect(
      matchesBoardView(item, {
        ...view,
        filter: { ...view.filter, match: "any" },
      }),
    ).toBe(true);
    expect(matchesBoardView(item, null)).toBe(true);
  });
  it("uses an unrestricted projection when the optional filter is omitted", () => {
    expect(matchesBoardView(item, { ...view, filter: undefined })).toBe(true);
    expect(matchesBoardView(item, { ...view, filter: {} })).toBe(true);
    expect(
      matchesBoardView(item, { ...view, filter: { tags: ["missing"] } }),
    ).toBe(false);
  });
});
