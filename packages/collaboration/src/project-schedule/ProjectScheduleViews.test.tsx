// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type {
  CollaborationIssue,
  CollaborationProject,
  CollaborationStatus,
} from "../types";
import { defaultScheduleViewOptions, localDateKey } from "./model";
import { ProjectCalendarView, ProjectGanttView } from "./ProjectScheduleViews";

const project = {
  id: "project-1",
  project_key: "PRJ",
} as CollaborationProject;

const statuses: CollaborationStatus[] = [
  { id: "pending", name: "待开始", color: "blue" },
];

function scheduledIssue(): CollaborationIssue {
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  return {
    id: "issue-1",
    cloud_project_id: project.id,
    sequence_number: 1,
    parent_id: null,
    created_by_user_id: 1,
    assignee_user_id: null,
    title: "Scheduled issue",
    description: "",
    status: "pending",
    priority: "none",
    start_at: localDateKey(yesterday),
    due_at: localDateKey(now),
    tags: [],
    sort_order: 0,
    version: 1,
    created_at: localDateKey(yesterday),
    updated_at: localDateKey(now),
    completed_at: null,
    can_edit: true,
  };
}

describe("project schedule views", () => {
  it("renders due issues in the current calendar month", () => {
    const markup = renderToStaticMarkup(
      <ProjectCalendarView
        issues={[scheduledIssue()]}
        locale="zh-CN"
        statuses={statuses}
        viewOptions={defaultScheduleViewOptions}
        onOpen={vi.fn()}
        onSchedule={vi.fn()}
      />,
    );

    expect(markup).toContain('data-testid="collaboration-calendar"');
    expect(markup).toContain(
      'data-testid="collaboration-calendar-issue-issue-1"',
    );
    expect(markup).toContain(
      'data-testid="collaboration-calendar-scale-month"',
    );
    expect(markup).toContain("bg-blue-500/10");
    expect(markup).not.toContain("border-l-2");
    expect(markup).toContain("待开始");
    expect(markup).not.toContain("PRJ-1");
  });

  it("renders a cross-week issue as connected calendar bars", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 10, 12));
    try {
      const issue = scheduledIssue();
      issue.start_at = "2026-10-12";
      issue.due_at = "2026-10-20";
      const markup = renderToStaticMarkup(
        <ProjectCalendarView
          issues={[issue]}
          locale="zh-CN"
          statuses={statuses}
          viewOptions={defaultScheduleViewOptions}
          onOpen={vi.fn()}
        />,
      );

      expect(
        markup.match(/data-testid="collaboration-calendar-issue-issue-1"/g),
      ).toHaveLength(2);
      expect(markup).toContain("rounded-r-none");
      expect(markup).toContain("rounded-l-none");
      expect(markup).toContain("mx-1");
      expect(markup).not.toContain("mr-0");
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders start-to-due bars in the current Gantt window", () => {
    const markup = renderToStaticMarkup(
      <ProjectGanttView
        issues={[scheduledIssue()]}
        locale="zh-CN"
        statuses={statuses}
        viewOptions={defaultScheduleViewOptions}
        onOpen={vi.fn()}
      />,
    );

    expect(markup).toContain('data-testid="collaboration-gantt"');
    expect(markup).toContain('data-testid="collaboration-gantt-issue-issue-1"');
    expect(markup).toContain('data-testid="collaboration-gantt-scale-month"');
    expect(markup).toContain(
      'data-testid="collaboration-gantt-toggle-task-column"',
    );
    expect(markup).toContain("拖动时间条可整体改期");
    expect(markup).toContain("2天");
    expect(markup).not.toContain("PRJ-1");
    expect(markup).toContain("data-tooltip-trigger");
    expect(markup).toContain('aria-label="Scheduled issue"');
  });

  it("renders single-day issues as draggable bars", () => {
    const issue = scheduledIssue();
    issue.created_at = issue.due_at!;
    const markup = renderToStaticMarkup(
      <ProjectGanttView
        issues={[issue]}
        locale="zh-CN"
        statuses={statuses}
        viewOptions={defaultScheduleViewOptions}
        onOpen={vi.fn()}
        onSchedule={vi.fn()}
      />,
    );

    expect(markup).toContain(
      'data-testid="collaboration-gantt-issue-issue-1-start-handle"',
    );
    expect(markup).toContain(
      'data-testid="collaboration-gantt-issue-issue-1-end-handle"',
    );
    expect(markup).toContain("absolute inset-y-0 left-0");
    expect(markup).toContain("absolute inset-y-0 right-0");
    expect(markup).toContain("after:h-4 after:w-px");
  });

  it("keeps calendar bars whole-task draggable without resize handles", () => {
    const markup = renderToStaticMarkup(
      <ProjectCalendarView
        issues={[scheduledIssue()]}
        locale="zh-CN"
        statuses={statuses}
        viewOptions={defaultScheduleViewOptions}
        onOpen={vi.fn()}
        onSchedule={vi.fn()}
      />,
    );

    expect(markup).not.toContain(
      'data-testid="collaboration-calendar-issue-issue-1-start-handle"',
    );
    expect(markup).not.toContain(
      'data-testid="collaboration-calendar-issue-issue-1-end-handle"',
    );
    expect(markup).toContain("cursor-pointer");
  });

  it("renders filter, group, sort, reset, and project-save controls", () => {
    const markup = renderToStaticMarkup(
      <ProjectCalendarView
        issues={[scheduledIssue()]}
        locale="zh-CN"
        statuses={statuses}
        viewOptions={{
          ...defaultScheduleViewOptions,
          status: "pending",
          groupBy: "status",
        }}
        hasPersonalViewOptions
        onViewOptionsChange={vi.fn()}
        onResetViewOptions={vi.fn()}
        onSaveProjectViewOptions={vi.fn()}
        onOpen={vi.fn()}
      />,
    );

    expect(markup).toContain(
      'data-testid="collaboration-calendar-status-filter"',
    );
    expect(markup).toContain('data-testid="collaboration-calendar-group-by"');
    expect(markup).toContain('data-testid="collaboration-calendar-sort-by"');
    expect(markup).toContain(
      'data-testid="collaboration-calendar-reset-view-options"',
    );
    expect(markup).toContain(
      'data-testid="collaboration-calendar-save-view-options"',
    );
    expect(markup).toContain("本地设置");
  });
});
