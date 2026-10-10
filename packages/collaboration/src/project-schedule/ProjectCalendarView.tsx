// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  DndContext,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import {
  createContext,
  useContext,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { canEditCollaborationIssue } from "../permissions";
import type { CollaborationIssue, CollaborationStatus } from "../types";
import { collaborationTestIds } from "../testIds";
import {
  addLocalDays,
  addLocalMonths,
  calendarDays,
  calendarIssueSegments,
  filterAndSortScheduleIssues,
  ganttIssueRange,
  localDateKey,
  parseScheduleDate,
  scheduleDateDropId,
  scheduleDragSource,
  scheduleDrop,
  scheduleIssueDragId,
  scheduleRangeDateKeys,
  scheduleRangeUpdate,
  type ScheduleRangeUpdate,
  type ScheduleViewOptions,
  startOfLocalDay,
  startOfScheduleWeek,
} from "./model";
import { ScheduleViewControls } from "./ScheduleViewControls";

export interface ProjectScheduleViewProps {
  issues: CollaborationIssue[];
  locale: "zh-CN" | "en";
  statuses: CollaborationStatus[];
  onOpen(issue: CollaborationIssue): void;
  onSchedule?(
    issue: CollaborationIssue,
    range: ScheduleRangeUpdate,
  ): Promise<void> | void;
  viewOptions: ScheduleViewOptions;
  hasPersonalViewOptions?: boolean;
  savingProjectViewOptions?: boolean;
  onViewOptionsChange?(options: ScheduleViewOptions): void;
  onResetViewOptions?(): void;
  onSaveProjectViewOptions?(options: ScheduleViewOptions): Promise<void> | void;
}

const statusClasses: Record<CollaborationStatus["color"], string> = {
  gray: "bg-zinc-500",
  blue: "bg-blue-500",
  orange: "bg-amber-500",
  purple: "bg-violet-500",
  green: "bg-emerald-500",
  red: "bg-red-500",
};

const statusSurfaceClasses: Record<CollaborationStatus["color"], string> = {
  gray: "bg-zinc-500/10",
  blue: "bg-blue-500/10",
  orange: "bg-amber-500/10",
  purple: "bg-violet-500/10",
  green: "bg-emerald-500/10",
  red: "bg-red-500/10",
};

interface ScheduleDragPreview {
  activeIssueId: string | null;
  activeMode: "move" | "start" | "end" | null;
  transform: { x: number; y: number };
  previewRange: ScheduleRangeUpdate | null;
  previewDates: ReadonlySet<string>;
}

const ScheduleDragPreviewContext = createContext<ScheduleDragPreview>({
  activeIssueId: null,
  activeMode: null,
  transform: { x: 0, y: 0 },
  previewRange: null,
  previewDates: new Set(),
});

function statusColor(
  statuses: readonly CollaborationStatus[],
  issue: CollaborationIssue,
): CollaborationStatus["color"] {
  return (
    statuses.find((candidate) => candidate.id === issue.status)?.color ?? "gray"
  );
}

export function statusClass(
  statuses: readonly CollaborationStatus[],
  issue: CollaborationIssue,
): string {
  return statusClasses[statusColor(statuses, issue)];
}

export function statusLabel(
  statuses: readonly CollaborationStatus[],
  issue: CollaborationIssue,
): string {
  return (
    statuses.find((candidate) => candidate.id === issue.status)?.name ??
    issue.status
  );
}

