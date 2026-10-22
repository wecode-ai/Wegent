// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type {
  CollaborationIssue,
  CollaborationScheduleGroupBy,
  CollaborationScheduleSortBy,
  CollaborationScheduleViewConfig,
} from "../types";

const DAY_MS = 86_400_000;
const SCHEDULE_ISSUE_DRAG_PREFIX = "schedule-issue:";
const SCHEDULE_DATE_DROP_PREFIX = "schedule-date:";

export type ScheduleDragMode = "move" | "start" | "end";
export type ScheduleGroupBy = CollaborationScheduleGroupBy;
export type ScheduleSortBy = CollaborationScheduleSortBy;

export interface ScheduleViewOptions {
  status: string;
  assignee: string;
  tag: string;
  groupBy: ScheduleGroupBy;
  sortBy: ScheduleSortBy;
}

export const defaultScheduleViewOptions: ScheduleViewOptions = {
  status: "",
  assignee: "",
  tag: "",
  groupBy: "none",
  sortBy: "start_asc",
};

export function scheduleViewOptionsFromConfig(
  config: CollaborationScheduleViewConfig | null | undefined,
): ScheduleViewOptions {
  return config
    ? {
        status: config.status_filter ?? "",
        assignee: config.assignee_filter ?? "",
        tag: config.tag_filter ?? "",
        groupBy: config.group_by,
        sortBy: config.sort_by,
      }
    : defaultScheduleViewOptions;
}

export function scheduleViewConfigFromOptions(
  options: ScheduleViewOptions,
): CollaborationScheduleViewConfig {
  return {
    status_filter: options.status || null,
    assignee_filter: options.assignee || null,
    tag_filter: options.tag || null,
    group_by: options.groupBy,
    sort_by: options.sortBy,
  };
}

export function sameScheduleViewOptions(
  left: ScheduleViewOptions,
  right: ScheduleViewOptions,
): boolean {
  return (
    left.status === right.status &&
    left.assignee === right.assignee &&
    left.tag === right.tag &&
    left.groupBy === right.groupBy &&
    left.sortBy === right.sortBy
  );
}

export interface ScheduleRangeUpdate {
  startAt: string;
  dueAt: string;
}

export function scheduleIssueDragId(
  issueId: string,
  mode: ScheduleDragMode = "move",
  instance?: string,
): string {
  return `${SCHEDULE_ISSUE_DRAG_PREFIX}${mode}:${issueId}${instance ? `:${instance}` : ""}`;
}

export function scheduleDateDropId(date: string, instance: string): string {
  return `${SCHEDULE_DATE_DROP_PREFIX}${date}:${instance}`;
}

export function scheduleDragSource(
  activeId: string | number,
): { issueId: string; mode: ScheduleDragMode } | null {
  const active = String(activeId);
  if (!active.startsWith(SCHEDULE_ISSUE_DRAG_PREFIX)) return null;
  const [modeValue, issueId] = active
    .slice(SCHEDULE_ISSUE_DRAG_PREFIX.length)
    .split(":");
  if (
    !issueId ||
    !["move", "start", "end"].includes(modeValue as ScheduleDragMode)
  ) {
    return null;
  }
  return { issueId, mode: modeValue as ScheduleDragMode };
}

export function scheduleDrop(
  activeId: string | number,
  overId: string | number | undefined,
): { issueId: string; date: string; mode: ScheduleDragMode } | null {
  const source = scheduleDragSource(activeId);
  if (!source || overId === undefined) return null;
  const over = String(overId);
  if (!over.startsWith(SCHEDULE_DATE_DROP_PREFIX)) {
    return null;
  }
  const date = over.slice(SCHEDULE_DATE_DROP_PREFIX.length).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? { ...source, date } : null;
}

export function startOfLocalDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

export function addLocalDays(value: Date, days: number): Date {
  const next = new Date(value);
  next.setDate(next.getDate() + days);
  return next;
}

export function addLocalMonths(value: Date, months: number): Date {
  return new Date(value.getFullYear(), value.getMonth() + months, 1);
}

