import { useDraggable, useDroppable } from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import { Archive, CalendarDays, ChevronRight, Ellipsis, Flag, ListTodo, Plus } from 'lucide-react'
import { useState } from 'react'
import type { CloudLoopItem } from '@/api/deliveries'
import { cn } from '@/lib/utils'
import { memberAvatarClasses, priorityBadgeClasses } from './todoShared'

export interface BoardCardDisplaySettings {
  showAssignee: boolean
  showPriority: boolean
  showTags: boolean
  showDate: boolean
}

const priorityLabels: Record<CloudLoopItem['priority'], string> = {
  none: '普通',
  low: '低',
  medium: '中',
  high: '高',
  urgent: '紧急',
}

interface CloudTodoCardContentProps {
  item: CloudLoopItem
  display: BoardCardDisplaySettings
}

export function CloudTodoCardContent({ item, display }: CloudTodoCardContentProps) {
  const tags = item.tags ?? []
  const showFooter = display.showPriority || display.showDate || display.showAssignee

  return (
    <>
      <span className="line-clamp-1 pr-5 text-base font-medium leading-5 text-text-primary">
        {item.title}
      </span>
      {item.description ? (
        <span className="mt-1 line-clamp-2 text-sm leading-[18px] text-text-secondary">
          {item.description}
        </span>
      ) : null}

      {display.showTags && tags.length > 0 ? (
        <span className="mt-3 flex min-w-0 items-center gap-1.5 overflow-hidden">
          {tags.slice(0, 2).map((tag, index) => (
            <span
              key={tag}
              className={cn(
                'inline-flex h-5 max-w-28 shrink-0 items-center truncate rounded-md px-2 text-xs',
                index === 0
                  ? 'bg-violet-500/10 text-violet-700 dark:text-violet-300'
                  : 'bg-sky-500/10 text-sky-700 dark:text-sky-300'
              )}
            >
              {tag}
            </span>
          ))}
          {tags.length > 2 ? (
            <span className="shrink-0 text-xs text-text-muted">+{tags.length - 2}</span>
          ) : null}
        </span>
      ) : null}

      {showFooter ? (
        <span className="mt-3 flex min-h-6 items-center gap-3 border-t border-border/60 pt-2.5 text-xs text-text-muted">
          {display.showPriority ? (
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5',
                priorityBadgeClasses[item.priority]
              )}
            >
              <Flag className="h-3 w-3" />
              {priorityLabels[item.priority]}
            </span>
          ) : null}
          {display.showDate ? (
            <span className="inline-flex items-center gap-1">
              <CalendarDays className="h-3 w-3" />
              {(item.due_at ?? item.updated_at).slice(5, 10)}
            </span>
          ) : null}
          {display.showAssignee ? (
            item.assignee_name ? (
              <span className="ml-auto inline-flex min-w-0 items-center gap-1.5">
                <span className="sr-only">负责人</span>
                <span className="sr-only">{item.assignee_name}</span>
                <span
                  data-testid={`cloud-todo-card-assignee-avatar-${item.id}`}
                  title={item.assignee_name}
                  className={cn(
                    'flex h-6 w-6 shrink-0 items-center justify-center rounded-full font-semibold text-background',
                    memberAvatarClasses[0]
                  )}
                >
                  {item.assignee_name.slice(0, 1).toUpperCase()}
                </span>
              </span>
            ) : (
              <span className="ml-auto">未指定</span>
            )
          ) : null}
        </span>
      ) : null}
    </>
  )
}

interface CloudTodoBoardCardProps {
  item: CloudLoopItem
  childCount: number
  onClick: () => void
  onAddChild: () => void
  onOpenChildren: () => void
  onArchive: () => void
  display: BoardCardDisplaySettings
  dragDisabled?: boolean
  archiveDisabled?: boolean
}

