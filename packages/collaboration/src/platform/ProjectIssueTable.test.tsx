// @vitest-environment jsdom

// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CollaborationAssignment, CollaborationIssue } from "../types";
import { ProjectIssueTable } from "./ProjectIssueTable";
import { visibleIssueAssignments } from "./model";

const issue = {
  id: "issue-1",
  cloud_project_id: "project-1",
  sequence_number: 1,
  parent_id: null,
  created_by_user_id: 1,
  assignee_user_id: 7,
  assignee_name: "旧负责人",
  title: "Keyboard accessible issue",
  description: "",
  status: "inbox",
  priority: "none",
  due_at: null,
  tags: [],
  sort_order: 0,
  version: 1,
  created_at: "2026-09-11T00:00:00Z",
  updated_at: "2026-09-11T00:00:00Z",
  completed_at: null,
} satisfies CollaborationIssue;

const assignment = {
  id: "assignment-1",
  issue_id: issue.id,
  target_type: "agent",
  target_id: "agent-1",
  target_name: "真实智能体",
  workflow_step: null,
  comment_id: null,
  created_by_user_id: 1,
  created_by_user_name: "李明",
  status: "active",
  created_at: "2026-09-11T00:00:00Z",
  updated_at: "2026-09-11T00:00:00Z",
} satisfies CollaborationAssignment;

describe("ProjectIssueTable", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(
    assignmentsByIssueId: Record<string, CollaborationAssignment[]>,
    onOpen = vi.fn(),
  ) {
    act(() => {
      root.render(
        <ProjectIssueTable
          issues={[issue]}
          assignmentsByIssueId={assignmentsByIssueId}
          emptyLabel="Empty"
          issueLabel="Issue"
          statusLabel="Status"
          assignmentsLabel="Assignments"
          updatedLabel="Updated"
          onOpen={onOpen}
        />,
      );
    });
    return onOpen;
  }

  it.each(["Enter", " "])("opens the focused issue with %j", (key) => {
    const onOpen = render({ [issue.id]: [assignment] });
    const row = container.querySelector("tbody tr") as HTMLTableRowElement;
    row.focus();
    expect(document.activeElement).toBe(row);

    act(() => {
      row.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    });

    expect(onOpen).toHaveBeenCalledWith(issue);
  });

  it("shows real assignment target names and preserves an authoritative empty list", () => {
    render({ [issue.id]: [assignment] });
    expect(container.textContent).toContain("真实智能体");
    expect(container.textContent).not.toContain("旧负责人");

    render({ [issue.id]: [] });
    expect(container.textContent).toContain("—");
    expect(container.textContent).not.toContain("旧负责人");
    expect(visibleIssueAssignments(issue, [])).toEqual([]);
    expect(visibleIssueAssignments(issue, undefined)).toHaveLength(1);
  });
});
