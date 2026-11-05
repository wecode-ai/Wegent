import { Fragment, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, GitBranch, ArrowRight, Plus } from 'lucide-react'
import {
  KanbanColumnDropzone,
  KanbanColumnEmptyState,
  type KanbanBoardProps,
} from '../kanban/KanbanBoard'
import { projectBoardRowDropId } from './projectBoardDnd'
import type { ProjectBoardColumn } from './ProjectBoardBody'
import type { ProjectBoardParentRow } from './parentBoardGrouping'
import type { CollaborationTranslate } from '../i18n'

export interface ProjectBoardParentRowsProps<T> {
  scopeKey?: string
  rows: readonly ProjectBoardParentRow<T>[]
  translate: CollaborationTranslate
  getParentTitle(item: T): string
  getParentKey(item: T): string
  renderParentMetadata?(item: T): ReactNode
  onOpenParent(item: T): void
  onEnterParent(item: T): void
}

export function ProjectBoardParentRows<T>({
  rows,
  currentParentId,
  translate: t,
  getParentTitle,
  getParentKey,
  renderParentMetadata,
  onOpenParent,
  onEnterParent,
  columns,
  dnd,
  dndContextProps,
  getItemKey,
  renderItem,
  renderDragOverlay,
  getColumnWidthClassName,
  renderColumnHeaderActions,
  getColumnDragHint,
  renderColumnFooter,
  getColumnEmptyState,
}: ProjectBoardParentRowsProps<T> &
  Pick<
    KanbanBoardProps<ProjectBoardColumn, T>,
    | 'columns'
    | 'dnd'
    | 'dndContextProps'
    | 'getItemKey'
    | 'renderItem'
    | 'renderDragOverlay'
    | 'getColumnWidthClassName'
    | 'renderColumnHeaderActions'
    | 'getColumnDragHint'
    | 'renderColumnFooter'
    | 'getColumnEmptyState'
  > & { currentParentId: string | null }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const { DndContext, DragOverlay } = dnd
  const columnItems = (column: ProjectBoardColumn) => [
    ...new Map(
      rows.flatMap(row => row.items.get(column.key) ?? []).map(item => [getItemKey(item), item])
    ).values(),
  ]
  const cells = (render: (column: ProjectBoardColumn) => ReactNode) =>
    columns.map(column => (
      <div key={column.key} className={`min-w-0 shrink-0 ${getColumnWidthClassName(column)}`}>
        {render(column)}
      </div>
    ))
  return (
    <DndContext {...dndContextProps}>
      <div data-testid="cloud-board-parent-rows" className="h-full overflow-y-auto px-6">
        <div className="min-w-full w-max">
          <div className="sticky top-0 z-20 flex gap-3.5 border-b border-border bg-background py-3">
            {cells(column => {
              const items = columnItems(column)
              const emptyState = items.length === 0 ? getColumnEmptyState(column, items) : undefined
              return (
                <>
                  <div className="group flex items-center gap-2 px-3 text-sm font-medium">
                    <span className={`h-2 w-2 rounded-full ${column.dotClass}`} />
                    {column.label}
                    <span className="ml-auto text-xs text-text-muted">
                      {rows.reduce(
                        (count, row) => count + (row.items.get(column.key)?.length ?? 0),
                        0
                      )}
                    </span>
                    {renderColumnHeaderActions?.(column, items)}
                  </div>
                  {emptyState?.action ? (
                    <div className="mt-3">
                      <KanbanColumnEmptyState
                        emptyState={emptyState}
                        testId={`cloud-todo-column-empty-add-${column.key}`}
                        renderAddIcon={() => <Plus className="h-5 w-5" />}
                      />
                    </div>
                  ) : null}
                  {renderColumnFooter?.(column, items)}
                </>
              )
            })}
          </div>
          {rows.length === 0 ? (
            <p className="p-6 text-sm text-text-muted">{t('todo.parent_board_empty')}</p>
          ) : null}
          {rows.map(row => (
            <section
              key={row.key}
              data-testid={`cloud-board-parent-row-${row.parentId ?? 'root'}`}
              className="border-b border-border pb-3"
            >
              <header className="sticky left-0 flex w-fit max-w-full items-center gap-2 bg-background py-3">
                <button
                  type="button"
                  data-testid={`cloud-board-parent-toggle-${row.key}`}
                  aria-expanded={!collapsed.has(row.key)}
                  aria-label={t('todo.parent_board_toggle')}
                  onClick={() =>
                    setCollapsed(current => {
                      const next = new Set(current)
                      if (next.has(row.key)) next.delete(row.key)
                      else next.add(row.key)
                      return next
                    })
                  }
                  className="flex h-7 w-7 items-center justify-center rounded-lg text-text-muted hover:bg-muted max-md:h-11 max-md:w-11"
                >
                  {collapsed.has(row.key) ? (
                    <ChevronRight className="h-4 w-4" />
                  ) : (
                    <ChevronDown className="h-4 w-4" />
                  )}
                </button>
                {row.parent ? (
                  <>
                    <button
                      type="button"
                      data-testid={`cloud-board-parent-open-${getParentKey(row.parent)}`}
                      onClick={() => onOpenParent(row.parent!)}
                      title={getParentTitle(row.parent)}
                      className="max-w-64 truncate rounded-lg px-1 py-1 text-left text-sm font-medium hover:text-focus max-md:min-h-11"
                    >
                      {getParentTitle(row.parent)}
                    </button>
                    {renderParentMetadata?.(row.parent)}
                    <span
                      className="text-xs text-text-muted"
                      title={t('todo.parent_board_progress_hint')}
                    >
                      {t('todo.parent_board_progress', undefined, {
                        completed: row.completed,
                        total: row.total,
                      })}
                    </span>
                    {row.running > 1 ? (
                      <span
                        data-testid={`cloud-board-parent-parallel-${getParentKey(row.parent)}`}
                        className="flex items-center gap-1 text-xs text-text-secondary"
                      >
                        <GitBranch className="h-3.5 w-3.5" />
                        {t('todo.parent_board_parallel', undefined, {
                          count: row.running,
                        })}
                      </span>
                    ) : null}
                    <button
                      type="button"
                      data-testid={`cloud-board-parent-enter-${getParentKey(row.parent)}`}
                      aria-label={t('todo.parent_board_enter')}
                      title={t('todo.parent_board_enter')}
                      onClick={() => onEnterParent(row.parent!)}
                      className="flex h-7 w-7 items-center justify-center rounded-lg text-text-muted hover:bg-muted max-md:h-11 max-md:w-11"
                    >
                      <ArrowRight className="h-4 w-4" />
                    </button>
                  </>
                ) : (
                  <span className="text-sm text-text-secondary">
                    {t(
                      row.parentId === null
                        ? 'todo.parent_board_standalone'
                        : row.parentId === currentParentId
                          ? 'todo.parent_board_direct_children'
                          : 'todo.parent_board_other'
                    )}
                  </span>
                )}
              </header>
              {!collapsed.has(row.key) ? (
                <div className="flex items-stretch gap-3.5">
                  {cells(column => (
                    <div className="flex min-h-28 flex-col rounded-2xl bg-muted p-0.5">
                      <KanbanColumnDropzone
                        dnd={dnd}
                        dropId={projectBoardRowDropId(row.parentId, column.key)}
                        testId={`cloud-board-parent-cell-${row.parentId ?? 'root'}-${column.key}`}
                        dragHint={getColumnDragHint(column)}
                      >
                        {(row.items.get(column.key) ?? []).map(item => (
                          <Fragment key={getItemKey(item)}>{renderItem(item, column)}</Fragment>
                        ))}
                      </KanbanColumnDropzone>
                    </div>
                  ))}
                </div>
              ) : null}
            </section>
          ))}
        </div>
      </div>
      <DragOverlay dropAnimation={null}>{renderDragOverlay()}</DragOverlay>
    </DndContext>
  )
}