export function localDateKey(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function parseScheduleDate(
  value: string | null | undefined,
): Date | null {
  if (!value) return null;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const parsed = dateOnly
    ? new Date(
        Number(dateOnly[1]),
        Number(dateOnly[2]) - 1,
        Number(dateOnly[3]),
      )
    : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : startOfLocalDay(parsed);
}

export function scheduleIssueAssigneeKey(issue: CollaborationIssue): string {
  if (issue.assignee_group_id) return `group:${issue.assignee_group_id}`;
  if (issue.assignee_team_id) return `team:${issue.assignee_team_id}`;
  if (issue.assignee_agent_id) return `agent:${issue.assignee_agent_id}`;
  if (issue.assignee_user_id) return `user:${issue.assignee_user_id}`;
  return "";
}

export function scheduleIssueAssigneeLabel(
  issue: CollaborationIssue,
): string | null {
  return (
    issue.assignee_group_name ??
    issue.assignee_team_name ??
    issue.assignee_agent_name ??
    issue.assignee_name ??
    null
  );
}

export function scheduleIssueGroupValue(
  issue: CollaborationIssue,
  groupBy: ScheduleGroupBy,
): string {
  if (groupBy === "status") return issue.status;
  if (groupBy === "priority") return issue.priority;
  if (groupBy === "assignee") return scheduleIssueAssigneeKey(issue);
  if (groupBy === "tag") return issue.tags[0] ?? "";
  return "";
}

const priorityOrder: Record<CollaborationIssue["priority"], number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
};

function scheduleIssueTimestamp(
  issue: CollaborationIssue,
  field: "start" | "due" | "updated",
): number {
  if (field === "updated") return new Date(issue.updated_at).getTime();
  const value =
    field === "start"
      ? (issue.start_at ?? issue.due_at)
      : (issue.due_at ?? issue.start_at);
  return parseScheduleDate(value)?.getTime() ?? Number.MAX_SAFE_INTEGER;
}

export function filterAndSortScheduleIssues(
  issues: readonly CollaborationIssue[],
  options: ScheduleViewOptions,
): CollaborationIssue[] {
  return issues
    .filter(
      (issue) =>
        (!options.status || issue.status === options.status) &&
        (!options.assignee ||
          scheduleIssueAssigneeKey(issue) === options.assignee) &&
        (!options.tag || issue.tags.includes(options.tag)),
    )
    .sort((left, right) => {
      if (options.groupBy !== "none") {
        const groupOrder =
          options.groupBy === "priority"
            ? priorityOrder[left.priority] - priorityOrder[right.priority]
            : scheduleIssueGroupValue(left, options.groupBy).localeCompare(
                scheduleIssueGroupValue(right, options.groupBy),
              );
        if (groupOrder !== 0) return groupOrder;
      }
      if (options.sortBy === "priority_desc") {
        const order =
          priorityOrder[left.priority] - priorityOrder[right.priority];
        if (order !== 0) return order;
      } else if (options.sortBy === "updated_desc") {
        const order =
          scheduleIssueTimestamp(right, "updated") -
          scheduleIssueTimestamp(left, "updated");
        if (order !== 0) return order;
      } else {
        const field = options.sortBy === "due_asc" ? "due" : "start";
        const order =
          scheduleIssueTimestamp(left, field) -
          scheduleIssueTimestamp(right, field);
        if (order !== 0) return order;
      }
      return left.sequence_number - right.sequence_number;
    });
}

export function calendarDays(month: Date, weekStartsOnMonday: boolean): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const weekday = first.getDay();
  const leadingDays = weekStartsOnMonday ? (weekday + 6) % 7 : weekday;
  const start = addLocalDays(first, -leadingDays);
  return Array.from({ length: 42 }, (_, index) => addLocalDays(start, index));
}

export function issuesByDueDate(
  issues: readonly CollaborationIssue[],
): Map<string, CollaborationIssue[]> {
  const grouped = new Map<string, CollaborationIssue[]>();
  for (const issue of issues) {
    const due = parseScheduleDate(issue.due_at);
    if (!due) continue;
    const key = localDateKey(due);
    grouped.set(key, [...(grouped.get(key) ?? []), issue]);
  }
  for (const items of grouped.values()) {
    items.sort(
      (left, right) =>
        left.due_at!.localeCompare(right.due_at!) ||
        left.sequence_number - right.sequence_number,
    );
  }
  return grouped;
}

export function startOfScheduleWeek(
  value: Date,
  weekStartsOnMonday: boolean,
): Date {
  const day = startOfLocalDay(value);
  const offset = weekStartsOnMonday ? (day.getDay() + 6) % 7 : day.getDay();
  return addLocalDays(day, -offset);
}

