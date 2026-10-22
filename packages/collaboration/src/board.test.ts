// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { groupBoardIssues } from "./board";
import type { CollaborationIssue, CollaborationProject } from "./types";

function issue(
  id: string,
  status: string,
  overrides: Partial<CollaborationIssue> = {},
): CollaborationIssue {
  return {
    id,
    cloud_project_id: "project-1",
    sequence_number: Number(id.replace(/\D/g, "")) || 1,
    parent_id: null,
    created_by_user_id: 1,
    assignee_user_id: null,
    title: id,
    description: "",
    status,
    priority: "none",
    due_at: null,
    tags: [],
    sort_order: 0,
    version: 1,
    created_at: "",
    updated_at: "",
    completed_at: null,
    ...overrides,
  };
}

const project = {
  project_key: "COL",
  board_config: {
    group_by: "status",
    processing_start_status_id: "doing",
    statuses: [
      { id: "todo", name: "Todo", color: "gray" },
      { id: "doing", name: "Doing", color: "blue" },
    ],
  },
} as CollaborationProject;

describe("groupBoardIssues", () => {
  it("uses the persisted project grouping", () => {
    const grouped = groupBoardIssues(
      {
        ...project,
        board_config: { ...project.board_config!, group_by: "assignee" },
      },
      [
        issue("1", "todo", { assignee_name: "Ada" }),
        issue("2", "doing", { assignee_name: "Ada" }),
        issue("3", "doing"),
      ],
      project.board_config!.statuses,
      "Unassigned",
      "No tag",
    );

    expect(grouped.map((group) => [group.label, group.issues.length])).toEqual([
      ["Ada", 2],
      ["Unassigned", 1],
    ]);
  });
});
