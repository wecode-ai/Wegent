// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Clock3, FileText, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useMemo, useState } from "react";

import { Tooltip } from "../issue-detail/Tooltip";
import { canEditCollaborationIssue } from "../permissions";
import { collaborationTestIds } from "../testIds";
import type { CollaborationIssue } from "../types";
import {
  addLocalDays,
  filterAndSortScheduleIssues,
  ganttIssueRange,
  localDateKey,
  scheduleDayOffset,
  scheduleIssueAssigneeLabel,
  scheduleIssueGroupValue,
  startOfLocalDay,
  startOfScheduleWeek,
} from "./model";
import {
  DraggableScheduleBar,
  ScheduleDateDropZone,
  ScheduleDndArea,
  ScheduleToolbar,
  statusClass,
  statusLabel,
  UndatedIssues,
  type ProjectScheduleViewProps,
} from "./ProjectCalendarView";
import { ScheduleViewControls } from "./ScheduleViewControls";

type GanttScale = "week" | "month" | "quarter" | "year";

const ganttScaleOptions: Record<
  GanttScale,
  { days: number; dayWidth: number; shiftDays: number }
> = {
  week: { days: 14, dayWidth: 72, shiftDays: 7 },
  month: { days: 42, dayWidth: 48, shiftDays: 28 },
  quarter: { days: 98, dayWidth: 24, shiftDays: 84 },
  year: { days: 371, dayWidth: 8, shiftDays: 336 },
};

function ganttMonthGroups(days: readonly Date[]) {
  return days.reduce<Array<{ key: string; labelDate: Date; dayCount: number }>>(
    (groups, day) => {
      const key = `${day.getFullYear()}-${day.getMonth()}`;
      const previous = groups.at(-1);
      if (previous?.key === key) {
        previous.dayCount += 1;
        return groups;
      }
      return [...groups, { key, labelDate: day, dayCount: 1 }];
    },
    [],
  );
}