export function scheduleDayOffset(start: Date, value: Date): number {
  return Math.round(
    (startOfLocalDay(value).getTime() - startOfLocalDay(start).getTime()) /
      DAY_MS,
  );
}

export interface GanttIssueRange {
  issue: CollaborationIssue;
  start: Date;
  end: Date;
}

export interface CalendarIssueSegment {
  issue: CollaborationIssue;
  startColumn: number;
  endColumn: number;
  lane: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
}

export function ganttIssueRange(
  issue: CollaborationIssue,
): GanttIssueRange | null {
  const scheduledStart = parseScheduleDate(issue.start_at);
  const due = parseScheduleDate(issue.due_at);
  if (!scheduledStart && !due) return null;
  const start = scheduledStart ?? due!;
  const end = due ?? scheduledStart!;
  return {
    issue,
    start: start.getTime() <= end.getTime() ? start : end,
    end: start.getTime() <= end.getTime() ? end : start,
  };
}

export function scheduleRangeUpdate(
  issue: CollaborationIssue,
  mode: ScheduleDragMode,
  targetDate: string,
): ScheduleRangeUpdate | null {
  const target = parseScheduleDate(targetDate);
  if (!target) return null;
  const range = ganttIssueRange(issue);
  if (!range) {
    const date = localDateKey(target);
    return { startAt: date, dueAt: date };
  }

  if (mode === "start") {
    return {
      startAt: localDateKey(
        target.getTime() <= range.end.getTime() ? target : range.end,
      ),
      dueAt: localDateKey(range.end),
    };
  }
  if (mode === "end") {
    return {
      startAt: localDateKey(range.start),
      dueAt: localDateKey(
        target.getTime() >= range.start.getTime() ? target : range.start,
      ),
    };
  }

  const durationDays = scheduleDayOffset(range.start, range.end);
  return {
    startAt: localDateKey(target),
    dueAt: localDateKey(addLocalDays(target, durationDays)),
  };
}

export function scheduleRangeDateKeys(range: ScheduleRangeUpdate): string[] {
  const start = parseScheduleDate(range.startAt);
  const end = parseScheduleDate(range.dueAt);
  if (!start || !end || start.getTime() > end.getTime()) return [];
  return Array.from({ length: scheduleDayOffset(start, end) + 1 }, (_, index) =>
    localDateKey(addLocalDays(start, index)),
  );
}

export function ganttIssueRanges(
  issues: readonly CollaborationIssue[],
): GanttIssueRange[] {
  return issues
    .flatMap((issue) => {
      const range = ganttIssueRange(issue);
      return range ? [range] : [];
    })
    .sort(
      (left, right) =>
        left.end.getTime() - right.end.getTime() ||
        left.issue.sequence_number - right.issue.sequence_number,
    );
}

export function calendarIssueSegments(
  issues: readonly CollaborationIssue[],
  rowDays: readonly Date[],
  issueOrder?: ReadonlyMap<string, number>,
): CalendarIssueSegment[] {
  const rowStart = rowDays[0];
  const rowEnd = rowDays.at(-1);
  if (!rowStart || !rowEnd) return [];
  const laneEnds: number[] = [];
  return ganttIssueRanges(issues)
    .filter(
      (range) =>
        range.end.getTime() >= rowStart.getTime() &&
        range.start.getTime() <= rowEnd.getTime(),
    )
    .map((range) => {
      const rawStart = scheduleDayOffset(rowStart, range.start);
      const rawEnd = scheduleDayOffset(rowStart, range.end);
      return {
        issue: range.issue,
        startColumn: Math.max(0, rawStart),
        endColumn: Math.min(rowDays.length - 1, rawEnd),
        continuesBefore: rawStart < 0,
        continuesAfter: rawEnd >= rowDays.length,
      };
    })
    .sort(
      (left, right) =>
        (issueOrder?.get(left.issue.id) ?? Number.MAX_SAFE_INTEGER) -
          (issueOrder?.get(right.issue.id) ?? Number.MAX_SAFE_INTEGER) ||
        left.startColumn - right.startColumn ||
        right.endColumn - left.endColumn ||
        left.issue.sequence_number - right.issue.sequence_number,
    )
    .map((segment) => {
      const availableLane = laneEnds.findIndex(
        (endColumn) => endColumn < segment.startColumn,
      );
      const lane = availableLane === -1 ? laneEnds.length : availableLane;
      laneEnds[lane] = segment.endColumn;
      return { ...segment, lane };
    });
}
