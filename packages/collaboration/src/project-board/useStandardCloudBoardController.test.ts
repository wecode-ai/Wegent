// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { ProjectBoardColumn } from "./ProjectBoardBody";
import {
  buildStandardCloudBoardBreadcrumb,
  createStandardCloudBoardColumns,
  executeStandardCloudBoardMutation,
  filterStandardCloudBoardItems,
  resolveStandardCloudBoardDrop,
  resolveStandardCloudBoardMutation,
  type StandardCloudBoardHostExtensions,
  type StandardCloudBoardItem,
} from "./useStandardCloudBoardController";

interface Item extends StandardCloudBoardItem {
  assignee: string;
  title: string;
}

const items: Item[] = [
  {
    id: "parent",
    parent_id: null,
    priority: "high",
    sort_order: 0,
    status: "pending",
    tags: [],
    assignee: "alice",
    title: "Parent issue",
  },
  {
    id: "child-a",
    parent_id: "parent",
    priority: "high",
    sort_order: 2,
    status: "pending",
    tags: ["frontend"],
    assignee: "alice",
    assignee_user_id: 1,
    assignee_name: "alice",
    title: "Searchable child",
  },
  {
    id: "child-b",
    parent_id: "parent",
    priority: "low",
    sort_order: 1,
    status: "completed",
    tags: [],
    assignee: "bob",
    assignee_user_id: 2,
    assignee_name: "bob",
    title: "Other child",
  },
];

const extensions: StandardCloudBoardHostExtensions<Item> = {
  getSearchText: (item) => `${item.title} ${item.assignee}`,
};

function column(groupValue: string): ProjectBoardColumn {
  return {
    dotClass: "bg-zinc-400",
    groupValue,
    key: groupValue,
    label: groupValue,
    status: groupValue,
  };
}

