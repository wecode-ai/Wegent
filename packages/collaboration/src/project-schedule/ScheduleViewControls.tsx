// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { RotateCcw, Save } from "lucide-react";
import { useMemo } from "react";

import type { ProjectScheduleViewProps } from "./ProjectCalendarView";
import {
  scheduleIssueAssigneeKey,
  scheduleIssueAssigneeLabel,
  type ScheduleViewOptions,
} from "./model";

export function ScheduleViewControls({
  issues,
  locale,
  statuses,
  view,
  viewOptions,
  hasPersonalViewOptions = false,
  savingProjectViewOptions = false,
  onViewOptionsChange,
  onResetViewOptions,
  onSaveProjectViewOptions,
}: Pick<
  ProjectScheduleViewProps,
  | "issues"
  | "locale"
  | "statuses"
  | "viewOptions"
  | "hasPersonalViewOptions"
  | "savingProjectViewOptions"
  | "onViewOptionsChange"
  | "onResetViewOptions"
  | "onSaveProjectViewOptions"
> & {
  view: "calendar" | "gantt";
}) {
  const assignees = useMemo(() => {
    const labels = new Map<string, string>();
    for (const issue of issues) {
      const key = scheduleIssueAssigneeKey(issue);
      const label = scheduleIssueAssigneeLabel(issue);
      if (key && label) labels.set(key, label);
    }
    return [...labels].sort((left, right) =>
      left[1].localeCompare(right[1], locale),
    );
  }, [issues, locale]);
  const tags = useMemo(
    () =>
      [...new Set(issues.flatMap((issue) => issue.tags))].sort((left, right) =>
        left.localeCompare(right, locale),
      ),
    [issues, locale],
  );
  const prefix = `collaboration-${view}`;
  const changeOption = <Key extends keyof ScheduleViewOptions>(
    key: Key,
    value: ScheduleViewOptions[Key],
  ) => onViewOptionsChange?.({ ...viewOptions, [key]: value });
  const selectClassName =
    "h-8 min-w-28 rounded-lg border border-border bg-background px-2 text-xs text-text-primary outline-none hover:bg-muted focus:border-blue-500 max-md:h-11";
  const labels =
    locale === "zh-CN"
      ? {
          allAssignees: "全部分配",
          allStatuses: "全部状态",
          allTags: "全部标签",
          assignee: "分配",
          filter: "筛选",
          group: "分组",
          groupOptions: {
            none: "不分组",
            status: "按状态",
            priority: "按优先级",
            assignee: "按分配",
            tag: "按标签",
          },
          personal: "本地设置",
          project: "项目设置",
          reset: "恢复项目设置",
          save: "保存为项目设置",
          saving: "保存中",
          sort: "排序",
          sortOptions: {
            start_asc: "开始时间升序",
            due_asc: "结束时间升序",
            updated_desc: "最近更新",
            priority_desc: "优先级从高到低",
          },
          status: "状态",
          tag: "标签",
        }
      : {
          allAssignees: "All assignees",
          allStatuses: "All statuses",
          allTags: "All tags",
          assignee: "Assignee",
          filter: "Filter",
          group: "Group",
          groupOptions: {
            none: "No grouping",
            status: "By status",
            priority: "By priority",
            assignee: "By assignee",
            tag: "By tag",
          },
          personal: "Local settings",
          project: "Project settings",
          reset: "Restore project settings",
          save: "Save as project settings",
          saving: "Saving",
          sort: "Sort",
          sortOptions: {
            start_asc: "Start date",
            due_asc: "End date",
            updated_desc: "Recently updated",
            priority_desc: "Priority",
          },
          status: "Status",
          tag: "Tag",
        };

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-6 py-2">
      <span className="mr-1 text-xs font-medium text-text-muted">
        {labels.filter}
      </span>
      <select
        aria-label={labels.status}
        className={selectClassName}
        data-testid={`${prefix}-status-filter`}
        value={viewOptions.status}
        onChange={(event) => changeOption("status", event.target.value)}
      >
        <option value="">{labels.allStatuses}</option>
        {statuses.map((status) => (
          <option key={status.id} value={status.id}>
            {status.name}
          </option>
        ))}
      </select>
      <select
        aria-label={labels.assignee}
        className={selectClassName}
        data-testid={`${prefix}-assignee-filter`}
        value={viewOptions.assignee}
        onChange={(event) => changeOption("assignee", event.target.value)}
      >
        <option value="">{labels.allAssignees}</option>
        {assignees.map(([key, label]) => (
          <option key={key} value={key}>
            {label}
          </option>
        ))}
      </select>
      <select
        aria-label={labels.tag}
        className={selectClassName}
        data-testid={`${prefix}-tag-filter`}
        value={viewOptions.tag}
        onChange={(event) => changeOption("tag", event.target.value)}
      >
        <option value="">{labels.allTags}</option>
        {tags.map((tag) => (
          <option key={tag} value={tag}>
            {tag}
          </option>
        ))}
      </select>
      <span className="ml-2 text-xs font-medium text-text-muted">
        {labels.group}
      </span>
      <select
        aria-label={labels.group}
        className={selectClassName}
        data-testid={`${prefix}-group-by`}
        value={viewOptions.groupBy}
        onChange={(event) =>
          changeOption(
            "groupBy",
            event.target.value as ScheduleViewOptions["groupBy"],
          )
        }
      >
        {Object.entries(labels.groupOptions).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      <span className="ml-2 text-xs font-medium text-text-muted">
        {labels.sort}
      </span>
      <select
        aria-label={labels.sort}
        className={selectClassName}
        data-testid={`${prefix}-sort-by`}
        value={viewOptions.sortBy}
        onChange={(event) =>
          changeOption(
            "sortBy",
            event.target.value as ScheduleViewOptions["sortBy"],
          )
        }
      >
        {Object.entries(labels.sortOptions).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      <span className="ml-auto text-xs text-text-muted">
        {hasPersonalViewOptions ? labels.personal : labels.project}
      </span>
      {hasPersonalViewOptions ? (
        <button
          type="button"
          data-testid={`${prefix}-reset-view-options`}
          className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs text-text-secondary hover:bg-muted hover:text-text-primary max-md:h-11"
          onClick={onResetViewOptions}
        >
          <RotateCcw className="h-3.5 w-3.5" />
          {labels.reset}
        </button>
      ) : null}
      {hasPersonalViewOptions && onSaveProjectViewOptions ? (
        <button
          type="button"
          data-testid={`${prefix}-save-view-options`}
          disabled={savingProjectViewOptions}
          className="flex h-8 items-center gap-1.5 rounded-lg bg-text-primary px-3 text-xs font-medium text-background hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 max-md:h-11"
          onClick={() => void onSaveProjectViewOptions(viewOptions)}
        >
          <Save className="h-3.5 w-3.5" />
          {savingProjectViewOptions ? labels.saving : labels.save}
        </button>
      ) : null}
    </div>
  );
}
