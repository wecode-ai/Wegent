// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export type MyWorkGroupKey =
  | "approval"
  | "action"
  | "running"
  | "review"
  | "done";
export type MyWorkPriority = "urgent" | "high" | "medium" | "low" | "none";

export interface MyWorkItem {
  id: string;
  title: string;
  status: string;
  priority: MyWorkPriority;
  due_at: string | null;
  project_key: string;
  project_name: string;
  has_active_task: boolean;
  execution_state?: string | null;
  can_approve?: boolean;
}

export type IsExecutionStateActive = (
  state: string | null | undefined,
) => boolean;

export const MY_WORK_GROUP_ORDER: readonly MyWorkGroupKey[] = [
  "approval",
  "action",
  "running",
  "review",
  "done",
];

export const MY_WORK_GROUP_META: Record<
  MyWorkGroupKey,
  { dotClass: string; labelKey: string; fallback: string }
> = {
  approval: {
    dotClass: "bg-amber-500",
    labelKey: "workbench.my_work_pending_approval",
    fallback: "待我批准",
  },
  action: {
    dotClass: "bg-indigo-500",
    labelKey: "todo.needs_my_action",
    fallback: "需要我处理",
  },
  running: {
    dotClass: "bg-amber-500",
    labelKey: "todo.my_work_running",
    fallback: "正在执行",
  },
  review: {
    dotClass: "bg-violet-500",
    labelKey: "todo.waiting_confirmation",
    fallback: "等待确认",
  },
  done: {
    dotClass: "bg-emerald-500",
    labelKey: "todo.state_completed",
    fallback: "已完成",
  },
};

export const MY_WORK_PRIORITY_LABELS: Record<MyWorkPriority, [string, string]> =
  {
    urgent: ["todo.priority_urgent", "紧急"],
    high: ["todo.priority_high", "高"],
    medium: ["todo.priority_normal", "普通"],
    low: ["todo.priority_low", "低"],
    none: ["todo.priority_none_short", "无"],
  };

export const MY_WORK_GROUP_EVENT_COLORS: Record<MyWorkGroupKey, string> = {
  approval: "#f59e0b",
  action: "#6366f1",
  running: "#f59e0b",
  review: "#8b5cf6",
  done: "#10b981",
};

const PRIORITY_ORDER: Record<MyWorkPriority, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
};

export function startOfMyWorkDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

export function myWorkDueDay(item: Pick<MyWorkItem, "due_at">): Date | null {
  if (!item.due_at) return null;
  const parsed = new Date(item.due_at);
  return Number.isNaN(parsed.getTime()) ? null : startOfMyWorkDay(parsed);
}

export function myWorkDayDiffFromToday(day: Date, now = new Date()): number {
  const today = startOfMyWorkDay(now);
  return Math.round((day.getTime() - today.getTime()) / 86400000);
}

export function compareMyWorkItems(a: MyWorkItem, b: MyWorkItem): number {
  const dayA = myWorkDueDay(a);
  const dayB = myWorkDueDay(b);
  if (dayA && dayB && dayA.getTime() !== dayB.getTime())
    return dayA.getTime() - dayB.getTime();
  if (dayA && !dayB) return -1;
  if (!dayA && dayB) return 1;
  return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
}

export function isLoopItemExecutionActive(
  item: Pick<MyWorkItem, "status" | "execution_state">,
  isExecutionStateActive: IsExecutionStateActive,
): boolean {
  return (
    item.status === "in_progress" ||
    isExecutionStateActive(item.execution_state)
  );
}

export function isMyWorkExecutionActive(
  item: Pick<MyWorkItem, "status" | "execution_state" | "has_active_task">,
  isExecutionStateActive: IsExecutionStateActive,
): boolean {
  if (item.execution_state != null) {
    return isLoopItemExecutionActive(item, isExecutionStateActive);
  }
  return item.has_active_task && item.status === "in_progress";
}

export function myWorkGroupOf(
  item: MyWorkItem,
  isExecutionStateActive: IsExecutionStateActive,
): MyWorkGroupKey {
  if (item.execution_state === "waiting_approval" && item.can_approve === true)
    return "approval";
  if (item.status === "completed") return "done";
  if (item.status === "in_review") return "review";
  if (isMyWorkExecutionActive(item, isExecutionStateActive)) return "running";
  return "action";
}

export function isMyWorkItemInGroup(
  item: MyWorkItem,
  group: MyWorkGroupKey,
  isExecutionStateActive: IsExecutionStateActive,
): boolean {
  switch (group) {
    case "approval":
      return (
        item.execution_state === "waiting_approval" && item.can_approve === true
      );
    case "action":
      return (
        !isMyWorkExecutionActive(item, isExecutionStateActive) &&
        item.status !== "completed" &&
        !(
          item.execution_state === "waiting_approval" &&
          item.can_approve === true
        )
      );
    case "running":
      return isMyWorkExecutionActive(item, isExecutionStateActive);
    case "review":
      return item.status === "in_review";
    case "done":
      return item.status === "completed";
  }
}

export interface MyWorkTimelineBucket<T extends MyWorkItem> {
  day: Date | null;
  entries: T[];
}

export function groupMyWorkTimeline<T extends MyWorkItem>(
  items: readonly T[],
): MyWorkTimelineBucket<T>[] {
  const byDay = new Map<string, MyWorkTimelineBucket<T>>();
  for (const item of [...items].sort(compareMyWorkItems)) {
    const day = myWorkDueDay(item);
    const key = day ? String(day.getTime()) : "none";
    const bucket = byDay.get(key) ?? { day, entries: [] };
    bucket.entries.push(item);
    byDay.set(key, bucket);
  }
  return [...byDay.entries()]
    .sort(([keyA], [keyB]) => {
      if (keyA === "none") return 1;
      if (keyB === "none") return -1;
      return Number(keyA) - Number(keyB);
    })
    .map(([, bucket]) => bucket);
}

export function listMyWorkProjects(
  items: readonly MyWorkItem[],
): Array<readonly [string, string]> {
  return Array.from(
    new Map(
      items.map((item) => [item.project_key, item.project_name] as const),
    ).entries(),
  ).sort(([, left], [, right]) => left.localeCompare(right));
}

export interface MyWorkCalendarEntry<T extends MyWorkItem> {
  id: string;
  title: string;
  start: string;
  group: MyWorkGroupKey;
  item: T;
}

export function buildMyWorkCalendarEntries<T extends MyWorkItem>(
  items: readonly T[],
  isExecutionStateActive: IsExecutionStateActive,
): MyWorkCalendarEntry<T>[] {
  return items.flatMap((item) => {
    if (!item.due_at || Number.isNaN(new Date(item.due_at).getTime()))
      return [];
    return [
      {
        id: item.id,
        title: item.title,
        start: item.due_at,
        group: myWorkGroupOf(item, isExecutionStateActive),
        item,
      },
    ];
  });
}
