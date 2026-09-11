// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import {
  KanbanBoard,
  type KanbanBoardProps,
  type KanbanEmptyState,
} from "../kanban/KanbanBoard";
import type { ProjectBoardGroupBy } from "./useProjectBoardState";

function classNames(
  ...values: Array<string | false | null | undefined>
): string {
  return values.filter(Boolean).join(" ");
}

export interface ProjectBoardColumn {
  dotClass: string;
  groupValue: string;
  key: string;
  label: string;
  status: string;
}

export interface ProjectBoardBreadcrumbItem {
  id: string;
  title: string;
}

export interface ProjectBoardGroupField {
  id: ProjectBoardGroupBy;
  name: string;
}

export interface ProjectBoardStatePort {
  externalGroupFilter: string;
  externalQuery: string;
  focusExecutionColumns: boolean;
  groupBy: ProjectBoardGroupBy;
  groupFilter: string;
  query: string;
  quickCreateStatus: string | null;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  selectGroupBy(groupBy: ProjectBoardGroupBy): void;
  setExternalGroupFilter(value: string): void;
  setExternalQuery(value: string): void;
  setGroupFilter(value: string): void;
  setQuery(value: string): void;
  setQuickCreateStatus(value: string | null): void;
  toggleFocusExecutionColumns(): void;
}

export interface ProjectBoardLocalProjectOption {
  id: number;
  name: string;
}

export interface ProjectBoardBodyProps<TItem> {
  activeDragItemId: string | null;
  boardError: string | null;
  boardItemsLoading: boolean;
  breadcrumb: readonly ProjectBoardBreadcrumbItem[];
  columns: readonly ProjectBoardColumn[];
  currentParent: ProjectBoardBreadcrumbItem | null;
  currentParentId: string | null;
  dnd: KanbanBoardProps<ProjectBoardColumn, TItem>["dnd"];
  dndContextProps: Record<string, unknown>;
  externalGroupLabel: string;
  externalGroupValues: readonly string[];
  externalManagedLabel: string;
  externalSearchPlaceholder: string;
  focusLabels: {
    enter: string;
    exit: string;
    title: string;
  };
  getColumnDragHint(column: ProjectBoardColumn): string | undefined;
  getColumnEmptyState(
    column: ProjectBoardColumn,
    items: readonly TItem[],
  ): KanbanEmptyState | undefined;
  getColumnItems(
    column: ProjectBoardColumn,
    state: ProjectBoardStatePort,
  ): readonly TItem[];
  getItemKey(item: TItem): string;
  groupFields: readonly ProjectBoardGroupField[];
  isExternalBoard: boolean;
  isMyTasksBoard: boolean;
  layerCount: number;
  localProjectFilter?: {
    activeId: string;
    allLabel: string;
    ariaLabel: string;
    label: string;
    options: readonly ProjectBoardLocalProjectOption[];
    selectedName: string;
    onChange(value: string): void;
  };
  onBreadcrumbSelect(id: string | null): void;
  onSaveGlobalGroupBy(): Promise<void> | void;
  renderAddIcon(): ReactNode;
  renderColumnFooter?(
    column: ProjectBoardColumn,
    items: readonly TItem[],
    state: ProjectBoardStatePort,
  ): ReactNode;
  renderColumnHeaderActions?(
    column: ProjectBoardColumn,
    items: readonly TItem[],
    state: ProjectBoardStatePort,
  ): ReactNode;
  renderDragOverlay(): ReactNode;
  renderChevronDown(className: string): ReactNode;
  renderChevronRight(className: string): ReactNode;
  renderExternalGroupPicker(): ReactNode;
  renderFocusIcon(focused: boolean): ReactNode;
  renderItem(
    item: TItem,
    column: ProjectBoardColumn,
    state: ProjectBoardStatePort,
  ): ReactNode;
  renderItemsFooter?(
    column: ProjectBoardColumn,
    items: readonly TItem[],
  ): ReactNode;
  renderQuickStart?(state: ProjectBoardStatePort): ReactNode;
  renderSearchIcon(): ReactNode;
  renderSkeleton(): ReactNode;
  renderStatus?(): ReactNode;
  renderTooltip(label: string, child: ReactNode): ReactNode;
  renderGroupPicker(
    value: ProjectBoardGroupBy,
    onChange: (value: ProjectBoardGroupBy) => void,
  ): ReactNode;
  rootLabel: string;
  rootUnitLabel: string;
  searchPlaceholder: string;
  saveGlobalDisabled: boolean;
  saveGlobalLabel: string;
  showQuickStart: boolean;
  showSaveGlobal: boolean;
  state: ProjectBoardStatePort;
}

