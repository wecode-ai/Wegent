import type {ProjectBoardTransferEvents} from './ProjectBoardTransfer'
import {
  ChevronRight,
  ListFilter,
  Maximize2,
  Minimize2,
  Plus,
  Search,
} from 'lucide-react'
import { SelectField } from '../controls/SelectField'
import { normalizeSelectValue } from '../controls/selectValue'
import { TextField as ControlInput } from '../controls/TextField'
import { Tooltip } from '../controls/Tooltip'
import { Button as ControlButton } from '../markdown/Button'
import { registerBoardCursorPolicy } from './boardCursorPolicy'
import { ProjectBoardCardContext } from './projectBoardCardContext'
import './toolbar.css'
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from 'react'
import type { CollaborationTranslate } from '../i18n'
import {
  KanbanBoard,
  type KanbanEmptyState,
} from '../kanban/KanbanBoard'
import { isExecutionBoardColumn } from './projectBoardColumns'
import { ProjectBoardColumnSortPicker } from './ProjectBoardColumnSortPicker'
import {
  ProjectBoardParentRows,
  type ProjectBoardParentRowsProps,
} from './ProjectBoardParentRows'
import type {
  ProjectBoardSort,
  ProjectBoardSortLabels,
} from './projectBoardSorting'
import type { ProjectBoardGroupBy } from './useProjectBoardState'

function classNames(
  ...values: Array<string | false | null | undefined>
): string {
  return values.filter(Boolean).join(' ')
}

export function ProjectBoardScrollArea({
  children,
  viewportRef,
}: {
  children: ReactNode
  viewportRef: React.RefObject<HTMLDivElement | null>
}) {
  return (
    <div
      data-testid="cloud-board-scroll-area"
      className="relative min-h-0 min-w-0 flex-1 overflow-hidden"
    >
      <div
        ref={viewportRef}
        data-testid="cloud-board-scroll"
        className="h-full w-full overflow-x-auto"
      >
        {children}
      </div>
    </div>
  )
}

export interface ProjectBoardColumn {
  type?: ProjectBoardGroupBy | 'unmatched'
  unmatchedColumns?: readonly ProjectBoardColumn[]
  unmatchedFilter?: { tags?: string[]; match?: 'any' | 'all' }
  dotClass: string
  groupValue: string
  key: string
  label: string
  status: string
}

export interface ProjectBoardBreadcrumbItem {
  id: string
  title: string
}

export interface ProjectBoardGroupField {
  id: ProjectBoardGroupBy
  name: string
}

export interface ProjectBoardStatePort {
  externalGroupFilter: string
  externalQuery: string
  focusExecutionColumns: boolean
  groupBy: ProjectBoardGroupBy
  groupFilter: string
  query: string
  getColumnSort(columnKey: string): ProjectBoardSort
  quickCreateStatus: string | null
  scrollRef: React.RefObject<HTMLDivElement | null>
  selectGroupBy(groupBy: ProjectBoardGroupBy): void
  selectColumnSort(columnKey: string, sortBy: ProjectBoardSort): void
  setExternalGroupFilter(value: string): void
  setExternalQuery(value: string): void
  setGroupFilter(value: string): void
  setQuery(value: string): void
  setQuickCreateStatus(value: string | null): void
  toggleFocusExecutionColumns(): void
}

export interface ProjectBoardLocalProjectOption {
  id: number
  name: string
}

