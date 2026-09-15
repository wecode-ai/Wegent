// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  buildMyWorkCalendarEntries,
  compareMyWorkItems,
  groupMyWorkTimeline,
  isMyWorkItemInGroup,
  listMyWorkProjects,
  myWorkGroupOf,
  type MyWorkItem,
} from "./model";

const activeStates = new Set(["queued", "running", "waiting_approval"]);
const isExecutionStateActive = (state: string | null | undefined) =>
  state != null && activeStates.has(state);

function item(overrides: Partial<MyWorkItem> = {}): MyWorkItem {
  return {
    id: "WEG-1",
    title: "Task",
    status: "pending",
    priority: "none",
    due_at: null,
    project_key: "WEG",
    project_name: "Wegent",
    has_active_task: false,
    ...overrides,
  };
}

describe("my-work model", () => {
  it("preserves grouped-view overlap while assigning one primary group", () => {
    const review = item({ status: "in_review" });
    expect(isMyWorkItemInGroup(review, "action", isExecutionStateActive)).toBe(
      true,
    );
    expect(isMyWorkItemInGroup(review, "review", isExecutionStateActive)).toBe(
      true,
    );
    expect(myWorkGroupOf(review, isExecutionStateActive)).toBe("review");

    const approval = item({
      execution_state: "waiting_approval",
      can_approve: true,
    });
    expect(
      isMyWorkItemInGroup(approval, "approval", isExecutionStateActive),
    ).toBe(true);
    expect(
      isMyWorkItemInGroup(approval, "action", isExecutionStateActive),
    ).toBe(false);
    expect(myWorkGroupOf(approval, isExecutionStateActive)).toBe("approval");
  });

  it("uses execution state when present and the runtime binding only when absent", () => {
    expect(
      myWorkGroupOf(
        item({
          status: "in_progress",
          has_active_task: true,
          execution_state: "completed",
        }),
        isExecutionStateActive,
      ),
    ).toBe("running");
    expect(
      myWorkGroupOf(
        item({
          status: "pending",
          has_active_task: true,
          execution_state: "completed",
        }),
        isExecutionStateActive,
      ),
    ).toBe("action");
    expect(
      myWorkGroupOf(
        item({ status: "in_progress", has_active_task: true }),
        isExecutionStateActive,
      ),
    ).toBe("running");
  });

  it("sorts due items before undated items and then by priority", () => {
    const items = [
      item({ id: "low", priority: "low" }),
      item({ id: "urgent", priority: "urgent" }),
      item({ id: "dated", due_at: "2026-09-10T12:00:00Z" }),
    ];
    expect(
      [...items].sort(compareMyWorkItems).map((entry) => entry.id),
    ).toEqual(["dated", "urgent", "low"]);
  });

  it("groups timelines, projects, and valid calendar entries deterministically", () => {
    const items = [
      item({
        id: "B-1",
        project_key: "B",
        project_name: "Beta",
        due_at: "2026-09-11T12:00:00Z",
      }),
      item({
        id: "A-1",
        project_key: "A",
        project_name: "Alpha",
        due_at: "invalid",
      }),
      item({ id: "A-2", project_key: "A", project_name: "Alpha" }),
    ];

    expect(listMyWorkProjects(items)).toEqual([
      ["A", "Alpha"],
      ["B", "Beta"],
    ]);
    expect(
      groupMyWorkTimeline(items).map((bucket) =>
        bucket.entries.map((entry) => entry.id),
      ),
    ).toEqual([["B-1"], ["A-1", "A-2"]]);
    expect(
      buildMyWorkCalendarEntries(items, isExecutionStateActive).map(
        (entry) => entry.id,
      ),
    ).toEqual(["B-1"]);
  });
});
