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
  can_edit: true,
} satisfies CollaborationIssue;

const assignment = {
  id: "assignment-1",
  issue_id: issue.id,
  target_type: "agent",
  target_id: "agent-1",
  target_name: "真实智能体",
  workflow_step: null,
  body: "",
  comment_id: null,
  created_by_user_id: 1,
  created_by_user_name: "李明",
  status: "active",
  created_at: "2026-09-11T00:00:00Z",
  updated_at: "2026-09-11T00:00:00Z",
} satisfies CollaborationAssignment;
const secondIssue = {
  ...issue,
  id: "issue-2",
  sequence_number: 2,
  title: "Second issue",
  status: "in_progress",
  tags: ["backend"],
} satisfies CollaborationIssue;
const secondAssignment = {
  ...assignment,
  id: "assignment-2",
  issue_id: secondIssue.id,
  target_type: "human",
  target_id: "8",
  target_name: "王芳",
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
    issues: CollaborationIssue[] = [issue],
    projectKey?: string,
  ) {
    act(() => {
      root.render(
        <ProjectIssueTable
          issues={issues}
          assignmentsByIssueId={assignmentsByIssueId}
          emptyLabel="Empty"
          issueLabel="Issue"
          statusLabel="Status"
          assignmentsLabel="Assignments"
          updatedLabel="Updated"
          projectKey={projectKey}
          onOpen={onOpen}
        />,
      );
    });
    return onOpen;
  }

  it("opens an issue through a native keyboard-accessible button", () => {
    const onOpen = render({ [issue.id]: [assignment] });
    const trigger = container.querySelector(
      "tbody tr button",
    ) as HTMLButtonElement;
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger.title).toBe(issue.title);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    act(() => {
      trigger.click();
    });

    expect(onOpen).toHaveBeenCalledWith(issue);
  });

  it("uses stable business-column widths instead of compressing filter headers", () => {
    render({ [issue.id]: [assignment] }, vi.fn(), [issue], "PROJ");

    expect(
      container.querySelector("col.collaboration-issue-table-col-status"),
    ).not.toBeNull();
    expect(
      container.querySelector("col.collaboration-issue-table-col-assignee"),
    ).not.toBeNull();
    expect(
      container.querySelector("col.collaboration-issue-table-col-tags"),
    ).not.toBeNull();
    expect(
      container.querySelector("col.collaboration-issue-table-col-start"),
    ).not.toBeNull();
    expect(
      container.querySelector("col.collaboration-issue-table-col-due"),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="collaboration-issue-table-sort-status"] span',
      )?.textContent,
    ).toBe("Status");
    expect(
      container.querySelector(
        '[data-testid="collaboration-issue-table-status-filter"]',
      ),
    ).not.toBeNull();
    expect(container.textContent).toContain("Start");
    expect(container.textContent).toContain("End");
    expect(container.querySelector(".collaboration-issue-key")).toBeNull();
    expect(container.textContent).not.toContain("PROJ-1");
  });

  it("shows real assignment target names and preserves an authoritative empty list", () => {
    render({ [issue.id]: [assignment] });
    expect(container.textContent).toContain("真实智能体");
    expect(container.textContent).not.toContain("旧负责人");

    render({ [issue.id]: [] });
    expect(container.textContent).toContain("—");
    expect(container.textContent).not.toContain("Issue 内分配");
    expect(container.textContent).not.toContain("旧负责人");
    expect(visibleIssueAssignments(issue, [])).toEqual([]);
    expect(visibleIssueAssignments(issue, undefined)).toEqual([]);
  });

  it("filters the Issue table by status, assignee, and tag", () => {
    render(
      {
        [issue.id]: [assignment],
        [secondIssue.id]: [secondAssignment],
      },
      vi.fn(),
      [issue, secondIssue],
    );

    const rows = () =>
      container.querySelectorAll(
        '[data-testid^="collaboration-issue-table-row-"]',
      );
    const change = (testId: string, value: string) => {
      const select = container.querySelector(
        `[data-testid="${testId}"]`,
      ) as HTMLSelectElement;
      act(() => {
        select.value = value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
    };

    change("collaboration-issue-table-status-filter", "in_progress");
    expect(rows()).toHaveLength(1);
    expect(container.textContent).toContain(secondIssue.title);

    change("collaboration-issue-table-status-filter", "");
    change("collaboration-issue-table-assignee-filter", "agent:agent-1");
    expect(rows()).toHaveLength(1);
    expect(container.textContent).toContain(issue.title);

    change("collaboration-issue-table-assignee-filter", "");
    change("collaboration-issue-table-tag-filter", "backend");
    expect(rows()).toHaveLength(1);
    expect(container.textContent).toContain(secondIssue.title);
  });

  it("sorts filtered issues by sortable table columns", () => {
    const datedIssue = {
      ...issue,
      start_at: "2026-10-12T00:00:00Z",
      due_at: "2026-10-14T00:00:00Z",
    } satisfies CollaborationIssue;
    const undatedSecondIssue = {
      ...secondIssue,
      start_at: null,
      due_at: null,
    } satisfies CollaborationIssue;
    render(
      {
        [datedIssue.id]: [assignment],
        [undatedSecondIssue.id]: [secondAssignment],
      },
      vi.fn(),
      [undatedSecondIssue, datedIssue],
    );

    const visibleTitles = () =>
      [...container.querySelectorAll(".collaboration-issue-title")].map(
        (node) => node.textContent,
      );
    const titleHeader = container
      .querySelector('[data-testid="collaboration-issue-table-sort-title"]')
      ?.closest("th");
    const titleSort = container.querySelector(
      '[data-testid="collaboration-issue-table-sort-title"]',
    ) as HTMLButtonElement;

    act(() => titleSort.click());
    expect(visibleTitles()).toEqual([
      datedIssue.title,
      undatedSecondIssue.title,
    ]);
    expect(titleHeader?.getAttribute("aria-sort")).toBe("ascending");

    act(() => titleSort.click());
    expect(visibleTitles()).toEqual([
      undatedSecondIssue.title,
      datedIssue.title,
    ]);
    expect(titleHeader?.getAttribute("aria-sort")).toBe("descending");

    const startSort = container.querySelector(
      '[data-testid="collaboration-issue-table-sort-start_at"]',
    ) as HTMLButtonElement;
    act(() => startSort.click());
    expect(visibleTitles()).toEqual([
      datedIssue.title,
      undatedSecondIssue.title,
    ]);
  });

  it("clears unavailable filters when the project issue set changes", () => {
    render(
      {
        [issue.id]: [assignment],
        [secondIssue.id]: [secondAssignment],
      },
      vi.fn(),
      [issue, secondIssue],
      "PROJ",
    );
    const status = container.querySelector(
      '[data-testid="collaboration-issue-table-status-filter"]',
    ) as HTMLSelectElement;
    act(() => {
      status.value = "in_progress";
      status.dispatchEvent(new Event("change", { bubbles: true }));
    });

    render({ [issue.id]: [assignment] }, vi.fn(), [issue], "PROJ");

    expect(status.value).toBe("");
    expect(
      container.querySelectorAll(
        '[data-testid^="collaboration-issue-table-row-"]',
      ),
    ).toHaveLength(1);
  });

  it("exposes the execution failure reason next to the execution state", () => {
    const failedIssue = {
      ...issue,
      execution_state: "failed",
      execution_error:
        "worktree_persistent_storage_unverified: Persistent Worktree storage is not verified",
    } satisfies CollaborationIssue;
    act(() => {
      root.render(
        <ProjectIssueTable
          issues={[failedIssue]}
          assignmentsByIssueId={{ [failedIssue.id]: [assignment] }}
          emptyLabel="Empty"
          issueLabel="Issue"
          statusLabel="Status"
          assignmentsLabel="Assignments"
          executionLabel="Execution"
          updatedLabel="Updated"
          onOpen={vi.fn()}
        />,
      );
    });

    const cell = container.querySelector(
      `[data-testid="collaboration-issue-table-execution-${failedIssue.id}"]`,
    ) as HTMLTableCellElement;
    expect(cell.textContent).toBe("failed");
    expect(cell.title).toBe(failedIssue.execution_error);
  });

  it("selects visible issues and applies a batch status update", async () => {
    const onBulkStatusChange = vi.fn().mockResolvedValue(undefined);
    act(() => {
      root.render(
        <ProjectIssueTable
          issues={[issue, secondIssue]}
          assignmentsByIssueId={{
            [issue.id]: [assignment],
            [secondIssue.id]: [secondAssignment],
          }}
          emptyLabel="Empty"
          issueLabel="Issue"
          statusLabel="Status"
          assignmentsLabel="Assignments"
          updatedLabel="Updated"
          availableStatuses={["inbox", "in_progress"]}
          onBulkStatusChange={onBulkStatusChange}
          onOpen={vi.fn()}
        />,
      );
    });

    const selectAll = container.querySelector(
      '[data-testid="collaboration-issue-table-select-all"]',
    ) as HTMLInputElement;
    act(() => {
      selectAll.click();
    });
    expect(
      container.querySelector(
        '[data-testid="collaboration-issue-table-batch"]',
      ),
    ).not.toBeNull();

    const batchStatus = container.querySelector(
      '[data-testid="collaboration-issue-table-batch-status"]',
    ) as HTMLSelectElement;
    act(() => {
      batchStatus.value = "in_progress";
      batchStatus.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const apply = container.querySelector(
      '[data-testid="collaboration-issue-table-batch-apply"]',
    ) as HTMLButtonElement;
    await act(async () => {
      apply.click();
    });

    expect(onBulkStatusChange).toHaveBeenCalledWith(
      [issue, secondIssue],
      "in_progress",
    );
    expect(
      container.querySelector(
        '[data-testid="collaboration-issue-table-batch"]',
      ),
    ).toBeNull();
  });

  it("limits batch actions to selected issues that remain visible", async () => {
    const onBulkStatusChange = vi.fn().mockResolvedValue(undefined);
    act(() => {
      root.render(
        <ProjectIssueTable
          issues={[issue, secondIssue]}
          assignmentsByIssueId={{
            [issue.id]: [assignment],
            [secondIssue.id]: [secondAssignment],
          }}
          emptyLabel="Empty"
          issueLabel="Issue"
          statusLabel="Status"
          assignmentsLabel="Assignments"
          updatedLabel="Updated"
          availableStatuses={["inbox", "in_progress"]}
          onBulkStatusChange={onBulkStatusChange}
          onOpen={vi.fn()}
        />,
      );
    });

    act(() => {
      (
        container.querySelector(
          '[data-testid="collaboration-issue-table-select-all"]',
        ) as HTMLInputElement
      ).click();
    });
    act(() => {
      const filter = container.querySelector(
        '[data-testid="collaboration-issue-table-status-filter"]',
      ) as HTMLSelectElement;
      filter.value = "in_progress";
      filter.dispatchEvent(new Event("change", { bubbles: true }));
    });
    act(() => {
      const status = container.querySelector(
        '[data-testid="collaboration-issue-table-batch-status"]',
      ) as HTMLSelectElement;
      status.value = "in_progress";
      status.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      (
        container.querySelector(
          '[data-testid="collaboration-issue-table-batch-apply"]',
        ) as HTMLButtonElement
      ).click();
    });

    expect(onBulkStatusChange).toHaveBeenCalledWith(
      [secondIssue],
      "in_progress",
    );
  });

  it("uses an archive icon and archives all eligible selected issues", () => {
    const completedIssue = {
      ...issue,
      status: "completed",
    } satisfies CollaborationIssue;
    const onDelete = vi.fn();
    const onBulkDelete = vi.fn();
    act(() => {
      root.render(
        <ProjectIssueTable
          issues={[completedIssue, secondIssue]}
          assignmentsByIssueId={{
            [completedIssue.id]: [assignment],
            [secondIssue.id]: [secondAssignment],
          }}
          emptyLabel="Empty"
          issueLabel="Issue"
          statusLabel="Status"
          assignmentsLabel="Assignments"
          updatedLabel="Updated"
          actionsLabel="Actions"
          deleteLabel="Archive issue"
          batchDeleteLabel="Archive selected"
          canDelete={(candidate) => candidate.status === "completed"}
          onDelete={onDelete}
          onBulkDelete={onBulkDelete}
          onOpen={vi.fn()}
        />,
      );
    });

    const archive = container.querySelector(
      `[data-testid="collaboration-issue-table-delete-${completedIssue.id}"]`,
    ) as HTMLButtonElement;
    expect(archive.textContent).toBe("");
    expect(archive.querySelector("svg")).not.toBeNull();
    expect(archive.title).toBe("Archive issue");
    act(() => archive.click());
    expect(onDelete).toHaveBeenCalledWith(completedIssue);

    const selectAll = container.querySelector(
      '[data-testid="collaboration-issue-table-select-all"]',
    ) as HTMLInputElement;
    act(() => selectAll.click());
    const bulkArchive = container.querySelector(
      '[data-testid="collaboration-issue-table-batch-delete"]',
    ) as HTMLButtonElement;
    expect(bulkArchive.disabled).toBe(false);
    act(() => bulkArchive.click());
    expect(onBulkDelete).toHaveBeenCalledWith([completedIssue]);
  });
});