export interface ProjectBoardBodyProps<TItem> extends ProjectBoardTransferEvents {
  parentRows?: ProjectBoardParentRowsProps<TItem>
  emptyState?: ReactNode
  viewNavigation?: ReactNode
  viewNotice?: ReactNode
  customView?: boolean
  dropFeedback?: { itemId: string; columnKey: string; message: string } | null
  activeDragItemId: string | null
  boardError: string | null
  boardItemsLoading: boolean
  breadcrumb: readonly ProjectBoardBreadcrumbItem[]
  columns: readonly ProjectBoardColumn[]
  currentParent: ProjectBoardBreadcrumbItem | null
  currentParentId: string | null
  externalGroupLabel: string
  externalGroupValues: readonly string[]
  externalManagedLabel: string
  externalSearchPlaceholder: string
  focusLabels: {
    enter: string
    exit: string
    title: string
  }
  getColumnDragHint(column: ProjectBoardColumn): string | undefined
  getColumnEmptyState(
    column: ProjectBoardColumn,
    items: readonly TItem[],
  ): KanbanEmptyState | undefined
  getColumnItems(
    column: ProjectBoardColumn,
    state: ProjectBoardStatePort,
  ): readonly TItem[]
  getItemKey(item: TItem): string
  groupFields: readonly ProjectBoardGroupField[]
  isExternalBoard: boolean
  isMyTasksBoard: boolean
  layerCount: number
  localProjectFilter?: {
    activeId: string
    allLabel: string
    ariaLabel: string
    label: string
    options: readonly ProjectBoardLocalProjectOption[]
    selectedName: string
    onChange(value: string): void
  }
  onBreadcrumbSelect(id: string | null): void
  onSaveGlobalGroupBy(): Promise<void> | void
  renderColumnFooter?(
    column: ProjectBoardColumn,
    items: readonly TItem[],
    state: ProjectBoardStatePort,
  ): ReactNode
  renderColumnHeaderActions?(
    column: ProjectBoardColumn,
    items: readonly TItem[],
    state: ProjectBoardStatePort,
  ): ReactNode
  renderExternalGroupPicker(): ReactNode
  renderItem(
    item: TItem,
    column: ProjectBoardColumn,
    state: ProjectBoardStatePort,
  ): ReactNode
  renderItemsFooter?(
    column: ProjectBoardColumn,
    items: readonly TItem[],
  ): ReactNode
  renderQuickStart?(state: ProjectBoardStatePort): ReactNode
  renderSkeleton(): ReactNode
  renderStatus?(): ReactNode
  renderGroupPicker(
    value: ProjectBoardGroupBy,
    onChange: (value: ProjectBoardGroupBy) => void,
  ): ReactNode
  renderBoardSettingsAction?(): ReactNode
  filterAction?: ReactNode
  toolbarAction?: ReactNode
  rootLabel: string
  rootUnitLabel: string
  translate: CollaborationTranslate
  searchPlaceholder: string
  sortLabels?: ProjectBoardSortLabels
  saveGlobalDisabled: boolean
  saveGlobalLabel: string
  showQuickStart: boolean
  showSaveGlobal: boolean
  state: ProjectBoardStatePort
}

