// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  createWorkspaceHomeSnapshot,
  isWorkspaceTimestampWithinLastWeek,
  workspaceProjectKey,
  workspaceProjectMatchesQuery,
  type WorkspaceHomeItem,
  type WorkspaceHomeMyWorkItem,
  type WorkspaceHomeProject,
} from "./model";

const nowMs = Date.parse("2026-09-10T12:00:00.000Z");

const projects: WorkspaceHomeProject[] = [
  {
    id: "older",
    project_key: "OLD",
    name: "Older project",
    description: "",
    project_store: "backend",
    location: "cloud",
    updated_at: "2026-09-08T12:00:00.000Z",
  },
  {
    id: "newer",
    project_key: "NEW",
    name: "Newer project",
    description: "",
    project_store: "local",
    location: "local",
    updated_at: "2026-09-09T12:00:00.000Z",
  },
];

function item(
  id: string,
  overrides: Partial<WorkspaceHomeItem> = {},
): WorkspaceHomeItem {
  return {
    id,
    title: id,
    status: "pending",
    assignee_user_id: null,
    created_by_user_id: 1,
    created_at: "2026-09-09T12:00:00.000Z",
    updated_at: "2026-09-09T12:00:00.000Z",
    completed_at: null,
    ...overrides,
  };
}

describe("workspace home model", () => {
  it("computes cross-project statistics, activity, todos, and project ordering", () => {
    const completed = item("completed", {
      status: "completed",
      updated_at: "2026-09-10T11:00:00.000Z",
      completed_at: "2026-09-10T10:00:00.000Z",
    });
    const inProgress = item("in-progress", {
      status: "in_progress",
      created_at: "2026-08-01T12:00:00.000Z",
    });
    const myWork: WorkspaceHomeMyWorkItem[] = [
      { ...completed, project_key: "OLD" },
      { ...inProgress, project_key: "NEW" },
    ];

    const snapshot = createWorkspaceHomeSnapshot({
      projects,
      projectItems: {
        [workspaceProjectKey(projects[0])]: [inProgress],
        [workspaceProjectKey(projects[1])]: [completed],
      },
      myWork,
      searchQuery: "",
      nowMs,
    });

    expect(snapshot.stats).toEqual({
      projectCount: 2,
      itemCount: 2,
      completedCount: 1,
      weeklyNewCount: 1,
      weeklyCompletedCount: 1,
      inProgressCount: 1,
    });
    expect(snapshot.recentActivity.map((entry) => entry.item.id)).toEqual([
      "completed",
      "in-progress",
    ]);
    expect(snapshot.myTodos.map((workItem) => workItem.id)).toEqual([
      "in-progress",
    ]);
    expect(snapshot.sortedProjects.map((project) => project.id)).toEqual([
      "newer",
      "older",
    ]);
  });

  it("normalizes project search and rejects missing or invalid weekly timestamps", () => {
    expect(workspaceProjectMatchesQuery(projects[1], "  NEWER ")).toBe(true);
    expect(workspaceProjectMatchesQuery(projects[1], "older")).toBe(false);
    expect(isWorkspaceTimestampWithinLastWeek(null, nowMs)).toBe(false);
    expect(isWorkspaceTimestampWithinLastWeek("invalid", nowMs)).toBe(false);
  });
});