export function CloudTodoBoardCard({
  item,
  childCount,
  onClick,
  onAddChild,
  onOpenChildren,
  onArchive,
  display,
  dragDisabled = false,
  archiveDisabled = false,
}: CloudTodoBoardCardProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    transform,
    isDragging,
  } = useDraggable({
    id: item.id,
    disabled: item.can_edit === false || dragDisabled,
  })
  const { isOver, setNodeRef: setDropRef } = useDroppable({ id: `todo-card:${item.id}` })

  return (
    <article
      ref={node => {
        setDragRef(node)
        setDropRef(node)
      }}
      data-testid={`cloud-todo-card-drop-${item.id}`}
      style={{ transform: CSS.Translate.toString(transform) }}
      className={cn(
        'group relative w-full touch-none overflow-hidden rounded-xl border border-border bg-background text-left shadow-sm transition hover:-translate-y-px hover:border-text-primary/15 hover:shadow-md',
        isDragging && 'opacity-25 shadow-none',
        isOver && !isDragging && 'border-focus ring-1 ring-focus/50'
      )}
    >
      {item.can_edit !== false && !archiveDisabled ? (
        <div className="absolute right-2 top-2 z-20">
          <button
            type="button"
            data-testid={`cloud-todo-card-more-${item.id}`}
            onClick={event => {
              event.stopPropagation()
              setMenuOpen(current => !current)
            }}
            className="flex h-7 w-7 items-center justify-center rounded-md bg-background/90 text-text-muted opacity-0 shadow-sm transition hover:text-text-primary focus:opacity-100 group-hover:opacity-100"
            aria-label="任务操作"
            aria-expanded={menuOpen}
          >
            <Ellipsis className="h-3.5 w-3.5" />
          </button>
          {menuOpen ? (
            <div
              data-testid={`cloud-todo-card-menu-${item.id}`}
              className="absolute right-0 top-8 w-32 rounded-lg border border-border bg-background p-1 shadow-md"
            >
              <button
                type="button"
                data-testid={`cloud-todo-card-archive-${item.id}`}
                onClick={event => {
                  event.stopPropagation()
                  setMenuOpen(false)
                  onArchive()
                }}
                className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-xs text-red-600 hover:bg-muted"
              >
                <Archive className="h-3.5 w-3.5" />
                归档任务
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      <button
        type="button"
        data-testid={`cloud-todo-card-${item.id}`}
        disabled={item.can_view_detail === false}
        onClick={onClick}
        className="w-full px-3.5 pb-3 pt-3.5 text-left disabled:cursor-default"
        {...listeners}
        {...attributes}
      >
        <CloudTodoCardContent item={item} display={display} />
      </button>

      <div className="relative border-t border-dashed border-text-primary/15 bg-muted/30 px-3.5 py-2 transition-colors hover:bg-muted/50 focus-within:bg-muted/50 before:pointer-events-none before:absolute before:-left-2 before:-top-2 before:z-10 before:h-4 before:w-4 before:rounded-full before:bg-muted after:pointer-events-none after:absolute after:-right-2 after:-top-2 after:z-10 after:h-4 after:w-4 after:rounded-full after:bg-muted">
        {childCount > 0 ? (
          <div className="flex items-center gap-3">
            <button
              type="button"
              data-testid={`cloud-todo-open-children-${item.id}`}
              onClick={onOpenChildren}
              className="flex h-8 min-w-0 flex-1 items-center gap-1.5 px-0.5 text-xs font-medium text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/50"
            >
              <ListTodo className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">子任务 </span>
              <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-text-primary/5 px-1 text-xs font-medium text-text-secondary">
                {childCount}
              </span>
              <ChevronRight className="ml-auto h-3.5 w-3.5 shrink-0" />
            </button>
            <button
              type="button"
              data-testid={`cloud-todo-card-add-child-${item.id}`}
              disabled={item.can_edit === false}
              onClick={onAddChild}
              className="flex h-7 shrink-0 items-center gap-1 border-l border-border/60 pl-3 text-xs text-text-muted transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/50 disabled:hidden"
              aria-label="新建子任务"
              title="新建子任务"
            >
              <Plus className="h-3.5 w-3.5" />
              添加子任务
            </button>
          </div>
        ) : (
          <button
            type="button"
            data-testid={`cloud-todo-card-add-child-${item.id}`}
            disabled={item.can_edit === false}
            onClick={onAddChild}
            className="flex h-7 w-full items-center gap-1.5 rounded-md px-1 text-xs text-text-muted transition hover:bg-muted hover:text-text-primary disabled:hidden"
          >
            <Plus className="h-3.5 w-3.5" />
            新建子任务
          </button>
        )}
      </div>
    </article>
  )
}
