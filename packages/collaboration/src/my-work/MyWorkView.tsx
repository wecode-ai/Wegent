// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState, type ComponentType, type ReactNode } from "react";

import {
  compareMyWorkItems,
  groupMyWorkTimeline,
  isMyWorkItemInGroup,
  listMyWorkProjects,
  MY_WORK_GROUP_META,
  MY_WORK_GROUP_ORDER,
  MY_WORK_PRIORITY_LABELS,
  myWorkDayDiffFromToday,
  myWorkDueDay,
  myWorkGroupOf,
  type IsExecutionStateActive,
  type MyWorkGroupKey,
  type MyWorkItem,
} from "./model";

export type MyWorkViewKind = "group" | "list" | "calendar" | "timeline";
export type MyWorkTranslate = (key: string, fallback: string) => string;
export type MyWorkIcon = ComponentType<{ className?: string }>;

export interface MyWorkIcons {
  group: MyWorkIcon;
  list: MyWorkIcon;
  calendar: MyWorkIcon;
  timeline: MyWorkIcon;
}

export interface MyWorkViewProps<T extends MyWorkItem> {
  items: readonly T[];
  locale: string;
  translate: MyWorkTranslate;
  icons: MyWorkIcons;
  isExecutionStateActive: IsExecutionStateActive;
  onSelectItem: (item: T) => void;
  onApproveItem?: (item: T) => void | Promise<void>;
  renderCalendar: (props: {
    items: readonly T[];
    onSelectItem: (item: T) => void;
  }) => ReactNode;
}

function classNames(
  ...values: Array<string | false | null | undefined>
): string {
  return values.filter(Boolean).join(" ");
}

