// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { CollaborationIssue } from "../types";
import {
  calendarIssueSegments,
  calendarDays,
  filterAndSortScheduleIssues,
  ganttIssueRange,
  issuesByDueDate,
  localDateKey,
  parseScheduleDate,
  scheduleDateDropId,
  scheduleDragSource,
  scheduleDrop,
  scheduleIssueDragId,
  scheduleRangeDateKeys,
  scheduleRangeUpdate,
  scheduleViewConfigFromOptions,
  scheduleViewOptionsFromConfig,
} from "./model";

function issue(
  id: string,
  dueAt: string | null,
  startAt: string | null = "2026-10-01T08:00:00Z",
): CollaborationIssue {
  return {
    id,
    cloud_project_id: "project-1",
    sequence_number: Number(id),
    parent_id: null,
    created_by_user_id: 1,
    assignee_user_id: null,
    title: `Issue ${id}`,
    description: "",
    status: "pending",
    priority: "none",
    start_at: startAt,
    due_at: dueAt,
    tags: [],
    sort_order: 0,
    version: 1,
    created_at: "2026-09-01T08:00:00Z",
    updated_at: "2026-10-01T08:00:00Z",
    completed_at: null,
  };
}

describe("project schedule model", () => {
  it("builds a stable 6-week Monday-first calendar", () => {
    const days = calendarDays(new Date(2026, 9, 1), true);

    expect(days).toHaveLength(42);
    expect(localDateKey(days[0])).toBe("2026-09-28");
    expect(localDateKey(days[41])).toBe("2026-11-08");
  });

  it("parses date-only values in local time without a UTC day shift", () => {
    expect(localDateKey(parseScheduleDate("2026-10-10")!)).toBe("2026-10-10");
  });

  it("groups only issues that have valid due dates", () => {
    const grouped = issuesByDueDate([
      issue("1", "2026-10-10T09:00:00+08:00"),
      issue("2", null),
      issue("3", "invalid"),
    ]);

    expect([...grouped.keys()]).toEqual(["2026-10-10"]);
    expect(grouped.get("2026-10-10")?.map((item) => item.id)).toEqual(["1"]);
  });

  it("uses the explicit start-to-due interval and normalizes inverted data", () => {
    const range = ganttIssueRange(
      issue("1", "2026-10-05", "2026-10-12T00:00:00Z"),
    );

    expect(localDateKey(range!.start)).toBe("2026-10-05");
    expect(localDateKey(range!.end)).toBe("2026-10-12");
  });

  it("treats a single configured boundary as a one-day scheduled task", () => {
    const dueOnly = ganttIssueRange(issue("1", "2026-10-18", null));
    const startOnly = ganttIssueRange(issue("2", null, "2026-10-20"));

    expect(localDateKey(dueOnly!.start)).toBe("2026-10-18");
    expect(localDateKey(dueOnly!.end)).toBe("2026-10-18");
    expect(localDateKey(startOnly!.start)).toBe("2026-10-20");
    expect(localDateKey(startOnly!.end)).toBe("2026-10-20");
  });

  it("resolves an undated issue drag onto a calendar or Gantt date", () => {
    expect(
      scheduleDragSource(scheduleIssueDragId("issue-1", "move", "week-1")),
    ).toEqual({ issueId: "issue-1", mode: "move" });
    expect(
      scheduleDrop(
        scheduleIssueDragId("issue-1"),
        scheduleDateDropId("2026-10-18", "gantt-row-issue-2"),
      ),
    ).toEqual({
      issueId: "issue-1",
      date: "2026-10-18",
      mode: "move",
    });
    expect(scheduleDrop("issue-1", "2026-10-18")).toBeNull();
  });

  it("expands a preview range into every occupied calendar date", () => {
    expect(
      scheduleRangeDateKeys({
        startAt: "2026-10-30",
        dueAt: "2026-11-02",
      }),
    ).toEqual(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
  });

  it("moves and resizes a scheduled interval", () => {
    const scheduled = issue("1", "2026-10-14", "2026-10-10");
    scheduled.start_at = "2026-10-11";

    expect(scheduleRangeUpdate(scheduled, "move", "2026-10-20")).toEqual({
      startAt: "2026-10-20",
      dueAt: "2026-10-23",
    });
    expect(scheduleRangeUpdate(scheduled, "start", "2026-10-12")).toEqual({
      startAt: "2026-10-12",
      dueAt: "2026-10-14",
    });
    expect(scheduleRangeUpdate(scheduled, "end", "2026-10-16")).toEqual({
      startAt: "2026-10-11",
      dueAt: "2026-10-16",
    });
  });

  it("splits calendar ranges into week columns and separate overlap lanes", () => {
    const rowDays = Array.from(
      { length: 7 },
      (_, index) => new Date(2026, 9, 12 + index),
    );
    const segments = calendarIssueSegments(
      [
        issue("1", "2026-10-16", "2026-10-12"),
        issue("2", "2026-10-14", "2026-10-13"),
        issue("3", "2026-10-20", "2026-10-17"),
      ],
      rowDays,
    );

    expect(segments).toEqual([
      expect.objectContaining({
        issue: expect.objectContaining({ id: "1" }),
        startColumn: 0,
        endColumn: 4,
        lane: 0,
        continuesBefore: false,
        continuesAfter: false,
      }),
      expect.objectContaining({
        issue: expect.objectContaining({ id: "2" }),
        startColumn: 1,
        endColumn: 2,
        lane: 1,
      }),
      expect.objectContaining({
        issue: expect.objectContaining({ id: "3" }),
        startColumn: 5,
        endColumn: 6,
        lane: 0,
        continuesAfter: true,
      }),
    ]);
  });

  it("filters, groups, and sorts scheduled issues", () => {
    const low = issue("1", "2026-10-20", "2026-10-10");
    low.priority = "low";
    low.tags = ["frontend"];
    low.assignee_user_id = 8;
    const urgent = issue("2", "2026-10-18", "2026-10-12");
    urgent.priority = "urgent";
    urgent.tags = ["frontend"];
    urgent.assignee_user_id = 8;
    const other = issue("3", "2026-10-16", "2026-10-11");
    other.priority = "high";
    other.tags = ["backend"];
    other.assignee_user_id = 9;

    expect(
      filterAndSortScheduleIssues([low, urgent, other], {
        status: "pending",
        assignee: "user:8",
        tag: "frontend",
        groupBy: "priority",
        sortBy: "priority_desc",
      }).map((item) => item.id),
    ).toEqual(["2", "1"]);
  });

  it("maps persisted schedule view configuration without losing filters", () => {
    const options = {
      status: "pending",
      assignee: "user:8",
      tag: "frontend",
      groupBy: "assignee" as const,
      sortBy: "updated_desc" as const,
    };

    expect(
      scheduleViewOptionsFromConfig(scheduleViewConfigFromOptions(options)),
    ).toEqual(options);
  });
});
