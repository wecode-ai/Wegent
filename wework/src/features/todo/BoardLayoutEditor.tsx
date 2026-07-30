import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  horizontalListSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Check, ChevronDown, Clock3, GripVertical, Pencil, Plus, Tag, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { CloudProject } from '@/api/deliveries'
import { ActionMenu } from '@/components/common/ActionMenu'
import { cn } from '@/lib/utils'
import type { BoardCardDisplaySettings } from './CloudTodoWorkspace'

type BoardStatus = NonNullable<CloudProject['board_config']>['statuses'][number]

const statusDotClasses: Record<BoardStatus['color'], string> = {
  gray: 'bg-zinc-400',
  blue: 'bg-blue-500',
  orange: 'bg-amber-500',
  purple: 'bg-violet-500',
  green: 'bg-emerald-500',
  red: 'bg-red-500',
}

const newStatusColors: BoardStatus['color'][] = ['gray', 'blue', 'orange', 'purple', 'green', 'red']

interface SortableStatusProps {
  status: BoardStatus
  previewDisplay?: BoardCardDisplaySettings
  busy: boolean
  renaming: boolean
  onRename: () => void
  onRenameCommit: (name: string) => void
  onDelete: () => void
}

function SortableStatus({
  status,
  previewDisplay,
  busy,
  renaming,
  onRename,
  onRenameCommit,
  onDelete,
}: SortableStatusProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver } =
    useSortable({ id: status.id, disabled: busy || renaming })
  return (
    <article
      ref={setNodeRef}
      data-testid={`cloud-board-status-${status.id}`}
      className={cn(
        'group/status min-h-36 min-w-32 rounded-xl border p-2 transition-colors',
        isOver && !isDragging
          ? 'border-border bg-background'
          : 'border-transparent hover:bg-background/70',
        isDragging && 'opacity-30'
      )}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <header className="flex h-7 min-w-0 items-center gap-1">
        <button
          type="button"
          data-testid={`cloud-board-status-drag-${status.id}`}
          disabled={busy || renaming}
          className="flex h-6 w-5 shrink-0 touch-none items-center justify-center rounded-md text-text-muted hover:bg-muted hover:text-text-primary disabled:cursor-default"
          aria-label={`拖动状态 ${status.name}`}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-3.5 w-3.5" />
        </button>
        <span className={cn('h-2 w-2 shrink-0 rounded-full', statusDotClasses[status.color])} />
        {renaming ? (
          <input
            data-testid={`cloud-board-status-name-${status.id}`}
            autoFocus
            defaultValue={status.name}
            onBlur={event => onRenameCommit(event.currentTarget.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') event.currentTarget.blur()
              if (event.key === 'Escape') {
                event.currentTarget.value = status.name
                event.currentTarget.blur()
              }
            }}
            className="h-6 min-w-0 flex-1 rounded-md border border-border bg-background px-1.5 text-xs outline-none focus:border-focus"
            aria-label="状态名称"
          />
        ) : (
          <span className="min-w-0 flex-1 truncate text-xs font-medium">{status.name}</span>
        )}
        {!renaming && (
          <ActionMenu
            ariaLabel={`${status.name}状态菜单`}
            testId={`cloud-board-status-menu-${status.id}`}
            placement="bottom-end"
            triggerClassName="flex h-6 w-6 items-center justify-center rounded-md text-text-muted opacity-0 hover:bg-muted hover:text-text-primary focus-visible:opacity-100 group-hover/status:opacity-100"
            items={[
              {
                label: '重命名',
                icon: Pencil,
                onSelect: onRename,
                testId: `cloud-board-status-rename-${status.id}`,
                disabled: busy,
              },
              {
                label: '删除状态',
                icon: Trash2,
                onSelect: onDelete,
                testId: `cloud-board-status-delete-${status.id}`,
                danger: true,
                disabled: busy,
              },
            ]}
          />
        )}
      </header>
      {previewDisplay ? (
        <PreviewCard display={previewDisplay} />
      ) : (
        <>
          <div className="mt-3 h-1.5 rounded-full bg-border/70" />
          <div className="mt-2 h-1.5 w-3/5 rounded-full bg-border/70" />
        </>
      )}
    </article>
  )
}

function PreviewCard({ display }: { display: BoardCardDisplaySettings }) {
  return (
    <div className="mt-2.5 rounded-lg border border-border bg-background p-2.5 shadow-sm">
      <p className="text-xs font-medium leading-4">补充项目管理页的空状态</p>
      {display.showTags && (
        <span className="mt-2 inline-flex h-5 items-center gap-1 rounded-md bg-muted px-1.5 text-xs text-text-secondary">
          <Tag className="h-3 w-3" />
          产品需求
        </span>
      )}
      <div className="mt-2 flex min-h-5 items-center gap-1.5 text-xs text-text-muted">
        {display.showPriority && <span>中优先级</span>}
        {display.showDate && (
          <span className="flex items-center gap-1">
            <Clock3 className="h-3 w-3" />
            刚刚
          </span>
        )}
        {display.showAssignee && (
          <span className="ml-auto flex h-5 w-5 items-center justify-center rounded-full bg-text-primary text-xs text-background">
            林
          </span>
        )}
      </div>
    </div>
  )
}