export function ProjectGanttView(props: ProjectScheduleViewProps) {
  const { issues, locale, statuses, onOpen } = props;
  const weekStartsOnMonday = locale === "zh-CN";
  const [scale, setScale] = useState<GanttScale>("month");
  const [taskColumnCollapsed, setTaskColumnCollapsed] = useState(false);
  const [windowStart, setWindowStart] = useState(() =>
    startOfScheduleWeek(new Date(), weekStartsOnMonday),
  );
  const scaleOption = ganttScaleOptions[scale];
  const displayedIssues = useMemo(
    () => filterAndSortScheduleIssues(issues, props.viewOptions),
    [issues, props.viewOptions],
  );
  const ranges = useMemo(
    () =>
      displayedIssues.flatMap((issue) => {
        const range = ganttIssueRange(issue);
        return range ? [range] : [];
      }),
    [displayedIssues],
  );
  const windowEnd = addLocalDays(windowStart, scaleOption.days - 1);
  const visibleRanges = ranges.filter(
    (range) =>
      range.end.getTime() >= windowStart.getTime() &&
      range.start.getTime() <= windowEnd.getTime(),
  );
  const dateLocale = locale === "zh-CN" ? "zh-CN" : "en-US";
  const monthFormatter = new Intl.DateTimeFormat(dateLocale, {
    year: "numeric",
    month: "long",
  });
  const days = Array.from({ length: scaleOption.days }, (_, index) =>
    addLocalDays(windowStart, index),
  );
  const monthGroups = ganttMonthGroups(days);
  const todayOffset = scheduleDayOffset(
    windowStart,
    startOfLocalDay(new Date()),
  );
  const gridWidth = scaleOption.days * scaleOption.dayWidth;
  const scaleLabels: Record<GanttScale, string> =
    locale === "zh-CN"
      ? { week: "周", month: "月", quarter: "季", year: "年" }
      : { week: "Week", month: "Month", quarter: "Quarter", year: "Year" };
  const previousLabel =
    locale === "zh-CN" ? `向前移动${scaleLabels[scale]}` : `Previous ${scale}`;
  const nextLabel =
    locale === "zh-CN" ? `向后移动${scaleLabels[scale]}` : `Next ${scale}`;
  const groupLabel = (issue: CollaborationIssue): string => {
    if (props.viewOptions.groupBy === "status") {
      return statusLabel(statuses, issue);
    }
    if (props.viewOptions.groupBy === "priority") {
      const priorityLabels =
        locale === "zh-CN"
          ? {
              none: "无优先级",
              low: "低",
              medium: "中",
              high: "高",
              urgent: "紧急",
            }
          : {
              none: "No priority",
              low: "Low",
              medium: "Medium",
              high: "High",
              urgent: "Urgent",
            };
      return priorityLabels[issue.priority];
    }
    if (props.viewOptions.groupBy === "assignee") {
      return (
        scheduleIssueAssigneeLabel(issue) ??
        (locale === "zh-CN" ? "未分配" : "Unassigned")
      );
    }
    if (props.viewOptions.groupBy === "tag") {
      return issue.tags[0] ?? (locale === "zh-CN" ? "无标签" : "No tag");
    }
    return "";
  };

  return (
    <ScheduleDndArea issues={displayedIssues} onSchedule={props.onSchedule}>
      <div
        data-testid={collaborationTestIds.gantt}
        className="flex min-h-0 min-w-0 flex-1 flex-col bg-background"
      >
        <ScheduleToolbar
          icon={<Clock3 className="h-4 w-4" />}
          title={locale === "zh-CN" ? "甘特图" : "Gantt"}
          todayLabel={locale === "zh-CN" ? "今天" : "Today"}
          previousLabel={previousLabel}
          nextLabel={nextLabel}
          extraActions={
            <>
              <div
                className="hidden items-center rounded-lg bg-muted p-0.5 md:flex"
                role="group"
                aria-label={locale === "zh-CN" ? "甘特时间尺度" : "Gantt scale"}
              >
                {(Object.keys(ganttScaleOptions) as GanttScale[]).map(
                  (option) => (
                    <button
                      key={option}
                      type="button"
                      data-testid={`collaboration-gantt-scale-${option}`}
                      aria-pressed={scale === option}
                      onClick={() => {
                        setScale(option);
                        setWindowStart(
                          startOfScheduleWeek(new Date(), weekStartsOnMonday),
                        );
                      }}
                      className={
                        scale === option
                          ? "h-7 rounded-md bg-background px-2.5 text-xs font-medium text-text-primary shadow-sm"
                          : "h-7 rounded-md px-2.5 text-xs text-text-secondary hover:text-text-primary"
                      }
                    >
                      {scaleLabels[option]}
                    </button>
                  ),
                )}
              </div>
              <select
                value={scale}
                data-testid="collaboration-gantt-scale-mobile"
                aria-label={locale === "zh-CN" ? "甘特时间尺度" : "Gantt scale"}
                onChange={(event) => {
                  setScale(event.target.value as GanttScale);
                  setWindowStart(
                    startOfScheduleWeek(new Date(), weekStartsOnMonday),
                  );
                }}
                className="h-11 rounded-lg border border-border bg-background px-2 text-xs text-text-primary md:hidden"
              >
                {(Object.keys(ganttScaleOptions) as GanttScale[]).map(
                  (option) => (
                    <option key={option} value={option}>
                      {scaleLabels[option]}
                    </option>
                  ),
                )}
              </select>
            </>
          }
          onPrevious={() =>
            setWindowStart((current) =>
              addLocalDays(current, -scaleOption.shiftDays),
            )
          }
          onToday={() =>
            setWindowStart(startOfScheduleWeek(new Date(), weekStartsOnMonday))
          }
          onNext={() =>
            setWindowStart((current) =>
              addLocalDays(current, scaleOption.shiftDays),
            )
          }
        />
        <ScheduleViewControls {...props} view="gantt" />
        <p className="shrink-0 px-6 py-2 text-xs text-text-muted">
          {locale === "zh-CN"
            ? "拖动时间条可整体改期；悬停后拖动两端可调整开始和结束日期。"
            : "Drag a bar to reschedule it, or drag either end to resize it."}
        </p>
        <div className="min-h-0 flex-1 overflow-auto border-t border-border">
          <div className="min-w-max">
            <div className="sticky top-0 z-20 flex h-16 border-b border-border bg-background">
              <div
                className={`sticky left-0 z-30 flex shrink-0 items-end border-r border-border bg-background pb-2 ${
                  taskColumnCollapsed ? "w-12 justify-center" : "w-80 px-4"
                }`}
              >
                {taskColumnCollapsed ? null : (
                  <>
                    <span className="w-10 shrink-0 text-center text-xs text-text-muted">
                      #
                    </span>
                    <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-text-primary">
                      <FileText className="h-4 w-4 text-text-secondary" />
                      {locale === "zh-CN" ? "标题" : "Title"}
                    </span>
                  </>
                )}
                <button
                  type="button"
                  data-testid="collaboration-gantt-toggle-task-column"
                  aria-label={
                    taskColumnCollapsed
                      ? locale === "zh-CN"
                        ? "展开任务列"
                        : "Expand task column"
                      : locale === "zh-CN"
                        ? "收起任务列"
                        : "Collapse task column"
                  }
                  onClick={() => setTaskColumnCollapsed((current) => !current)}
                  className={`flex h-8 w-8 items-center justify-center rounded-lg text-text-muted hover:bg-muted hover:text-text-primary max-md:h-11 max-md:w-11 ${
                    taskColumnCollapsed ? "" : "ml-auto"
                  }`}
                >
                  {taskColumnCollapsed ? (
                    <PanelLeftOpen className="h-4 w-4" />
                  ) : (
                    <PanelLeftClose className="h-4 w-4" />
                  )}
                </button>
              </div>
              <div style={{ width: gridWidth }}>
                <div className="flex h-8 border-b border-border">
                  {monthGroups.map((group) => (
                    <div
                      key={group.key}
                      className="flex shrink-0 items-center border-r border-border px-3 text-sm font-medium text-text-secondary"
                      style={{
                        width: group.dayCount * scaleOption.dayWidth,
                      }}
                    >
                      {monthFormatter.format(group.labelDate)}
                    </div>
                  ))}
                </div>
                <div className="flex h-8">
                  {days.map((day) => (
                    <ScheduleDateDropZone
                      key={localDateKey(day)}
                      date={localDateKey(day)}
                      instance="gantt-header"
                      testId={`collaboration-gantt-header-day-${localDateKey(day)}`}
                      className={`flex shrink-0 items-center justify-center border-r border-border text-xs ${
                        day.getDay() === 0 || day.getDay() === 6
                          ? "bg-muted/60 text-text-muted"
                          : "text-text-secondary"
                      }`}
                      style={{ width: scaleOption.dayWidth }}
                    >
                      {scale === "year"
                        ? day.getDate() === 1
                          ? day.getMonth() + 1
                          : null
                        : scale === "quarter"
                          ? day.getDay() === 1 || day.getDate() === 1
                            ? day.getDate()
                            : null
                          : day.getDate()}
                    </ScheduleDateDropZone>
                  ))}
                </div>
              </div>
            </div>
            {visibleRanges.length === 0 ? (
              <div className="flex h-32">
                <div
                  className={`sticky left-0 z-10 shrink-0 border-r border-border bg-background ${
                    taskColumnCollapsed ? "w-12" : "w-80"
                  }`}
                />
                <div
                  className="flex items-center justify-center text-sm text-text-muted"
                  style={{ width: gridWidth }}
                >
                  {locale === "zh-CN"
                    ? "当前时间范围内没有已安排时间的 Issue"
                    : "No scheduled issues in this range"}
                </div>
              </div>
            ) : (
              visibleRanges.map(({ issue, start, end }, index) => {
                const rawStart = scheduleDayOffset(windowStart, start);
                const rawEnd = scheduleDayOffset(windowStart, end);
                const left = Math.max(0, rawStart);
                const right = Math.min(scaleOption.days - 1, rawEnd);
                const durationDays = rawEnd - rawStart + 1;
                const offset = left * scaleOption.dayWidth;
                const width = Math.max(
                  24,
                  (right - left + 1) * scaleOption.dayWidth - 8,
                );
                const previousIssue = visibleRanges[index - 1]?.issue;
                const groupValue =
                  props.viewOptions.groupBy === "none"
                    ? ""
                    : scheduleIssueGroupValue(issue, props.viewOptions.groupBy);
                const previousGroupValue =
                  !previousIssue || props.viewOptions.groupBy === "none"
                    ? null
                    : scheduleIssueGroupValue(
                        previousIssue,
                        props.viewOptions.groupBy,
                      );
                const showGroupHeader =
                  props.viewOptions.groupBy !== "none" &&
                  groupValue !== previousGroupValue;
                return (
                  <div key={issue.id}>
                    {showGroupHeader ? (
                      <div
                        className="sticky left-0 z-10 flex h-8 items-center border-b border-border bg-muted/40 px-4 text-xs font-medium text-text-secondary"
                        data-testid={`collaboration-gantt-group-${groupValue || "empty"}`}
                      >
                        {groupLabel(issue)}
                      </div>
                    ) : null}
                    <div
                      className="flex h-12 border-b border-border"
                      data-testid={`collaboration-gantt-row-${issue.id}`}
                    >
                      <Tooltip
                        label={issue.title}
                        align="start"
                        side="bottom"
                        testId={`collaboration-gantt-title-tooltip-${issue.id}`}
                        className={`sticky left-0 z-10 ${
                          taskColumnCollapsed ? "w-12" : "w-80"
                        }`}
                      >
                        <button
                          type="button"
                          aria-label={issue.title}
                          onClick={() => onOpen(issue)}
                          className="flex h-full w-full items-center border-r border-border bg-background text-left hover:bg-muted"
                        >
                          <span className="w-10 shrink-0 text-center text-xs text-text-muted">
                            {index + 1}
                          </span>
                          {taskColumnCollapsed ? null : (
                            <>
                              <FileText className="mr-2 h-4 w-4 shrink-0 text-text-muted" />
                              <span className="min-w-0 flex-1 truncate pr-4 text-sm text-text-primary">
                                {issue.title}
                              </span>
                            </>
                          )}
                          <span className="sr-only">
                            {statusLabel(statuses, issue)}
                          </span>
                        </button>
                      </Tooltip>
                      <div className="relative" style={{ width: gridWidth }}>
                        {days.map((day) => (
                          <ScheduleDateDropZone
                            key={`drop-${issue.id}-${localDateKey(day)}`}
                            date={localDateKey(day)}
                            instance={`gantt-row-${issue.id}`}
                            testId={`collaboration-gantt-row-${issue.id}-day-${localDateKey(day)}`}
                            className="absolute inset-y-0 z-[1] shrink-0"
                            style={{
                              left:
                                scheduleDayOffset(windowStart, day) *
                                scaleOption.dayWidth,
                              width: scaleOption.dayWidth,
                            }}
                          />
                        ))}
                        {days
                          .map((day, dayIndex) => ({ day, dayIndex }))
                          .filter(
                            ({ day }) =>
                              day.getDay() === 0 || day.getDay() === 6,
                          )
                          .map(({ day, dayIndex }) => (
                            <span
                              key={`weekend-${localDateKey(day)}`}
                              className="absolute inset-y-0 border-r border-border"
                              style={{
                                left: dayIndex * scaleOption.dayWidth,
                                width: scaleOption.dayWidth,
                                backgroundImage:
                                  "repeating-linear-gradient(135deg, transparent 0, transparent 5px, rgb(var(--color-border) / 0.55) 5px, rgb(var(--color-border) / 0.55) 6px)",
                              }}
                              aria-hidden="true"
                            />
                          ))}
                        <span
                          className="absolute inset-0"
                          style={{
                            backgroundImage: `repeating-linear-gradient(to right, transparent 0, transparent ${scaleOption.dayWidth - 1}px, rgb(var(--color-border)) ${scaleOption.dayWidth - 1}px, rgb(var(--color-border)) ${scaleOption.dayWidth}px)`,
                          }}
                          aria-hidden="true"
                        />
                        {todayOffset >= 0 && todayOffset < scaleOption.days ? (
                          <span
                            className="absolute inset-y-0 z-10 w-px bg-blue-500/70"
                            style={{
                              left:
                                todayOffset * scaleOption.dayWidth +
                                scaleOption.dayWidth / 2,
                            }}
                            aria-hidden="true"
                          />
                        ) : null}
                        <DraggableScheduleBar
                          issue={issue}
                          enabled={
                            Boolean(props.onSchedule) &&
                            canEditCollaborationIssue(issue)
                          }
                          showStartHandle={
                            Boolean(props.onSchedule) &&
                            canEditCollaborationIssue(issue) &&
                            rawStart >= 0
                          }
                          showEndHandle={
                            Boolean(props.onSchedule) &&
                            canEditCollaborationIssue(issue) &&
                            rawEnd < scaleOption.days
                          }
                          testId={`collaboration-gantt-issue-${issue.id}`}
                          onOpen={() => onOpen(issue)}
                          className={`absolute top-2.5 z-10 flex h-7 min-w-10 items-stretch rounded-md text-center text-xs font-medium text-white shadow-sm transition-[box-shadow,filter] hover:brightness-105 hover:shadow-md max-md:top-0.5 max-md:h-11 ${statusClass(statuses, issue)}`}
                          bodyClassName="flex items-center justify-center px-4 text-center"
                          bodyCursorClassName="cursor-pointer"
                          handleClassName="after:block after:h-4 after:w-px after:rounded-full after:bg-white/80 after:shadow-sm"
                          showDragDateLabels
                          locale={locale}
                          style={{
                            left: offset + 4,
                            width,
                          }}
                          title={`${issue.title} · ${localDateKey(start)} → ${localDateKey(end)}`}
                        >
                          <span className="sr-only">
                            {statusLabel(statuses, issue)}
                          </span>
                          <span className="block truncate">
                            {locale === "zh-CN"
                              ? `${durationDays}天`
                              : `${durationDays}d`}
                          </span>
                        </DraggableScheduleBar>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
        <UndatedIssues {...props} issues={displayedIssues} />
      </div>
    </ScheduleDndArea>
  );
}