function GroupSection<T extends MyWorkItem>({
  groupKey,
  items,
  translate,
  onSelectItem,
  onApproveItem,
}: {
  groupKey: MyWorkGroupKey;
  items: readonly T[];
  translate: MyWorkTranslate;
  onSelectItem: (item: T) => void;
  onApproveItem?: (item: T) => void | Promise<void>;
}) {
  const meta = MY_WORK_GROUP_META[groupKey];
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-background shadow-sm">
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <span className={classNames("h-2 w-2 rounded-full", meta.dotClass)} />
        <h2 className="text-sm font-semibold">
          {translate(meta.labelKey, meta.fallback)}
        </h2>
        <span className="text-xs text-text-muted">{items.length}</span>
      </header>
      <div className="divide-y divide-border">
        {items.map((item) => (
          <div
            key={item.id}
            data-testid={`my-work-group-${groupKey}-${item.id}`}
            onClick={() => onSelectItem(item)}
            className="group relative flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/60"
          >
            <span className="shrink-0 font-mono text-xs text-text-muted">
              {item.id}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm font-medium">
              {item.title}
            </span>
            <span className="shrink-0 text-xs text-text-muted transition-opacity group-hover:opacity-0">
              {item.project_name}
            </span>
            {groupKey === "approval" && onApproveItem ? (
              <button
                type="button"
                data-testid={`my-work-approve-${item.id}`}
                onClick={(event) => {
                  event.stopPropagation();
                  void onApproveItem(item);
                }}
                className="absolute right-4 top-1/2 -translate-y-1/2 rounded-lg bg-text-primary px-2.5 py-1 text-xs font-medium text-background opacity-0 transition-opacity group-hover:opacity-100 hover:opacity-90 focus-visible:opacity-100"
              >
                {translate("workbench.my_work_approve", "批准")}
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function ListView<T extends MyWorkItem>({
  items,
  locale,
  translate,
  isExecutionStateActive,
  onSelectItem,
}: Pick<
  MyWorkViewProps<T>,
  "items" | "locale" | "translate" | "isExecutionStateActive" | "onSelectItem"
>) {
  const sorted = useMemo(() => [...items].sort(compareMyWorkItems), [items]);
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }),
    [locale],
  );
  return (
    <div
      data-testid="my-work-list"
      className="overflow-hidden rounded-2xl border border-border bg-background shadow-sm"
    >
      <div className="grid grid-cols-[minmax(0,1fr)_110px_120px_80px_90px] items-center gap-3 border-b border-border bg-muted/30 px-4 py-2 text-xs text-text-muted">
        <span>{translate("todo.my_work_col_task", "任务")}</span>
        <span>{translate("todo.my_work_col_project", "项目")}</span>
        <span>{translate("todo.status", "状态")}</span>
        <span>{translate("todo.priority", "优先级")}</span>
        <span>{translate("todo.my_work_col_due", "截止日期")}</span>
      </div>
      <div className="divide-y divide-border">
        {sorted.map((item) => {
          const group = myWorkGroupOf(item, isExecutionStateActive);
          const due = myWorkDueDay(item);
          const [priorityKey, priorityFallback] =
            MY_WORK_PRIORITY_LABELS[item.priority];
          return (
            <button
              key={item.id}
              type="button"
              data-testid={`my-work-list-row-${item.id}`}
              onClick={() => onSelectItem(item)}
              className="grid w-full grid-cols-[minmax(0,1fr)_110px_120px_80px_90px] items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted/60"
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <span className="shrink-0 font-mono text-xs text-text-muted">
                  {item.id}
                </span>
                <span className="min-w-0 truncate text-sm font-medium">
                  {item.title}
                </span>
              </span>
              <span className="truncate text-xs text-text-muted">
                {item.project_name}
              </span>
              <span className="flex items-center gap-1.5 text-xs text-text-secondary">
                <span
                  className={classNames(
                    "h-1.5 w-1.5 shrink-0 rounded-full",
                    MY_WORK_GROUP_META[group].dotClass,
                  )}
                />
                {translate(
                  MY_WORK_GROUP_META[group].labelKey,
                  MY_WORK_GROUP_META[group].fallback,
                )}
              </span>
              <span
                className={classNames(
                  "text-xs",
                  item.priority === "urgent" || item.priority === "high"
                    ? "font-medium text-destructive"
                    : "text-text-secondary",
                )}
              >
                {translate(priorityKey, priorityFallback)}
              </span>
              <span className="text-xs text-text-muted">
                {due ? dateFormatter.format(due) : "—"}
              </span>
            </button>
          );
        })}
      </div>
      {sorted.length === 0 ? (
        <p className="px-4 py-8 text-center text-xs text-text-muted">
          {translate("todo.no_items_in_group", "当前没有事项")}
        </p>
      ) : null}
    </div>
  );
}

function TimelineView<T extends MyWorkItem>({
  items,
  locale,
  translate,
  isExecutionStateActive,
  onSelectItem,
}: Pick<
  MyWorkViewProps<T>,
  "items" | "locale" | "translate" | "isExecutionStateActive" | "onSelectItem"
>) {
  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        month: "short",
        day: "numeric",
        weekday: "short",
      }),
    [locale],
  );
  const days = useMemo(() => groupMyWorkTimeline(items), [items]);

  function dayLabel(day: Date): string {
    const diff = myWorkDayDiffFromToday(day);
    const relative =
      diff === 0
        ? translate("todo.my_work_today", "今天")
        : diff === 1
          ? translate("todo.my_work_tomorrow", "明天")
          : diff === -1
            ? translate("todo.my_work_yesterday", "昨天")
            : null;
    const formatted = dateFormatter.format(day);
    return relative ? `${relative} · ${formatted}` : formatted;
  }

  return (
    <div data-testid="my-work-timeline">
      {days.map((bucket, index) => (
        <div
          key={bucket.day ? bucket.day.getTime() : "none"}
          className="relative pl-6 pb-6"
        >
          {index < days.length - 1 ? (
            <span
              className="absolute bottom-0 left-[5px] top-6 w-px bg-border"
              aria-hidden
            />
          ) : null}
          <h3 className="mb-2 text-sm font-semibold">
            {bucket.day
              ? dayLabel(bucket.day)
              : translate("todo.my_work_no_due_date", "无截止日期")}
          </h3>
          <div className="space-y-2">
            {bucket.entries.map((item) => {
              const group = myWorkGroupOf(item, isExecutionStateActive);
              const [priorityKey, priorityFallback] =
                MY_WORK_PRIORITY_LABELS[item.priority];
              return (
                <div key={item.id} className="relative">
                  <span
                    aria-hidden
                    className={classNames(
                      "absolute -left-6 top-4 h-2 w-2 rounded-full ring-2 ring-background",
                      MY_WORK_GROUP_META[group].dotClass,
                    )}
                  />
                  <button
                    type="button"
                    data-testid={`my-work-timeline-item-${item.id}`}
                    onClick={() => onSelectItem(item)}
                    className="w-full rounded-xl border border-border bg-background px-4 py-2.5 text-left shadow-sm transition-colors hover:bg-muted/60"
                  >
                    <span className="flex min-w-0 items-center gap-2.5">
                      <span className="shrink-0 font-mono text-xs text-text-muted">
                        {item.id}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {item.title}
                      </span>
                      <span className="shrink-0 text-xs text-text-secondary">
                        {translate(priorityKey, priorityFallback)}
                      </span>
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-text-muted">
                      {item.project_name} ·{" "}
                      {translate(
                        MY_WORK_GROUP_META[group].labelKey,
                        MY_WORK_GROUP_META[group].fallback,
                      )}
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      ))}
      {days.length === 0 ? (
        <p className="px-2 py-8 text-center text-xs text-text-muted">
          {translate("todo.no_items_in_group", "当前没有事项")}
        </p>
      ) : null}
    </div>
  );
}

export function MyWorkView<T extends MyWorkItem>({
  items,
  locale,
  translate,
  icons,
  isExecutionStateActive,
  onSelectItem,
  onApproveItem,
  renderCalendar,
}: MyWorkViewProps<T>) {
  const [view, setView] = useState<MyWorkViewKind>("group");
  const [projectFilter, setProjectFilter] = useState("all");
  const projects = useMemo(() => listMyWorkProjects(items), [items]);
  const activeProjectFilter = projects.some(([key]) => key === projectFilter)
    ? projectFilter
    : "all";
  const visibleItems = useMemo(
    () =>
      activeProjectFilter === "all"
        ? items
        : items.filter((item) => item.project_key === activeProjectFilter),
    [activeProjectFilter, items],
  );
  const viewTabs = [
    {
      key: "group",
      icon: icons.group,
      labelKey: "todo.my_work_view_group",
      fallback: "分组",
    },
    {
      key: "list",
      icon: icons.list,
      labelKey: "todo.my_work_view_list",
      fallback: "列表",
    },
    {
      key: "calendar",
      icon: icons.calendar,
      labelKey: "todo.my_work_view_calendar",
      fallback: "日历",
    },
    {
      key: "timeline",
      icon: icons.timeline,
      labelKey: "todo.my_work_view_timeline",
      fallback: "时间线",
    },
  ] satisfies Array<{
    key: MyWorkViewKind;
    icon: MyWorkIcon;
    labelKey: string;
    fallback: string;
  }>;

  return (
    <div className="relative min-h-0 flex-1" data-testid="cloud-my-work-view">
      <div className="h-full overflow-y-auto px-8 pb-24 pt-7">
        <div className="mx-auto max-w-[960px]">
          <div className="flex items-center gap-3">
            <h1 className="text-heading-md font-semibold">
              {translate("todo.my_work", "我的工作")}
            </h1>
            <label className="relative ml-auto inline-flex h-8 items-center rounded-lg border border-border bg-background px-3 text-xs text-text-secondary hover:bg-muted">
              <span className="sr-only">
                {translate("todo.my_work_project_filter", "按项目过滤任务")}
              </span>
              <select
                data-testid="my-work-project-filter"
                value={activeProjectFilter}
                onChange={(event) => setProjectFilter(event.target.value)}
                className="cursor-pointer appearance-none bg-transparent pr-5 outline-none"
                aria-label={translate(
                  "todo.my_work_project_filter",
                  "按项目过滤任务",
                )}
              >
                <option value="all">
                  {translate("todo.all_projects", "全部项目")}
                </option>
                {projects.map(([key, name]) => (
                  <option key={key} value={key}>
                    {name}
                  </option>
                ))}
              </select>
              <span className="pointer-events-none absolute right-2 text-xs text-text-muted">
                ⌄
              </span>
            </label>
          </div>
          <p className="mt-1 text-sm text-text-muted">
            {translate(
              "todo.my_work_subtitle",
              "自动汇总本机上的全部任务，无需关联项目空间。",
            )}
          </p>
          <div className="mt-6">
            {view === "group" ? (
              <div
                className="grid grid-cols-2 gap-4"
                data-testid="my-work-groups"
              >
                {MY_WORK_GROUP_ORDER.map((groupKey) => (
                  <GroupSection
                    key={groupKey}
                    groupKey={groupKey}
                    items={visibleItems.filter((item) =>
                      isMyWorkItemInGroup(
                        item,
                        groupKey,
                        isExecutionStateActive,
                      ),
                    )}
                    translate={translate}
                    onSelectItem={onSelectItem}
                    onApproveItem={onApproveItem}
                  />
                ))}
              </div>
            ) : null}
            {view === "list" ? (
              <ListView
                items={visibleItems}
                locale={locale}
                translate={translate}
                isExecutionStateActive={isExecutionStateActive}
                onSelectItem={onSelectItem}
              />
            ) : null}
            {view === "calendar"
              ? renderCalendar({ items: visibleItems, onSelectItem })
              : null}
            {view === "timeline" ? (
              <TimelineView
                items={visibleItems}
                locale={locale}
                translate={translate}
                isExecutionStateActive={isExecutionStateActive}
                onSelectItem={onSelectItem}
              />
            ) : null}
          </div>
          <p className="mt-5 text-xs text-text-muted">
            {translate(
              "todo.my_work_scope_note",
              "这里只汇总与你相关的项目任务；未关联任务的普通本地会话不会出现。",
            )}
          </p>
        </div>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex justify-center">
        <div
          role="tablist"
          aria-label={translate("todo.my_work_view_switcher", "视图切换")}
          className="pointer-events-auto flex gap-0.5 rounded-xl border border-border bg-background p-1 shadow-lg"
        >
          {viewTabs.map((tab) => {
            const Icon = tab.icon;
            const active = view === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={active}
                data-testid={`my-work-view-tab-${tab.key}`}
                onClick={() => setView(tab.key)}
                className={classNames(
                  "flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm font-medium transition-colors",
                  active
                    ? "bg-text-primary text-background"
                    : "text-text-secondary hover:bg-muted/60 hover:text-text-primary",
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {translate(tab.labelKey, tab.fallback)}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