export function ProjectBoardBody<TItem>({
  activeDragItemId,
  boardError,
  boardItemsLoading,
  breadcrumb,
  columns,
  currentParent,
  currentParentId,
  dnd,
  dndContextProps,
  externalGroupLabel,
  externalGroupValues,
  externalManagedLabel,
  externalSearchPlaceholder,
  focusLabels,
  getColumnDragHint,
  getColumnEmptyState,
  getColumnItems,
  getItemKey,
  groupFields,
  isExternalBoard,
  isMyTasksBoard,
  layerCount,
  localProjectFilter,
  onBreadcrumbSelect,
  onSaveGlobalGroupBy,
  renderAddIcon,
  renderColumnFooter,
  renderColumnHeaderActions,
  renderDragOverlay,
  renderChevronDown,
  renderChevronRight,
  renderExternalGroupPicker,
  renderFocusIcon,
  renderGroupPicker,
  renderItem,
  renderItemsFooter,
  renderQuickStart,
  renderSearchIcon,
  renderSkeleton,
  renderStatus,
  renderTooltip,
  rootLabel,
  rootUnitLabel,
  searchPlaceholder,
  saveGlobalDisabled,
  saveGlobalLabel,
  showQuickStart,
  showSaveGlobal,
  state,
}: ProjectBoardBodyProps<TItem>) {
  return (
    <div className="flex min-h-0 flex-1 flex-col pb-6 pt-4">
      {isExternalBoard ? (
        <div className="flex shrink-0 items-center gap-2 px-6 pb-3">
          {renderExternalGroupPicker()}
          <span className="relative inline-flex h-8 items-center rounded-lg border border-border bg-background px-3 text-xs text-text-secondary">
            {state.externalGroupFilter || `全部${externalGroupLabel}`}
            {renderChevronDown("ml-2 h-3 w-3")}
            <select
              data-testid="dingtalk-board-assignee-filter"
              value={state.externalGroupFilter}
              onChange={(event) =>
                state.setExternalGroupFilter(event.target.value)
              }
              className="absolute inset-0 cursor-pointer opacity-0"
              aria-label="分组值筛选"
            >
              <option value="">全部</option>
              {externalGroupValues.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </span>
          <label className="flex h-8 min-w-52 items-center gap-2 rounded-lg border border-border px-2.5 text-xs text-text-muted focus-within:border-focus">
            {renderSearchIcon()}
            <input
              data-testid="dingtalk-board-search"
              value={state.externalQuery}
              onChange={(event) => state.setExternalQuery(event.target.value)}
              placeholder={externalSearchPlaceholder}
              className="min-w-0 flex-1 bg-transparent text-text-primary outline-none"
            />
          </label>
          <span className="ml-auto text-xs text-text-muted">
            {externalManagedLabel}
          </span>
        </div>
      ) : (
        <div
          data-testid="cloud-board-toolbar"
          className="scrollbar-none flex shrink-0 items-center gap-2 overflow-x-auto overscroll-x-contain px-6 pb-3"
        >
          {isMyTasksBoard &&
          localProjectFilter &&
          localProjectFilter.options.length > 0 ? (
            <label className="relative inline-flex h-8 min-w-40 shrink-0 cursor-pointer items-center rounded-lg border border-border bg-background pl-3 pr-8 text-xs font-medium text-text-primary hover:bg-muted">
              <span className="sr-only">{localProjectFilter.ariaLabel}</span>
              <span className="pointer-events-none min-w-0 truncate">
                {localProjectFilter.label.replace(
                  "{{project}}",
                  localProjectFilter.selectedName,
                )}
              </span>
              {renderChevronDown(
                "pointer-events-none absolute right-2.5 h-3.5 w-3.5 text-text-muted",
              )}
              <select
                data-testid="cloud-local-project-filter"
                aria-label={localProjectFilter.ariaLabel}
                value={localProjectFilter.activeId}
                onChange={(event) => {
                  state.setQuickCreateStatus(null);
                  localProjectFilter.onChange(event.target.value);
                }}
                className="absolute inset-0 cursor-pointer opacity-0"
              >
                <option value="all">{localProjectFilter.allLabel}</option>
                {localProjectFilter.options.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {renderGroupPicker(state.groupBy, state.selectGroupBy)}
          <label className="relative inline-flex h-8 shrink-0 cursor-pointer items-center whitespace-nowrap rounded-lg border border-border bg-background px-3 text-xs text-text-secondary hover:bg-muted">
            <span data-testid="cloud-board-group-filter-label">
              {state.groupFilter
                ? columns.find((column) => column.key === state.groupFilter)
                    ?.label
                : `全部${groupFields.find((field) => field.id === state.groupBy)?.name ?? "任务"}`}
            </span>
            {renderChevronDown("ml-2 h-3 w-3")}
            <select
              data-testid="cloud-board-group-filter"
              value={state.groupFilter}
              onChange={(event) => state.setGroupFilter(event.target.value)}
              className="absolute inset-0 cursor-pointer opacity-0"
              aria-label="分组值筛选"
            >
              <option value="">全部</option>
              {columns.map((column) => (
                <option key={column.key} value={column.key}>
                  {column.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex h-8 min-w-52 shrink-0 items-center gap-2 rounded-lg border border-border px-2.5 text-xs text-text-muted focus-within:border-focus">
            {renderSearchIcon()}
            <input
              data-testid="cloud-board-search"
              value={state.query}
              onChange={(event) => state.setQuery(event.target.value)}
              placeholder={searchPlaceholder}
              className="min-w-0 flex-1 bg-transparent text-text-primary outline-none"
            />
          </label>
          <div
            data-testid="cloud-board-view-actions"
            className="ml-auto flex shrink-0 items-center gap-2"
          >
            {state.groupBy === "status"
              ? renderTooltip(
                  state.focusExecutionColumns
                    ? focusLabels.exit
                    : focusLabels.enter,
                  <button
                    type="button"
                    data-testid="cloud-board-focus-running"
                    aria-pressed={state.focusExecutionColumns}
                    aria-label={
                      state.focusExecutionColumns
                        ? focusLabels.exit
                        : focusLabels.enter
                    }
                    onClick={state.toggleFocusExecutionColumns}
                    className={classNames(
                      "inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border px-3 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30",
                      state.focusExecutionColumns
                        ? "border-text-primary/20 bg-text-primary text-background hover:bg-text-primary/90"
                        : "border-border bg-background text-text-secondary hover:bg-muted hover:text-text-primary",
                    )}
                  >
                    {renderFocusIcon(state.focusExecutionColumns)}
                    {focusLabels.title}
                  </button>,
                )
              : null}
            {showSaveGlobal ? (
              <button
                type="button"
                data-testid="cloud-board-save-global"
                disabled={saveGlobalDisabled}
                onClick={() => void onSaveGlobalGroupBy()}
                className="h-8 shrink-0 whitespace-nowrap rounded-lg border border-border bg-background px-3 text-xs font-medium text-text-secondary hover:bg-muted hover:text-text-primary disabled:opacity-50"
              >
                {saveGlobalLabel}
              </button>
            ) : null}
          </div>
        </div>
      )}
      <nav
        data-testid="cloud-todo-board-breadcrumb"
        aria-label="任务层级"
        className="px-6"
      >
        {currentParent ? (
          <>
            <div className="flex h-7 items-center gap-1 text-xs">
              <button
                type="button"
                onClick={() => onBreadcrumbSelect(null)}
                className="rounded-lg px-2 py-1 text-text-secondary hover:bg-muted hover:text-text-primary"
              >
                Issue
              </button>
              {breadcrumb.map((parent) => (
                <span
                  key={parent.id}
                  className="flex min-w-0 items-center gap-1"
                >
                  {renderChevronRight("h-3.5 w-3.5 shrink-0 text-text-muted")}
                  <button
                    type="button"
                    data-testid={`cloud-todo-board-breadcrumb-${parent.id}`}
                    onClick={() => onBreadcrumbSelect(parent.id)}
                    className={classNames(
                      "max-w-48 truncate rounded-lg px-2 py-1 text-text-secondary hover:bg-muted hover:text-text-primary",
                      parent.id === currentParentId &&
                        "font-medium text-text-primary",
                    )}
                  >
                    {parent.title}
                  </button>
                </span>
              ))}
            </div>
            <div className="flex items-baseline gap-3 px-2 pb-3.5 pt-1.5">
              <h1 className="text-heading-sm font-semibold">
                {currentParent.title}
              </h1>
              <span className="text-xs text-text-muted">
                {layerCount} 个任务 · 仅显示当前层的直接子任务
              </span>
            </div>
          </>
        ) : (
          <div className="flex items-baseline gap-3 px-2 pb-3.5 pt-1.5">
            <h1 className="text-heading-sm font-semibold">{rootLabel}</h1>
            <span className="text-xs text-text-muted">
              {layerCount} {rootUnitLabel}
            </span>
          </div>
        )}
      </nav>
      {showQuickStart ? renderQuickStart?.(state) : null}
      {renderStatus?.() ??
        (boardError ? (
          <p className="mx-6 mb-2 text-xs text-destructive" role="alert">
            {boardError}
          </p>
        ) : null)}
      <div
        ref={state.scrollRef}
        data-testid="cloud-board-scroll"
        className="min-h-0 flex-1 overflow-x-auto"
      >
        {boardItemsLoading ? (
          renderSkeleton()
        ) : (
          <KanbanBoard
            columns={columns}
            activeDragItemId={activeDragItemId}
            dnd={dnd}
            dndContextProps={dndContextProps}
            dropIdPrefix="todo-column:"
            testIdPrefix="cloud-todo"
            getColumnKey={(column) => column.key}
            getColumnLabel={(column) => column.label}
            getColumnDotClassName={(column) => column.dotClass}
            getColumnItems={(column) => getColumnItems(column, state)}
            getColumnWidthClassName={(column) =>
              state.focusExecutionColumns &&
              state.groupBy === "status" &&
              (column.status === "in_progress" || column.status === "in_review")
                ? "w-[480px]"
                : "w-[292px]"
            }
            getColumnDragHint={getColumnDragHint}
            renderColumnHeaderActions={(column, items) =>
              renderColumnHeaderActions?.(column, items, state)
            }
            getItemKey={getItemKey}
            renderItem={(item, column) => renderItem(item, column, state)}
            renderItemsFooter={renderItemsFooter}
            getColumnEmptyState={getColumnEmptyState}
            renderAddIcon={renderAddIcon}
            renderColumnFooter={(column, items) =>
              renderColumnFooter?.(column, items, state)
            }
            renderDragOverlay={renderDragOverlay}
          />
        )}
      </div>
    </div>
  );
}