describe("standard cloud board controller", () => {
  it("builds a cycle-safe parent breadcrumb", () => {
    expect(
      buildStandardCloudBoardBreadcrumb(items, "child-a").map(
        (item) => item.id,
      ),
    ).toEqual(["parent", "child-a"]);
  });

  it("owns standard parent, group, search and sort filtering", () => {
    expect(
      filterStandardCloudBoardItems({
        column: column("pending"),
        currentParentId: "parent",
        extensions,
        items,
        state: {
          groupBy: "status",
          groupFilter: "",
          query: "searchable",
        },
      }).map((item) => item.id),
    ).toEqual(["child-a"]);
  });

  it("resolves both card and column drops with shared assignee semantics", () => {
    expect(
      resolveStandardCloudBoardDrop({
        activeItemId: "child-a",
        beforeItemId: "child-b",
        columnDropKey: null,
        columns: [column("1"), column("2")],
        extensions,
        groupBy: "assignee",
        items,
      }),
    ).toEqual({
      beforeItemId: "child-b",
      column: column("2"),
      itemId: "child-a",
    });
    expect(
      resolveStandardCloudBoardDrop({
        activeItemId: "child-a",
        beforeItemId: null,
        columnDropKey: "pending",
        columns: [column("pending")],
        extensions,
        groupBy: "status",
        items,
      }),
    ).toEqual({
      beforeItemId: null,
      column: column("pending"),
      itemId: "child-a",
    });
  });

  it("owns status, priority, assignee and tag column modeling", () => {
    const columnOptions = {
      assignees: [
        { id: "7", name: "Ada", type: "user" as const },
        { id: "bot-1", name: "Codex", type: "agent" as const },
      ],
      items: [
        {
          ...items[0],
          assignee_user_id: 7,
          assignee_name: "Ada",
          tags: ["frontend"],
        },
      ],
      labels: {
        noPriority: "Normal",
        noTag: "No tag",
        priority: {
          low: "Low",
          medium: "Medium",
          high: "High",
          urgent: "Urgent",
        },
        unassigned: "Unassigned",
      },
      statuses: [{ id: "pending", name: "Pending", color: "blue" }],
      tags: ["backend"],
    };

    expect(
      createStandardCloudBoardColumns({
        ...columnOptions,
        groupBy: "status",
      }).map(({ groupValue, label }) => [groupValue, label]),
    ).toEqual([["pending", "Pending"]]);
    expect(
      createStandardCloudBoardColumns({
        ...columnOptions,
        groupBy: "priority",
      }).map(({ groupValue, label }) => [groupValue, label]),
    ).toEqual([
      ["none", "Normal"],
      ["low", "Low"],
      ["medium", "Medium"],
      ["high", "High"],
      ["urgent", "Urgent"],
    ]);
    expect(
      createStandardCloudBoardColumns({
        ...columnOptions,
        groupBy: "assignee",
      }).map(({ groupValue, label }) => [groupValue, label]),
    ).toEqual([
      ["7", "Ada"],
      ["agent:bot-1", "Codex"],
      ["", "Unassigned"],
    ]);
    expect(
      createStandardCloudBoardColumns({
        ...columnOptions,
        groupBy: "tag",
      }).map(({ groupValue, label }) => [groupValue, label]),
    ).toEqual([
      ["backend", "backend"],
      ["frontend", "frontend"],
      ["", "No tag"],
    ]);
  });

  it("resolves every standard drop into one shared field mutation", () => {
    const item = {
      ...items[0],
      assignee_user_id: 1,
      assignee_name: "Alice",
    };
    const boardItems = [item, items[2]];

    expect(
      resolveStandardCloudBoardMutation({
        beforeItemId: null,
        column: column("completed"),
        groupBy: "status",
        item,
        items: boardItems,
      }),
    ).toMatchObject({
      kind: "status",
      laneIds: ["parent"],
      status: "completed",
    });
    const priorityMutation = resolveStandardCloudBoardMutation({
      beforeItemId: null,
      column: column("urgent"),
      groupBy: "priority",
      item,
      items: boardItems,
    });
    expect(priorityMutation).toMatchObject({
      kind: "priority",
      priority: "urgent",
    });
    expect(
      priorityMutation?.optimisticItems.find(
        (candidate) => candidate.id === item.id,
      ),
    ).toMatchObject({ priority: "urgent" });
    const assigneeMutation = resolveStandardCloudBoardMutation({
      beforeItemId: null,
      column: column("agent:bot-1"),
      groupBy: "assignee",
      item,
      items: boardItems,
    });
    expect(assigneeMutation).toMatchObject({
      kind: "assignee",
      assigneeId: "bot-1",
      assigneeType: "agent",
    });
    expect(
      assigneeMutation?.optimisticItems.find(
        (candidate) => candidate.id === item.id,
      ),
    ).toMatchObject({
      assignee_user_id: null,
      assignee_agent_id: "bot-1",
    });
    const tagMutation = resolveStandardCloudBoardMutation({
      beforeItemId: null,
      column: column("backend"),
      groupBy: "tag",
      item,
      items: boardItems,
    });
    expect(tagMutation).toMatchObject({
      kind: "tag",
      tags: ["backend"],
    });
    expect(
      tagMutation?.optimisticItems.find(
        (candidate) => candidate.id === item.id,
      ),
    ).toMatchObject({ tags: ["backend"] });
  });

  it("owns standard mutation API command selection and ordering", async () => {
    const item = { ...items[0], version: 3 };
    const updated = {
      ...item,
      status: "completed",
      version: 4,
      workflow: { nodes: [{ id: "implement", status: "ready" }] },
    };
    const calls: string[] = [];
    const update = vi.fn(async (_item, input) => {
      calls.push(`update:${JSON.stringify(input)}`);
      return updated;
    });
    const assign = vi.fn(async () => {
      calls.push("assign");
      return updated;
    });
    const reorder = vi.fn(async (_item, input) => {
      calls.push(`reorder:${input.status}:${input.laneIds.join(",")}`);
    });
    const statusMutation = resolveStandardCloudBoardMutation({
      beforeItemId: null,
      column: column("completed"),
      groupBy: "status",
      item,
      items: [item],
    });

    expect(statusMutation).not.toBeNull();
    await executeStandardCloudBoardMutation({
      additionalUpdate: { automation_rule_id: "rule-1" },
      commands: { assign, reorder, update },
      item,
      mutation: statusMutation!,
    });

    expect(calls).toEqual([
      'update:{"automation_rule_id":"rule-1","status":"completed"}',
      "reorder:completed:parent",
    ]);
    expect(reorder).toHaveBeenCalledWith(updated, {
      laneIds: ["parent"],
      optimisticItems: [
        expect.objectContaining({
          id: item.id,
          sort_order: 0,
          status: "completed",
          version: 4,
          workflow: updated.workflow,
        }),
      ],
      status: "completed",
    });
    expect(assign).not.toHaveBeenCalled();

    const assigneeMutation = resolveStandardCloudBoardMutation({
      beforeItemId: null,
      column: column("agent:bot-1"),
      groupBy: "assignee",
      item,
      items: [item],
    });
    await executeStandardCloudBoardMutation({
      commands: { assign, reorder, update },
      item,
      mutation: assigneeMutation!,
      notifyAssignee: false,
    });
    expect(assign).toHaveBeenCalledWith(item, {
      assigneeId: "bot-1",
      assigneeType: "agent",
      notifyAssignee: false,
    });
    expect(reorder).toHaveBeenCalledTimes(1);
  });

  it("uses the shared update command for priority, tag and unassignment", async () => {
    const item = { ...items[0] };
    const update = vi.fn(async (_item, input) => ({ ...item, ...input }));
    const commands = { update };

    for (const [groupBy, groupValue] of [
      ["priority", "urgent"],
      ["tag", "backend"],
      ["assignee", ""],
    ] as const) {
      const mutation = resolveStandardCloudBoardMutation({
        beforeItemId: null,
        column: column(groupValue),
        groupBy,
        item,
        items: [item],
      });
      await executeStandardCloudBoardMutation({
        commands,
        item,
        mutation: mutation!,
      });
    }

    expect(update.mock.calls.map(([, input]) => input)).toEqual([
      { priority: "urgent" },
      { tags: ["backend"] },
      {
        assignee_user_id: null,
        assignee_agent_id: null,
        assignee_team_id: null,
      },
    ]);
  });
});