export function ProjectBoardBody<TItem>({
  parentRows,
  emptyState,
  viewNavigation,
  viewNotice,
  customView = false,
  dropFeedback,
  activeDragItemId,
  boardError,
  boardItemsLoading,
  breadcrumb,
  columns,
  currentParent,
  currentParentId,
  onDragStart,
  onDragCancel,
  onDrop,
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
  renderColumnFooter,
  renderColumnHeaderActions,
  renderExternalGroupPicker,
  renderGroupPicker,
  renderBoardSettingsAction,
  filterAction,
  toolbarAction,
  renderItem,
  renderItemsFooter,
  renderQuickStart,
  renderSkeleton,
  renderStatus,
  rootLabel,
  rootUnitLabel,
  translate,
  searchPlaceholder,
  sortLabels,
  saveGlobalDisabled,
  saveGlobalLabel,
  showQuickStart,
  showSaveGlobal,
  state,
}: ProjectBoardBodyProps<TItem>) {
  const isExecutionColumn = (column: ProjectBoardColumn) =>
    isExecutionBoardColumn(column, state.groupBy)
  const selectedGroupColumn = columns.find(
    (column) => column.key === state.groupFilter,
  )
  const groupFilterLabel = state.groupFilter
    ? (selectedGroupColumn?.label ?? state.groupFilter)
    : translate('todo.board_all_groups', undefined, {
        group:
          groupFields.find((field) => field.id === state.groupBy)?.name ??
          translate('todo.board_group_items'),
      })
  const leafCount = (parentId?: string | null) =>
    new Set(
      parentRows?.rows
        .filter(
          (row) =>
            row.parent === null &&
            (parentId === undefined || row.parentId === parentId),
        )
        .flatMap((row) => [...row.items.values()].flat().map(getItemKey)),
    ).size
  const otherCount =
    leafCount() -
    leafCount(null) -
    (currentParentId ? leafCount(currentParentId) : 0)
  const parentSummary = parentRows?.translate(
    currentParentId
      ? 'todo.parent_board_nested_summary'
      : otherCount
        ? 'todo.parent_board_summary_with_other'
        : 'todo.parent_board_summary',
    undefined,
    {
      parents: parentRows.rows.filter((row) => row.parent !== null).length,
      standalone: leafCount(null),
      children: leafCount(currentParentId),
      other: otherCount,
    },
  )
  const columnHeaderActions = (
    column: ProjectBoardColumn,
    items: readonly TItem[],
  ) => (
    <>
      {renderColumnHeaderActions?.(column, items, state)}
      {sortLabels && !isExternalBoard ? (
        <ProjectBoardColumnSortPicker
          columnKey={column.key}
          columnLabel={column.label}
          labels={sortLabels}
          value={state.getColumnSort(column.key)}
          onChange={(value) => state.selectColumnSort(column.key, value)}
        />
      ) : null}
    </>
  )
  const boardCard = (item: TItem, column: ProjectBoardColumn) => {
    const highlighted =
      dropFeedback?.itemId === getItemKey(item) &&
      dropFeedback.columnKey === column.key
    // Preserve the card's drag registration when feedback changes.
    return (
      <ProjectBoardCardContext.Provider
        value={{ columnKey: column.key, groupBy: state.groupBy }}
      >
        <div
          data-testid={highlighted ? 'board-drop-highlight' : undefined}
          className={
            highlighted ? 'rounded-xl ring-2 ring-focus/50' : undefined
          }
        >
          {renderItem(item, column, state)}
        </div>
      </ProjectBoardCardContext.Provider>
    )
  }
  return (
    <div
      ref={registerBoardCursorPolicy}
      className="flex min-h-0 min-w-0 flex-1 flex-col pt-4"
    >
      {isExternalBoard ? (
        <div className="flex shrink-0 items-center gap-2 px-6 pb-3">
          {renderExternalGroupPicker()}
          <SelectField
            testId="dingtalk-board-assignee-filter"
            accessibleLabel={translate('todo.board_filter_group')}
            value={normalizeSelectValue(state.externalGroupFilter)}
            onChange={state.setExternalGroupFilter}
            options={[
              { value: '', label: translate('todo.board_all') },
              ...externalGroupValues.map((name) => ({
                value: name,
                label: name,
              })),
            ]}
            triggerContent={
              <span className="truncate">
                {state.externalGroupFilter ||
                  translate('todo.board_all_groups', undefined, {
                    group: externalGroupLabel,
                  })}
              </span>
            }
          />
          {filterAction}
          <label className="relative min-w-52">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" />
            <ControlInput
              data-testid="dingtalk-board-search"
              value={state.externalQuery}
              onChange={(event) => state.setExternalQuery(event.target.value)}
              placeholder={externalSearchPlaceholder}
              className="w-full pl-9"
            />
          </label>
          <span className="ml-auto text-xs text-text-muted">
            {externalManagedLabel}
          </span>
        </div>
      ) : (
        <div className="project-board-toolbar flex min-w-0 shrink-0 items-start">
          <div
            data-testid="cloud-board-toolbar"
            className="scrollbar-none flex min-w-0 flex-1 items-center gap-2 overflow-x-auto overscroll-x-contain px-6 pb-3"
          >
            {isMyTasksBoard &&
            localProjectFilter &&
            localProjectFilter.options.length > 0 ? (
              <SelectField
                testId="cloud-local-project-filter"
                accessibleLabel={localProjectFilter.ariaLabel}
                value={normalizeSelectValue(localProjectFilter.activeId)}
                onChange={(value) => {
                  state.setQuickCreateStatus(null)
                  localProjectFilter.onChange(value)
                }}
                options={[
                  { value: 'all', label: localProjectFilter.allLabel },
                  ...localProjectFilter.options.map((project) => ({
                    value: String(project.id),
                    label: project.name,
                  })),
                ]}
                triggerContent={
                  <span className="truncate">
                    {localProjectFilter.label.replace(
                      '{{project}}',
                      localProjectFilter.selectedName,
                    )}
                  </span>
                }
                className="min-w-40 shrink-0"
              />
            ) : null}
            {!customView &&
              renderGroupPicker(state.groupBy, state.selectGroupBy)}
            <Tooltip label={groupFilterLabel} side="bottom">
              <span className="inline-flex shrink-0">
                <SelectField
                  testId="cloud-board-group-filter"
                  accessibleLabel={translate('todo.board_filter_group')}
                  value={normalizeSelectValue(state.groupFilter)}
                  onChange={state.setGroupFilter}
                  options={[
                    { value: '', label: translate('todo.board_all') },
                    ...(state.groupFilter && !selectedGroupColumn
                      ? [{ value: state.groupFilter, label: groupFilterLabel }]
                      : []),
                    ...columns.map((column) => ({
                      value: column.key,
                      label: column.label,
                    })),
                  ]}
                  triggerContent={
                    <span className="flex min-w-0 items-center gap-2">
                      <ListFilter
                        className="h-4 w-4 shrink-0"
                        aria-hidden="true"
                      />
                      <span
                        data-testid="cloud-board-group-filter-label"
                        className="truncate"
                      >
                        {groupFilterLabel}
                      </span>
                    </span>
                  }
                  className="shrink-0"
                />
              </span>
            </Tooltip>
            {filterAction}
            <label className="project-board-search relative min-w-52 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" />
              <ControlInput
                data-testid="cloud-board-search"
                value={state.query}
                onChange={(event) => state.setQuery(event.target.value)}
                placeholder={searchPlaceholder}
                className="w-full pl-9"
              />
            </label>
            <div
              data-testid="cloud-board-view-actions"
              className="ml-auto flex shrink-0 items-center gap-2"
            >
              {columns.some(isExecutionColumn) ? (
                <Tooltip
                  label={
                    state.focusExecutionColumns
                      ? focusLabels.exit
                      : focusLabels.enter
                  }
                >
                  <ControlButton
                    variant="unstyled"
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
                      'project-board-compact-action inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border px-3 text-xs font-medium transition focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/30',
                      state.focusExecutionColumns
                        ? 'border-text-primary/20 bg-text-primary text-background hover:bg-text-primary/90'
                        : 'border-border bg-background text-text-secondary hover:bg-muted hover:text-text-primary',
                    )}
                  >
                    {state.focusExecutionColumns ? (
                      <Minimize2 className="h-3.5 w-3.5" />
                    ) : (
                      <Maximize2 className="h-3.5 w-3.5" />
                    )}
                    <span className="project-board-action-label">
                      {focusLabels.title}
                    </span>
                  </ControlButton>
                </Tooltip>
              ) : null}
              {!customView && showSaveGlobal ? (
                <ControlButton
                  variant="outline"
                  size="sm"
                  type="button"
                  data-testid="cloud-board-save-global"
                  disabled={saveGlobalDisabled}
                  onClick={() => void onSaveGlobalGroupBy()}
                  className="h-8 shrink-0 whitespace-nowrap rounded-lg border border-border bg-background px-3 text-xs font-medium text-text-secondary hover:bg-muted hover:text-text-primary disabled:opacity-50"
                >
                  {saveGlobalLabel}
                </ControlButton>
              ) : null}
              {renderBoardSettingsAction?.()}
              {viewNavigation}
            </div>
          </div>
          {toolbarAction && (
            <div
              data-testid="project-board-toolbar-action"
              className="flex shrink-0 items-center gap-2 pb-3 pr-6"
            >
              {toolbarAction}
            </div>
          )}
        </div>
      )}
      {viewNotice}
      <nav
        data-testid="cloud-todo-board-breadcrumb"
        aria-label="任务层级"
        className="px-6"
      >
        {currentParent ? (
          <>
            <div className="flex h-7 items-center gap-1 text-xs">
              <ControlButton
                variant="unstyled"
                type="button"
                onClick={() => onBreadcrumbSelect(null)}
                className="rounded-lg px-2 py-1 text-text-secondary hover:bg-muted hover:text-text-primary"
              >
                Issue
              </ControlButton>
              {breadcrumb.map((parent) => (
                <span
                  key={parent.id}
                  className="flex min-w-0 items-center gap-1"
                >
                  <ChevronRight
                    className={'h-3.5 w-3.5 shrink-0 text-text-muted'}
                  />
                  <ControlButton
                    variant="unstyled"
                    type="button"
                    data-testid={`cloud-todo-board-breadcrumb-${parent.id}`}
                    onClick={() => onBreadcrumbSelect(parent.id)}
                    className={classNames(
                      'max-w-48 truncate rounded-lg px-2 py-1 text-text-secondary hover:bg-muted hover:text-text-primary',
                      parent.id === currentParentId &&
                        'font-medium text-text-primary',
                    )}
                  >
                    {parent.title}
                  </ControlButton>
                </span>
              ))}
            </div>
            <div className="flex items-baseline gap-3 px-2 pb-3.5 pt-1.5">
              <h1 className="text-heading-sm font-semibold">
                {currentParent.title}
              </h1>
              <span className="text-xs text-text-muted">
                {parentSummary ??
                  `${layerCount} 个任务 · 仅显示当前层的直接子任务`}
              </span>
            </div>
          </>
        ) : (
          <div className="flex items-baseline gap-3 px-2 pb-3.5 pt-1.5">
            <h1 className="text-heading-sm font-semibold">{rootLabel}</h1>
            <span className="text-xs text-text-muted">
              {parentSummary ?? `${layerCount} ${rootUnitLabel}`}
            </span>
          </div>
        )}
      </nav>
      {showQuickStart ? renderQuickStart?.(state) : null}
      {renderStatus?.()}
      {boardError ? (
        <p className="mx-6 mb-2 text-xs text-destructive" role="alert">
          {boardError}
        </p>
      ) : null}
      {dropFeedback && (
        <p
          role="status"
          data-testid="board-drop-feedback"
          className="mx-6 mb-2 text-xs text-text-secondary"
        >
          {dropFeedback.message}
        </p>
      )}
      {emptyState ?? (
        <ProjectBoardScrollArea viewportRef={state.scrollRef}>
          {boardItemsLoading ? (
            renderSkeleton()
          ) : parentRows ? (
            <ProjectBoardParentRows
              key={parentRows.scopeKey}
              {...parentRows}
              currentParentId={currentParentId}
              columns={columns}
              onDragStart={onDragStart}
              onDragCancel={onDragCancel}
              onDrop={onDrop}
              getItemKey={getItemKey}
              renderItem={boardCard}
              renderColumnHeaderActions={columnHeaderActions}
              getColumnEmptyState={getColumnEmptyState}
              renderColumnFooter={(column, items) =>
                renderColumnFooter?.(column, items, state)
              }
              getColumnDragHint={getColumnDragHint}
              getColumnWidthClassName={(column) =>
                state.focusExecutionColumns && isExecutionColumn(column)
                  ? 'w-[480px]'
                  : 'w-[292px]'
              }
            />
          ) : (
            <KanbanBoard
              columns={columns}
              activeDragItemId={activeDragItemId}
              onDragStart={onDragStart}
              onDragCancel={onDragCancel}
              onDrop={onDrop}
              dropIdPrefix="todo-column:"
              testIdPrefix="cloud-todo"
              getColumnKey={(column) => column.key}
              getColumnLabel={(column) => column.label}
              getColumnDotClassName={(column) => column.dotClass}
              getColumnItems={(column) => getColumnItems(column, state)}
              getColumnWidthClassName={(column) =>
                state.focusExecutionColumns && isExecutionColumn(column)
                  ? 'w-[480px]'
                  : 'w-[292px]'
              }
              getColumnDragHint={getColumnDragHint}
              renderColumnHeaderActions={columnHeaderActions}
              getItemKey={getItemKey}
              renderItem={boardCard}
              renderItemsFooter={renderItemsFooter}
              getColumnEmptyState={getColumnEmptyState}
              renderAddIcon={() => <Plus className="h-5 w-5" />}
              renderColumnFooter={(column, items) =>
                renderColumnFooter?.(column, items, state)
              }
            />
          )}
        </ProjectBoardScrollArea>
      )}
    </div>
  )
}
