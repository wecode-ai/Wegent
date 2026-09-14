// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { CollaborationIssue, CollaborationProject } from "../types";
import {
  createWorkspaceOperationsSnapshot,
  workspaceIssueOperationState,
} from "./workspaceOperations";

const project = {
  id: "project-1",
  project_key: "OPS",
  name: "Operations",
  updated_at: "2026-09-14T01:00:00Z",
} as CollaborationProject;

function issue(
  overrides: Partial<CollaborationIssue> = {},
): CollaborationIssue {
  return {
    id: "issue-1",
    cloud_project_id: project.id,
    sequence_number: 1,
    parent_id: null,
    created_by_user_id: 1,
    assignee_user_id: null,
    title: "Issue",
    description: "",
    status: "pending",
    priority: "none",
    due_at: null,
    tags: [],
    sort_order: 0,
    version: 1,
    created_at: "2026-09-14T01:00:00Z",
    updated_at: "2026-09-14T01:00:00Z",
    completed_at: null,
    ...overrides,
  };
}

describe("workspace operations", () => {
  it("prioritizes failures and review gates over generic running states", () => {
    expect(
      workspaceIssueOperationState(
        issue({ status: "in_progress", execution_state: "failed" }),
      ),
    ).toBe("failed");
    expect(
      workspaceIssueOperationState(
        issue({
          status: "in_progress",
          execution_state: "waiting_approval",
        }),
      ),
    ).toBe("review");
  });

  it("summarizes current operating state across projects", () => {
    const snapshot = createWorkspaceOperationsSnapshot({
      projects: [project],
      projectIssues: {
        [project.id]: {
          status: "available",
          issues: [
            issue({ id: "running", status: "in_progress" }),
            issue({ id: "review", status: "in_review" }),
            issue({ id: "failed", execution_state: "failed" }),
          ],
        },
      },
    });

    expect(snapshot.totals).toMatchObject({
      projects: 1,
      running: 1,
      review: 1,
      failed: 1,
    });
    expect(snapshot.attentionItems.map(({ issue }) => issue.id)).toEqual([
      "failed",
      "review",
    ]);
  });

  it("keeps an unavailable project distinct from an empty project", () => {
    const unavailable = createWorkspaceOperationsSnapshot({
      projects: [project],
      projectIssues: {
        [project.id]: { status: "unavailable" },
      },
    });
    const empty = createWorkspaceOperationsSnapshot({
      projects: [project],
      projectIssues: {
        [project.id]: { status: "available", issues: [] },
      },
    });

    expect(unavailable.operations[0]).toMatchObject({
      unavailable: true,
      issues: [],
    });
    expect(unavailable.totals.unavailable).toBe(1);
    expect(empty.operations[0]?.unavailable).toBe(false);
    expect(empty.totals.unavailable).toBe(0);
  });
});
