import {
  ProjectBoardTransfer,
  type ProjectBoardTransferEvents,
} from '../project-board/ProjectBoardTransfer'
import { useProjectBoardDropTarget } from '../project-board/projectBoardTransferContext'
import { Button as ControlButton } from '../markdown/Button'
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Fragment, type ReactNode } from 'react'

export interface KanbanEmptyAction {
  ariaLabel: string
  label: string
  onClick(): void
}

export interface KanbanEmptyState {
  action?: KanbanEmptyAction
  hint: string
}

export interface KanbanBoardProps<
  TColumn,
  TItem,
> extends ProjectBoardTransferEvents {
  activeDragItemId: string | null
  columns: readonly TColumn[]
  dropIdPrefix: string
  getColumnDotClassName(column: TColumn): string
  getColumnDragHint(column: TColumn): string | undefined
  getColumnEmptyState(
    column: TColumn,
    items: readonly TItem[],
  ): KanbanEmptyState | undefined
  getColumnItems(column: TColumn): readonly TItem[]
  getColumnKey(column: TColumn): string
  getColumnLabel(column: TColumn): string
  getColumnWidthClassName(column: TColumn): string
  getItemKey(item: TItem): string
  renderAddIcon(): ReactNode
  renderColumnFooter?(column: TColumn, items: readonly TItem[]): ReactNode
  renderColumnHeaderActions?(
    column: TColumn,
    items: readonly TItem[],
  ): ReactNode
  renderItem(item: TItem, column: TColumn): ReactNode
  renderItemsFooter?(column: TColumn, items: readonly TItem[]): ReactNode
  testIdPrefix: string
}

function classNames(
  ...values: Array<string | false | null | undefined>
): string {
  return values.filter(Boolean).join(' ')
}

interface KanbanColumnDropzoneProps {
  children: ReactNode
  dragHint?: string
  dropId: string
  testId: string
}

export function KanbanColumnDropzone({
  children,
  dragHint,
  dropId,
  testId,
}: KanbanColumnDropzoneProps) {
  const { isOver, setElement } = useProjectBoardDropTarget({ id: dropId })

  return (
    <div
      ref={setElement}
      data-testid={testId}
      className={classNames(
        'relative flex min-h-0 flex-1 flex-col transition-colors',
        isOver && 'rounded-xl bg-muted ring-1 ring-inset ring-focus/50',
      )}
    >
      <div
        data-testid={`${testId}-viewport`}
        className="min-h-0 w-full flex-1 overflow-y-auto overscroll-y-contain pr-1.5"
      >
        <div
          data-testid={`${testId}-content`}
          className="w-full space-y-2 px-2 pb-2 pt-2"
        >
          {isOver && dragHint ? (
            <div
              data-testid={`${testId.replace('-dropzone-', '-drag-hint-')}`}
              className="pointer-events-none sticky top-0 z-20 rounded-lg border border-border bg-background/95 px-2 py-1.5 text-center text-xs font-medium text-text-secondary shadow-sm"
            >
              {dragHint}
            </div>
          ) : null}
          {children}
        </div>
      </div>
    </div>
  )
}

export function KanbanColumnEmptyState({
  emptyState,
  testId,
  renderAddIcon,
}: {
  emptyState: KanbanEmptyState
  testId: string
  renderAddIcon(): ReactNode
}) {
  return emptyState.action ? (
    <ControlButton
      variant="outline"
      size="sm"
      type="button"
      data-testid={testId}
      onClick={emptyState.action.onClick}
      className="flex min-h-24 w-full flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-border px-4 text-center text-text-muted transition hover:border-text-muted hover:bg-background hover:text-text-primary focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/30"
      aria-label={emptyState.action.ariaLabel}
    >
      {renderAddIcon()}
      <span className="text-sm font-medium text-text-secondary">
        {emptyState.action.label}
      </span>
      <span className="text-xs leading-4">{emptyState.hint}</span>
    </ControlButton>
  ) : (
    <div className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-xs text-text-muted">
      {emptyState.hint}
    </div>
  )
}

interface KanbanColumnProps<TColumn, TItem> extends Omit<
  KanbanBoardProps<TColumn, TItem>,
  'columns'
> {
  column: TColumn
}

export function KanbanColumn<TColumn, TItem>({
  activeDragItemId,
  column,
  dropIdPrefix,
  getColumnDotClassName,
  getColumnDragHint,
  getColumnEmptyState,
  getColumnItems,
  getColumnKey,
  getColumnLabel,
  getColumnWidthClassName,
  getItemKey,
  renderAddIcon,
  renderColumnFooter,
  renderColumnHeaderActions,
  renderItem,
  renderItemsFooter,
  testIdPrefix,
}: KanbanColumnProps<TColumn, TItem>) {
  const columnKey = getColumnKey(column)
  const columnItems = getColumnItems(column)
  const emptyState =
    columnItems.length === 0
      ? getColumnEmptyState(column, columnItems)
      : undefined

  return (
    <section
      data-testid={`${testIdPrefix}-column-${columnKey}`}
      className={classNames(
        'group flex max-h-full shrink-0 flex-col rounded-2xl bg-muted p-0.5 transition-[width]',
        getColumnWidthClassName(column),
        activeDragItemId !== null &&
          'outline-dashed outline-1 -outline-offset-1 outline-border',
      )}
    >
      <header className="flex items-center justify-between px-2.5 pb-2 pt-1.5">
        <span className="flex min-w-0 items-center">
          <span
            className={classNames(
              'mr-2 h-2 w-2 rounded-full',
              getColumnDotClassName(column),
            )}
          />
          <span className="text-sm font-semibold">
            {getColumnLabel(column)}
          </span>
          <span className="ml-2 text-xs text-text-muted">
            {columnItems.length}
          </span>
        </span>
        <span className="flex items-center gap-1">
          {renderColumnHeaderActions?.(column, columnItems)}
        </span>
      </header>
      <KanbanColumnDropzone
        dropId={`${dropIdPrefix}${columnKey}`}
        testId={`${testIdPrefix}-column-dropzone-${columnKey}`}
        dragHint={getColumnDragHint(column)}
      >
        {columnItems.map((item) => (
          <Fragment key={getItemKey(item)}>{renderItem(item, column)}</Fragment>
        ))}
        {renderItemsFooter?.(column, columnItems)}
        {emptyState ? (
          <KanbanColumnEmptyState
            emptyState={emptyState}
            testId={`${testIdPrefix}-column-empty-add-${columnKey}`}
            renderAddIcon={renderAddIcon}
          />
        ) : null}
      </KanbanColumnDropzone>
      {renderColumnFooter?.(column, columnItems)}
    </section>
  )
}

export function KanbanBoard<TColumn, TItem>({
  columns,
  onDragStart,
  onDrop,
  onDragCancel,
  ...columnProps
}: KanbanBoardProps<TColumn, TItem>) {
  return (
    <ProjectBoardTransfer
      onDragStart={onDragStart}
      onDragCancel={onDragCancel}
      onDrop={onDrop}
    >
      <div className="flex h-full min-h-0 w-max min-w-full items-start gap-3.5 px-6">
        {columns.map((column) => (
          <KanbanColumn
            {...columnProps}
            column={column}
            key={columnProps.getColumnKey(column)}
          />
        ))}
      </div>

    </ProjectBoardTransfer>
  )
}