export function BoardLayoutEditor({
  statuses,
  display,
  statusBusy,
  displayBusy,
  canEditStatuses,
  onStatusesChange,
  onDisplayChange,
}: {
  statuses: BoardStatus[]
  display: BoardCardDisplaySettings
  statusBusy: boolean
  displayBusy: boolean
  canEditStatuses: boolean
  onStatusesChange: (statuses: BoardStatus[]) => void
  onDisplayChange: (key: keyof BoardCardDisplaySettings, checked: boolean) => void
}) {
  const [activeId, setActiveId] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [fieldsOpen, setFieldsOpen] = useState(false)
  const fieldsRef = useRef<HTMLDivElement>(null)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  useEffect(() => {
    if (!fieldsOpen) return
    const close = (event: PointerEvent) => {
      if (!fieldsRef.current?.contains(event.target as Node)) setFieldsOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [fieldsOpen])

  function handleDragEnd({ active, over }: DragEndEvent) {
    setActiveId(null)
    if (!over || active.id === over.id) return
    const oldIndex = statuses.findIndex(status => status.id === active.id)
    const newIndex = statuses.findIndex(status => status.id === over.id)
    if (oldIndex < 0 || newIndex < 0) return
    onStatusesChange(arrayMove(statuses, oldIndex, newIndex))
  }

  function addStatus() {
    const id = `status-${Date.now().toString(36)}`
    onStatusesChange([
      ...statuses,
      {
        id,
        name: '新状态',
        color: newStatusColors[statuses.length % newStatusColors.length],
      },
    ])
  }

  const activeStatus = statuses.find(status => status.id === activeId)
  const displayOptions = [
    ['showAssignee', '负责人'],
    ['showPriority', '优先级'],
    ['showTags', '标签'],
    ['showDate', '更新时间'],
  ] as const

  return (
    <section
      data-testid="cloud-project-board-layout-settings"
      className="border-t border-border py-6"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-heading-md font-semibold">看板布局</h2>
          <p className="mt-1 text-sm text-text-muted">
            {canEditStatuses
              ? '拖动状态调整顺序，选择任务卡上需要显示的信息。'
              : '选择任务卡上需要显示的信息。'}
          </p>
        </div>
        <div ref={fieldsRef} className="relative shrink-0">
          <button
            type="button"
            data-testid="cloud-board-display-menu"
            disabled={displayBusy}
            aria-expanded={fieldsOpen}
            onClick={() => setFieldsOpen(open => !open)}
            className="flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-sm hover:bg-muted disabled:opacity-50"
          >
            显示字段
            <ChevronDown className="h-3.5 w-3.5 text-text-muted" />
          </button>
          {fieldsOpen && (
            <div
              data-testid="cloud-project-card-display-settings"
              className="absolute right-0 top-10 z-20 w-44 rounded-xl border border-border bg-background p-1.5 shadow-lg"
              role="menu"
            >
              <p className="px-2 py-1 text-xs text-text-muted">任务卡显示</p>
              {displayOptions.map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={display[key]}
                  data-testid={`cloud-board-display-${key.replace('show', '').toLowerCase()}`}
                  disabled={displayBusy}
                  onClick={() => onDisplayChange(key, !display[key])}
                  className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm hover:bg-muted disabled:opacity-50"
                >
                  <span
                    className={cn(
                      'flex h-4 w-4 items-center justify-center rounded border',
                      display[key]
                        ? 'border-text-primary bg-text-primary text-background'
                        : 'border-border'
                    )}
                  >
                    {display[key] && <Check className="h-3 w-3" />}
                  </span>
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="mt-4 overflow-x-auto rounded-2xl bg-muted p-2.5">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={({ active }: DragStartEvent) => setActiveId(String(active.id))}
          onDragCancel={() => setActiveId(null)}
          onDragEnd={handleDragEnd}
        >
          <div className="flex min-w-max items-start gap-2">
            <SortableContext
              items={statuses.map(status => status.id)}
              strategy={horizontalListSortingStrategy}
            >
              {statuses.map((status, index) => (
                <div key={status.id} className="w-36 shrink-0">
                  <SortableStatus
                    status={status}
                    previewDisplay={
                      index === Math.min(1, statuses.length - 1) ? display : undefined
                    }
                    busy={statusBusy || !canEditStatuses}
                    renaming={renamingId === status.id}
                    onRename={() => setRenamingId(status.id)}
                    onRenameCommit={name => {
                      setRenamingId(null)
                      const normalized = name.trim()
                      if (!normalized || normalized === status.name) return
                      onStatusesChange(
                        statuses.map(item =>
                          item.id === status.id ? { ...item, name: normalized } : item
                        )
                      )
                    }}
                    onDelete={() =>
                      onStatusesChange(statuses.filter(item => item.id !== status.id))
                    }
                  />
                </div>
              ))}
            </SortableContext>
            {statuses.length === 0 && (
              <div className="w-56 shrink-0 rounded-xl bg-background/70 p-2">
                <p className="px-0.5 text-xs font-medium">任务卡预览</p>
                <PreviewCard display={display} />
              </div>
            )}
            {canEditStatuses && (
              <button
                type="button"
                data-testid="cloud-board-status-add"
                disabled={statusBusy}
                onClick={addStatus}
                className="mt-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-dashed border-border text-text-muted hover:bg-background hover:text-text-primary disabled:opacity-50"
                aria-label="新增状态"
              >
                <Plus className="h-4 w-4" />
              </button>
            )}
          </div>
          <DragOverlay dropAnimation={null}>
            {activeStatus ? (
              <div className="flex h-10 w-36 items-center gap-2 rounded-xl border border-border bg-background px-3 text-xs font-medium shadow-lg">
                <GripVertical className="h-3.5 w-3.5 text-text-muted" />
                <span
                  className={cn('h-2 w-2 rounded-full', statusDotClasses[activeStatus.color])}
                />
                <span className="truncate">{activeStatus.name}</span>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>
      <p className="mt-2 text-xs text-text-muted">设置会同步给所有项目成员。</p>
    </section>
  )
}