function issueDueTime(
  issue: CollaborationIssue,
  locale: "zh-CN" | "en",
): string | null {
  if (!issue.due_at?.includes("T")) return null;
  const dueDate = parseScheduleDate(issue.due_at);
  if (!dueDate) return null;
  return new Intl.DateTimeFormat(locale === "zh-CN" ? "zh-CN" : "en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(dueDate);
}

function scheduleDateLabel(
  value: string,
  locale: ProjectScheduleViewProps["locale"],
): string {
  const date = parseScheduleDate(value);
  if (!date) return value;
  return new Intl.DateTimeFormat(locale === "zh-CN" ? "zh-CN" : "en-US", {
    month: locale === "zh-CN" ? "long" : "short",
    day: "numeric",
  }).format(date);
}

export function ScheduleDateDropZone({
  date,
  instance = "primary",
  testId,
  children,
  className = "",
  style,
}: {
  date: string;
  instance?: string;
  testId?: string;
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  const dragPreview = useContext(ScheduleDragPreviewContext);
  const { isOver, setNodeRef } = useDroppable({
    id: scheduleDateDropId(date, instance),
  });
  const previewsOccupiedDate = dragPreview.previewDates.has(date);
  return (
    <div
      ref={setNodeRef}
      data-testid={testId ?? `collaboration-schedule-drop-${date}`}
      data-schedule-preview={previewsOccupiedDate ? "occupied" : undefined}
      className={`${className} ${isOver ? "ring-2 ring-inset ring-text-muted" : ""}`}
      style={{
        ...style,
        ...(previewsOccupiedDate
          ? { backgroundColor: "rgb(var(--color-muted) / 0.82)" }
          : {}),
      }}
    >
      {children}
    </div>
  );
}

function DraggableUndatedIssue({
  issue,
  locale,
  statuses,
  onOpen,
  enabled,
}: Pick<ProjectScheduleViewProps, "locale" | "statuses" | "onOpen"> & {
  issue: CollaborationIssue;
  enabled: boolean;
}) {
  const { attributes, isDragging, listeners, setNodeRef, transform } =
    useDraggable({
      id: scheduleIssueDragId(issue.id, "move"),
      disabled: !enabled,
    });
  return (
    <button
      ref={setNodeRef}
      type="button"
      data-testid={`collaboration-schedule-undated-${issue.id}`}
      onClick={() => onOpen(issue)}
      className={`inline-flex h-8 max-w-72 items-center gap-2 rounded-lg border border-border px-3 text-xs text-text-secondary hover:bg-muted hover:text-text-primary max-md:h-11 ${
        enabled ? "cursor-grab touch-none active:cursor-grabbing" : ""
      } ${isDragging ? "opacity-50" : ""}`}
      style={{ transform: CSS.Translate.toString(transform) }}
      title={
        enabled
          ? locale === "zh-CN"
            ? `${issue.title}\n拖到上方日期设置开始和结束时间`
            : `${issue.title}\nDrag onto a date above to set the start and end dates`
          : issue.title
      }
      {...listeners}
      {...attributes}
    >
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${statusClass(statuses, issue)}`}
      />
      <span className="sr-only">{statusLabel(statuses, issue)}</span>
      <span className="truncate">{issue.title}</span>
    </button>
  );
}

export function DraggableScheduleBar({
  issue,
  dragInstance,
  enabled,
  showStartHandle,
  showEndHandle,
  testId,
  className,
  bodyClassName,
  bodyCursorClassName,
  handleClassName,
  liftTogether = false,
  showDragDateLabels = false,
  locale = "zh-CN",
  style,
  title,
  onOpen,
  children,
}: {
  issue: CollaborationIssue;
  dragInstance?: string;
  enabled: boolean;
  showStartHandle: boolean;
  showEndHandle: boolean;
  testId: string;
  className: string;
  bodyClassName?: string;
  bodyCursorClassName?: string;
  handleClassName?: string;
  liftTogether?: boolean;
  showDragDateLabels?: boolean;
  locale?: ProjectScheduleViewProps["locale"];
  style?: CSSProperties;
  title: string;
  onOpen(): void;
  children: ReactNode;
}) {
  const dragPreview = useContext(ScheduleDragPreviewContext);
  const move = useDraggable({
    id: scheduleIssueDragId(issue.id, "move", dragInstance),
    disabled: !enabled,
  });
  const start = useDraggable({
    id: scheduleIssueDragId(issue.id, "start", dragInstance),
    disabled: !enabled || !showStartHandle,
  });
  const end = useDraggable({
    id: scheduleIssueDragId(issue.id, "end", dragInstance),
    disabled: !enabled || !showEndHandle,
  });
  const liftedTogether = liftTogether && dragPreview.activeIssueId === issue.id;
  const resizingStart = start.isDragging && start.transform;
  const resizingEnd = end.isDragging && end.transform;
  const baseLeft = typeof style?.left === "number" ? style.left : null;
  const baseWidth = typeof style?.width === "number" ? style.width : null;
  const minimumWidth = 24;
  const startDelta =
    resizingStart && baseWidth !== null
      ? Math.min(resizingStart.x, baseWidth - minimumWidth)
      : 0;
  const endDelta =
    resizingEnd && baseWidth !== null
      ? Math.max(resizingEnd.x, minimumWidth - baseWidth)
      : 0;
  const resizedStyle =
    baseLeft !== null && baseWidth !== null
      ? {
          left: baseLeft + startDelta,
          width: baseWidth - startDelta + endDelta,
        }
      : {};
  const activelyDragging =
    move.isDragging || start.isDragging || end.isDragging;
  const dragRange =
    showDragDateLabels &&
    dragPreview.activeIssueId === issue.id &&
    dragPreview.activeMode !== null &&
    activelyDragging
      ? dragPreview.previewRange
      : null;
  const moveTransform = liftedTogether
    ? {
        x: dragPreview.transform.x,
        y: dragPreview.transform.y - 2,
        scaleX: 1,
        scaleY: 1,
      }
    : move.transform;

  return (
    <div
      data-testid={testId}
      className={`group ${className} ${
        liftedTogether
          ? "z-20 shadow-lg ring-1 ring-text-muted/30"
          : activelyDragging
            ? "z-20 shadow-lg ring-2 ring-inset ring-white/35"
            : ""
      }`}
      style={{
        ...style,
        ...resizedStyle,
        transform: CSS.Translate.toString(moveTransform),
      }}
      title={title}
    >
      {dragRange ? (
        <>
          <span className="pointer-events-none absolute bottom-[calc(100%+8px)] left-0 z-30 -translate-x-[calc(100%+10px)] whitespace-nowrap rounded-lg bg-zinc-700 px-2 py-1 text-sm font-medium text-white shadow-md">
            {scheduleDateLabel(dragRange.startAt, locale)}
          </span>
          <span className="pointer-events-none absolute right-0 bottom-[calc(100%+8px)] z-30 translate-x-[calc(100%+10px)] whitespace-nowrap rounded-lg bg-zinc-700 px-2 py-1 text-sm font-medium text-white shadow-md">
            {scheduleDateLabel(dragRange.dueAt, locale)}
          </span>
        </>
      ) : null}
      {showStartHandle ? (
        <button
          ref={start.setNodeRef}
          type="button"
          data-testid={`${testId}-start-handle`}
          aria-label="调整开始时间"
          className={`absolute inset-y-0 left-0 z-10 flex w-4 cursor-ew-resize touch-none items-center justify-center rounded-l-[inherit] opacity-0 transition-opacity group-hover:opacity-100 ${
            start.isDragging ? "opacity-100" : ""
          } ${handleClassName ?? ""}`}
          {...start.listeners}
          {...start.attributes}
        />
      ) : null}
      <button
        ref={move.setNodeRef}
        type="button"
        onClick={onOpen}
        className={`${bodyClassName ?? ""} h-full min-w-0 flex-1 touch-none text-inherit ${
          enabled ? (bodyCursorClassName ?? "cursor-pointer") : "cursor-pointer"
        }`}
        {...move.listeners}
        {...move.attributes}
      >
        {children}
      </button>
      {showEndHandle ? (
        <button
          ref={end.setNodeRef}
          type="button"
          data-testid={`${testId}-end-handle`}
          aria-label="调整结束时间"
          className={`absolute inset-y-0 right-0 z-10 flex w-4 cursor-ew-resize touch-none items-center justify-center rounded-r-[inherit] opacity-0 transition-opacity group-hover:opacity-100 ${
            end.isDragging ? "opacity-100" : ""
          } ${handleClassName ?? ""}`}
          {...end.listeners}
          {...end.attributes}
        />
      ) : null}
    </div>
  );
}

export function ScheduleDndArea({
  issues,
  onSchedule,
  previewOccupiedRange = false,
  children,
}: {
  issues: CollaborationIssue[];
  onSchedule?: ProjectScheduleViewProps["onSchedule"];
  previewOccupiedRange?: boolean;
  children: ReactNode;
}) {
  const [dragPreview, setDragPreview] = useState<ScheduleDragPreview>({
    activeIssueId: null,
    activeMode: null,
    transform: { x: 0, y: 0 },
    previewRange: null,
    previewDates: new Set(),
  });
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );
  const clearDragPreview = () =>
    setDragPreview({
      activeIssueId: null,
      activeMode: null,
      transform: { x: 0, y: 0 },
      previewRange: null,
      previewDates: new Set(),
    });
  const handleDragStart = ({ active }: DragStartEvent) => {
    const source = scheduleDragSource(active.id);
    const issue = source
      ? issues.find((candidate) => candidate.id === source.issueId)
      : null;
    const range = issue ? ganttIssueRange(issue) : null;
    setDragPreview({
      activeIssueId: source?.issueId ?? null,
      activeMode: source?.mode ?? null,
      transform: { x: 0, y: 0 },
      previewRange: range
        ? {
            startAt: localDateKey(range.start),
            dueAt: localDateKey(range.end),
          }
        : null,
      previewDates: new Set(),
    });
  };
  const handleDragMove = ({ delta }: DragMoveEvent) => {
    setDragPreview((current) => ({
      ...current,
      transform: delta,
    }));
  };
  const handleDragOver = ({ active, over }: DragOverEvent) => {
    const drop = scheduleDrop(active.id, over?.id);
    const issue = drop
      ? issues.find((candidate) => candidate.id === drop.issueId)
      : null;
    const range =
      issue && drop ? scheduleRangeUpdate(issue, drop.mode, drop.date) : null;
    setDragPreview((current) => ({
      ...current,
      previewRange: range ?? current.previewRange,
      previewDates: new Set(
        previewOccupiedRange && range ? scheduleRangeDateKeys(range) : [],
      ),
    }));
  };
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    const drop = scheduleDrop(active.id, over?.id);
    if (!drop || !onSchedule) {
      clearDragPreview();
      return;
    }
    const issue = issues.find((candidate) => candidate.id === drop.issueId);
    const range = issue
      ? scheduleRangeUpdate(issue, drop.mode, drop.date)
      : null;
    if (issue && range) void onSchedule(issue, range);
    clearDragPreview();
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={handleDragStart}
      onDragMove={handleDragMove}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={clearDragPreview}
    >
      <ScheduleDragPreviewContext.Provider value={dragPreview}>
        {children}
      </ScheduleDragPreviewContext.Provider>
    </DndContext>
  );
}

export function ScheduleToolbar({
  icon,
  title,
  todayLabel,
  previousLabel,
  nextLabel,
  extraActions,
  onPrevious,
  onToday,
  onNext,
}: {
  icon: ReactNode;
  title: string;
  todayLabel: string;
  previousLabel: string;
  nextLabel: string;
  extraActions?: ReactNode;
  onPrevious(): void;
  onToday(): void;
  onNext(): void;
}) {
  return (
    <header className="flex shrink-0 items-center gap-2 border-b border-border px-6 py-3">
      <span className="text-text-secondary" aria-hidden="true">
        {icon}
      </span>
      <h1 className="min-w-0 flex-1 truncate text-heading-sm font-semibold">
        {title}
      </h1>
      {extraActions}
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-muted hover:text-text-primary max-md:h-11 max-md:w-11"
          aria-label={previousLabel}
          data-testid="collaboration-schedule-previous"
          onClick={onPrevious}
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <button
          type="button"
          className="h-8 rounded-lg border border-border px-3 text-xs font-medium text-text-secondary hover:bg-muted hover:text-text-primary max-md:h-11"
          data-testid="collaboration-schedule-today"
          onClick={onToday}
        >
          {todayLabel}
        </button>
        <button
          type="button"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-muted hover:text-text-primary max-md:h-11 max-md:w-11"
          aria-label={nextLabel}
          data-testid="collaboration-schedule-next"
          onClick={onNext}
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </header>
  );
}

export function UndatedIssues({
  issues,
  locale,
  statuses,
  onOpen,
  onSchedule,
}: ProjectScheduleViewProps) {
  const undated = issues.filter(
    (issue) =>
      !parseScheduleDate(issue.start_at) && !parseScheduleDate(issue.due_at),
  );
  if (undated.length === 0) return null;
  return (
    <section className="max-h-40 overflow-auto border-t border-border px-6 py-4">
      <h2 className="mb-2 text-sm font-medium text-text-primary">
        {locale === "zh-CN" ? "未安排时间" : "Unscheduled"}
        <span className="ml-2 text-xs font-normal text-text-muted">
          {undated.length}
        </span>
      </h2>
      {onSchedule ? (
        <p className="mb-3 text-xs text-text-muted">
          {locale === "zh-CN"
            ? "拖拽任务到上方日期即可设置起止时间"
            : "Drag a task onto a date above to set its schedule"}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {undated.map((issue) => (
          <DraggableUndatedIssue
            key={issue.id}
            issue={issue}
            locale={locale}
            statuses={statuses}
            onOpen={onOpen}
            enabled={Boolean(onSchedule) && canEditCollaborationIssue(issue)}
          />
        ))}
      </div>
    </section>
  );
}

type CalendarScale = "month" | "week" | "day";

export function ProjectCalendarView(props: ProjectScheduleViewProps) {
  const { issues, locale, statuses, onOpen } = props;
  const [scale, setScale] = useState<CalendarScale>("month");
  const [visibleDate, setVisibleDate] = useState(() =>
    startOfLocalDay(new Date()),
  );
  const weekStartsOnMonday = locale === "zh-CN";
  const days = useMemo(() => {
    if (scale === "month") {
      return calendarDays(visibleDate, weekStartsOnMonday);
    }
    if (scale === "week") {
      const weekStart = startOfScheduleWeek(visibleDate, weekStartsOnMonday);
      return Array.from({ length: 7 }, (_, index) =>
        addLocalDays(weekStart, index),
      );
    }
    return [visibleDate];
  }, [scale, visibleDate, weekStartsOnMonday]);
  const todayKey = localDateKey(new Date());
  const dateLocale = locale === "zh-CN" ? "zh-CN" : "en-US";
  const weekdayFormatter = new Intl.DateTimeFormat(dateLocale, {
    weekday: "short",
  });
  const title = new Intl.DateTimeFormat(dateLocale, {
    year: "numeric",
    month: "long",
    ...(scale === "day" ? { day: "numeric", weekday: "short" } : {}),
  }).format(visibleDate);
  const scaleLabels: Record<CalendarScale, string> =
    locale === "zh-CN"
      ? { month: "月", week: "周", day: "日" }
      : { month: "Month", week: "Week", day: "Day" };
  const shiftVisibleDate = (direction: -1 | 1) => {
    setVisibleDate((current) => {
      if (scale === "month") return addLocalMonths(current, direction);
      return addLocalDays(current, direction * (scale === "week" ? 7 : 1));
    });
  };
  const previousLabel =
    locale === "zh-CN"
      ? `上一个${scaleLabels[scale]}`
      : `Previous ${scaleLabels[scale].toLowerCase()}`;
  const nextLabel =
    locale === "zh-CN"
      ? `下一个${scaleLabels[scale]}`
      : `Next ${scaleLabels[scale].toLowerCase()}`;
  const columnCount = scale === "day" ? 1 : 7;
  const headerDays =
    scale === "month"
      ? days.slice(0, 7)
      : scale === "week"
        ? days
        : [visibleDate];
  const calendarRows = useMemo(
    () =>
      Array.from({ length: Math.ceil(days.length / columnCount) }, (_, index) =>
        days.slice(index * columnCount, (index + 1) * columnCount),
      ),
    [columnCount, days],
  );
  const displayedIssues = useMemo(
    () => filterAndSortScheduleIssues(issues, props.viewOptions),
    [issues, props.viewOptions],
  );
  const issueOrder = useMemo(
    () =>
      new Map(
        displayedIssues.map((issue, index) => [issue.id, index] as const),
      ),
    [displayedIssues],
  );

  return (
    <ScheduleDndArea
      issues={displayedIssues}
      onSchedule={props.onSchedule}
      previewOccupiedRange
    >
      <div
        data-testid={collaborationTestIds.calendar}
        className="flex min-h-0 min-w-0 flex-1 flex-col bg-background"
      >
        <ScheduleToolbar
          icon={<CalendarDays className="h-4 w-4" />}
          title={title}
          todayLabel={locale === "zh-CN" ? "今天" : "Today"}
          previousLabel={previousLabel}
          nextLabel={nextLabel}
          extraActions={
            <>
              <div
                className="hidden items-center rounded-lg bg-muted p-0.5 md:flex"
                role="group"
                aria-label={
                  locale === "zh-CN" ? "日历时间范围" : "Calendar time range"
                }
              >
                {(["month", "week", "day"] as CalendarScale[]).map((option) => (
                  <button
                    key={option}
                    type="button"
                    data-testid={`collaboration-calendar-scale-${option}`}
                    aria-pressed={scale === option}
                    onClick={() => setScale(option)}
                    className={
                      scale === option
                        ? "h-7 rounded-md bg-background px-3 text-xs font-medium text-blue-600 shadow-sm dark:text-blue-400"
                        : "h-7 rounded-md px-3 text-xs text-text-secondary hover:text-text-primary"
                    }
                  >
                    {scaleLabels[option]}
                  </button>
                ))}
              </div>
              <select
                value={scale}
                data-testid="collaboration-calendar-scale-mobile"
                aria-label={
                  locale === "zh-CN" ? "日历时间范围" : "Calendar time range"
                }
                onChange={(event) =>
                  setScale(event.target.value as CalendarScale)
                }
                className="h-11 rounded-lg border border-border bg-background px-2 text-xs text-text-primary md:hidden"
              >
                {(["month", "week", "day"] as CalendarScale[]).map((option) => (
                  <option key={option} value={option}>
                    {scaleLabels[option]}
                  </option>
                ))}
              </select>
            </>
          }
          onPrevious={() => shiftVisibleDate(-1)}
          onToday={() => setVisibleDate(startOfLocalDay(new Date()))}
          onNext={() => shiftVisibleDate(1)}
        />
        <ScheduleViewControls {...props} view="calendar" />
        <div className="min-h-0 flex-1 overflow-auto">
          <div
            className={`flex min-h-full flex-col ${
              scale === "day" ? "min-w-0" : "min-w-[720px]"
            }`}
          >
            <div
              className="sticky top-0 z-10 grid shrink-0 border-b border-border bg-background"
              style={{
                gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))`,
              }}
            >
              {headerDays.map((day) => (
                <div
                  key={`weekday-${localDateKey(day)}`}
                  className="px-3 py-3 text-center text-sm font-semibold text-text-primary"
                >
                  {weekdayFormatter.format(day)}
                </div>
              ))}
            </div>
            <div className="flex flex-1 flex-col border-l border-border">
              {calendarRows.map((rowDays) => {
                const rowKey = localDateKey(rowDays[0]);
                const segments = calendarIssueSegments(
                  displayedIssues,
                  rowDays,
                  issueOrder,
                );
                const laneCount =
                  segments.reduce(
                    (count, segment) => Math.max(count, segment.lane + 1),
                    0,
                  ) || 1;
                return (
                  <div
                    key={rowKey}
                    className="relative grid flex-1"
                    style={{
                      gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))`,
                      minHeight:
                        scale === "month"
                          ? Math.max(112, 46 + laneCount * 30)
                          : Math.max(480, 46 + laneCount * 30),
                    }}
                  >
                    {rowDays.map((day) => {
                      const key = localDateKey(day);
                      const inMonth =
                        scale !== "month" ||
                        day.getMonth() === visibleDate.getMonth();
                      const isToday = key === todayKey;
                      const isWeekend =
                        day.getDay() === 0 || day.getDay() === 6;
                      return (
                        <ScheduleDateDropZone
                          key={key}
                          date={key}
                          className={`border-b border-r border-border p-2 ${
                            isToday
                              ? "bg-blue-500/5"
                              : isWeekend
                                ? "bg-muted/20"
                                : "bg-background"
                          }`}
                        >
                          <section
                            data-testid={`collaboration-calendar-day-${key}`}
                            className="h-full"
                          >
                            <time
                              dateTime={key}
                              className={`flex h-7 w-7 items-center justify-center rounded-full text-sm ${
                                isToday
                                  ? "bg-blue-600 font-semibold text-white"
                                  : inMonth
                                    ? "text-text-primary"
                                    : "text-text-muted"
                              }`}
                            >
                              {day.getDate()}
                            </time>
                          </section>
                        </ScheduleDateDropZone>
                      );
                    })}
                    <div
                      className="pointer-events-none absolute inset-x-0 top-10 z-[2] grid gap-y-1"
                      style={{
                        gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))`,
                        gridTemplateRows: `repeat(${laneCount}, 26px)`,
                      }}
                    >
                      {segments.map((segment) => {
                        const range = ganttIssueRange(segment.issue);
                        const singleDay =
                          segment.startColumn === segment.endColumn &&
                          !segment.continuesBefore &&
                          !segment.continuesAfter;
                        const dueTime = singleDay
                          ? issueDueTime(segment.issue, locale)
                          : null;
                        return (
                          <DraggableScheduleBar
                            key={`${segment.issue.id}-${rowKey}`}
                            issue={segment.issue}
                            dragInstance={rowKey}
                            enabled={
                              Boolean(props.onSchedule) &&
                              canEditCollaborationIssue(segment.issue)
                            }
                            showStartHandle={false}
                            showEndHandle={false}
                            testId={`collaboration-calendar-issue-${segment.issue.id}`}
                            onOpen={() => onOpen(segment.issue)}
                            className={`pointer-events-auto mx-1 flex min-w-0 items-stretch text-left text-xs text-text-primary shadow-sm hover:brightness-95 ${statusSurfaceClasses[statusColor(statuses, segment.issue)]} ${
                              segment.continuesBefore
                                ? "rounded-l-none"
                                : "rounded-l-md"
                            } ${
                              segment.continuesAfter
                                ? "rounded-r-none"
                                : "rounded-r-md"
                            }`}
                            bodyClassName="flex items-center gap-1.5 px-2 text-left"
                            bodyCursorClassName="cursor-pointer"
                            liftTogether
                            style={{
                              gridColumn: `${segment.startColumn + 1} / ${segment.endColumn + 2}`,
                              gridRow: segment.lane + 1,
                            }}
                            title={`${segment.issue.title} · ${localDateKey(range?.start ?? rowDays[0])} → ${localDateKey(range?.end ?? rowDays.at(-1)!)}`}
                          >
                            <span className="sr-only">
                              {statusLabel(statuses, segment.issue)}
                            </span>
                            {dueTime ? (
                              <time className="shrink-0 text-text-muted">
                                {dueTime}
                              </time>
                            ) : null}
                            <span className="truncate font-medium">
                              {segment.issue.title}
                            </span>
                          </DraggableScheduleBar>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
        <UndatedIssues {...props} issues={displayedIssues} />
      </div>
    </ScheduleDndArea>
  );
}
