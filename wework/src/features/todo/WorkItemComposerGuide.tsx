import { ArrowUpRight, Check, ChevronDown, LayoutDashboard, ListChecks, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import { useAnchoredPortalMenu } from '@/hooks/useAnchoredPortalMenu'
import { useOutsideClick } from '@/components/chat/composer/useOutsideClick'
import type { ProjectSpaceApi } from '@/features/todo/projectSpaceSelection'
import { useTranslation } from '@/hooks/useTranslation'
import type { RuntimeTaskAddress } from '@/types/api'

type TaskBinding = Awaited<ReturnType<ProjectSpaceApi['listTaskBindings']>>[number]

interface WorkItemComposerGuideProps {
  project?: CloudProject | null
  item?: CloudLoopItem | null
  statusOverride?: CloudLoopItem['status'] | null
  api?: ProjectSpaceApi
  currentTask?: RuntimeTaskAddress | null
  goalPresent?: boolean
  integrated?: boolean
  toolbar?: boolean
  refreshKey?: unknown
  projects?: CloudProject[]
  onSelectProject?: (project: CloudProject) => void
  onRemoveProject?: () => void
  onOpen?: () => void
  onOpenBoard?: () => void
}

const itemStatusLabels: Record<CloudLoopItem['status'], string> = {
  inbox: '待开始',
  pending: '待开始',
  in_progress: '进行中',
  in_review: '等待确认',
  completed: '已完成',
}

function isCurrentBinding(binding: TaskBinding, currentTask?: RuntimeTaskAddress | null): boolean {
  return (
    Boolean(currentTask) &&
    binding.device_id === currentTask?.deviceId &&
    binding.task_id === currentTask.taskId
  )
}

export function WorkItemComposerGuide(props: WorkItemComposerGuideProps) {
  return <WorkItemComposerGuideContent {...props} />
}

function WorkItemComposerGuideContent({
  project,
  item,
  statusOverride,
  api,
  currentTask,
  goalPresent = false,
  integrated = false,
  toolbar = false,
  refreshKey,
  projects = [],
  onSelectProject,
  onRemoveProject,
  onOpen,
  onOpenBoard,
}: WorkItemComposerGuideProps) {
  const { t } = useTranslation('common')
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [refreshedItem, setRefreshedItem] = useState<CloudLoopItem | null>(null)
  const [taskBindings, setTaskBindings] = useState<TaskBinding[] | null>(item ? null : [])
  const closeMenu = useCallback(() => setOpen(false), [])
  const outsideRefs = useMemo(() => [menuRef], [])
  const menuLayout = useAnchoredPortalMenu(open, triggerRef, menuRef, { align: 'end' })

  useOutsideClick(containerRef, open, closeMenu, outsideRefs)

  useEffect(() => {
    if (!open) return
    const trigger = triggerRef.current
    const animationFrame = window.requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    })
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      closeMenu()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.cancelAnimationFrame(animationFrame)
      window.removeEventListener('keydown', handleKeyDown)
      trigger?.focus()
    }
  }, [closeMenu, open])

  useEffect(() => {
    if (!api || !item) return
    let active = true
    void Promise.allSettled([
      api.listTaskBindings(item.id),
      currentTask ? api.findCloudContextForTask(currentTask) : Promise.resolve(null),
    ]).then(([bindingsResult, contextResult]) => {
      if (!active) return
      if (bindingsResult.status === 'fulfilled') setTaskBindings(bindingsResult.value)
      if (contextResult.status === 'fulfilled' && contextResult.value?.loop_item) {
        setRefreshedItem(contextResult.value.loop_item)
      }
    })
    return () => {
      active = false
    }
  }, [api, currentTask, item, refreshKey])

  const resolvedItem = refreshedItem?.id === item?.id ? refreshedItem : (item ?? null)
  const statusLabel = resolvedItem ? itemStatusLabels[statusOverride ?? resolvedItem.status] : null
  const taskCount = taskBindings?.length ?? null
  const otherTaskCount =
    taskBindings == null
      ? null
      : Math.max(
          0,
          taskBindings.length -
            (taskBindings.some(binding => isCurrentBinding(binding, currentTask)) ? 1 : 0)
        )

  const taskSummary =
    taskCount == null
      ? t('workbench.loading_task_count', '任务同步中')
      : taskCount > 1
        ? `${taskCount} 个任务${otherTaskCount ? `，还有 ${otherTaskCount} 个` : ''}`
        : null

  const title = resolvedItem
    ? `${resolvedItem.title} · ${statusLabel}${taskSummary ? ` · ${taskSummary}` : ''}`
    : (project?.name ?? t('workbench.default_work_item_board', '我的任务'))

  const projectMenu =
    open &&
    typeof document !== 'undefined' &&
    createPortal(
      <div
        ref={menuRef}
        role="menu"
        data-testid="work-item-context-menu"
        style={{
          left: menuLayout?.left ?? 0,
          maxHeight: menuLayout?.maxHeight,
          top: menuLayout?.top ?? 0,
          visibility: menuLayout ? 'visible' : 'hidden',
        }}
        className={[
          'fixed z-system-popover max-w-[calc(100vw-2rem)] overflow-y-auto border border-border bg-background shadow-[0_16px_44px_rgba(0,0,0,0.16)]',
          toolbar ? 'w-64 rounded-xl p-1.5' : 'w-[22rem] rounded-2xl p-2',
        ].join(' ')}
      >
        {projects.length > 0 && onSelectProject ? (
          <>
            <div className="px-2 pb-1 pt-1 text-xs font-medium text-text-muted">
              {t('workbench.workspace_label', '工作空间')}
            </div>
            {projects.map(option => {
              const selected =
                option.id === project?.id && option.project_store === project.project_store
              return (
                <button
                  key={`${option.project_store}:${option.id}`}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  data-testid={`work-item-workspace-option-${String(option.id).replace(/[^a-zA-Z0-9_-]/g, '-')}`}
                  onClick={() => {
                    closeMenu()
                    if (!selected || resolvedItem) onSelectProject(option)
                  }}
                  className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2 text-left text-sm text-text-primary hover:bg-muted"
                >
                  <LayoutDashboard className="h-4 w-4 shrink-0 text-text-secondary" />
                  <span className="min-w-0 flex-1 truncate">{option.name}</span>
                  {selected ? <Check className="h-4 w-4 shrink-0" /> : null}
                </button>
              )
            })}
            {onRemoveProject ? (
              <button
                type="button"
                role="menuitem"
                data-testid="clear-project-space-context-button"
                onClick={() => {
                  closeMenu()
                  onRemoveProject()
                }}
                className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2 text-left text-sm text-text-muted hover:bg-muted hover:text-text-primary"
              >
                <X className="h-4 w-4 shrink-0" />
                <span>{t('workbench.clear_extra_project_space', '不加入其他项目空间')}</span>
              </button>
            ) : null}
          </>
        ) : null}
      </div>,
      document.body
    )

  if (resolvedItem) {
    return (
      <div
        ref={containerRef}
        className={toolbar ? 'relative min-w-0 max-w-[12rem] shrink' : 'relative min-w-0 flex-1'}
      >
        <div
          data-testid="project-space-context-pill"
          title={title}
          className={[
            'flex w-full min-w-0 items-center gap-2 overflow-hidden text-sm text-text-secondary',
            toolbar ? 'h-8 rounded-lg px-2' : 'h-9 px-2',
          ].join(' ')}
        >
          <LayoutDashboard
            className={toolbar ? 'h-4 w-4 shrink-0' : 'h-4 w-4 shrink-0 text-primary'}
            aria-hidden="true"
          />
          {!goalPresent ? (
            <span
              data-testid="work-item-guide-summary-title"
              className="min-w-0 truncate font-medium text-text-primary"
            >
              {resolvedItem.title}
            </span>
          ) : (
            <span className="shrink-0 font-medium text-text-primary">
              {t('workbench.linked_work_item_short', '工作空间')}
            </span>
          )}
          <span
            data-testid="work-item-guide-summary-status"
            className="shrink-0 text-xs text-text-muted"
          >
            · {statusLabel}
          </span>
          {taskSummary ? (
            <span
              data-testid="work-item-guide-summary-details"
              className="min-w-0 truncate text-xs text-text-muted"
            >
              · {taskSummary}
            </span>
          ) : null}
          <span className="min-w-1 flex-1" />
          {onOpen ? (
            <button
              type="button"
              data-testid="work-item-open-details"
              onClick={onOpen}
              title={t('workbench.view_work_item_details', '查看 Issue 详情')}
              aria-label={t('workbench.view_work_item_details', '查看 Issue 详情')}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-text-muted transition hover:bg-background/70 hover:text-text-primary"
            >
              <ListChecks className="h-3.5 w-3.5" />
            </button>
          ) : null}
          {onOpenBoard ? (
            <button
              type="button"
              data-testid="work-item-open-board-menu"
              onClick={onOpenBoard}
              title={t('workbench.open_in_work_item_board', '在工作空间中打开')}
              aria-label={t('workbench.open_in_work_item_board', '在工作空间中打开')}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-text-muted transition hover:bg-background/70 hover:text-text-primary"
            >
              <ArrowUpRight className="h-3.5 w-3.5" />
            </button>
          ) : null}
          {projects.length > 0 && onSelectProject ? (
            <button
              ref={triggerRef}
              type="button"
              data-testid="work-item-change-board"
              onClick={() => setOpen(current => !current)}
              title={t('workbench.task_board_change', '更改看板关联')}
              aria-label={t('workbench.task_board_change', '更改看板关联')}
              aria-expanded={open}
              aria-haspopup="menu"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-text-muted transition hover:bg-background/70 hover:text-text-primary"
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
        {projectMenu}
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className={toolbar ? 'relative min-w-0 max-w-[12rem] shrink' : 'relative min-w-0 flex-1'}
    >
      <button
        ref={triggerRef}
        type="button"
        data-testid="project-space-context-pill"
        onClick={() => setOpen(current => !current)}
        className={[
          'group flex w-full min-w-[44px] items-center overflow-hidden text-sm font-normal leading-[18px] text-text-secondary transition-[background-color,color] hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30',
          toolbar ? 'h-8 gap-1.5 rounded-lg px-2 hover:bg-background/70' : 'h-9 gap-2 px-2',
          integrated && !toolbar
            ? 'hover:bg-background/55'
            : !toolbar
              ? 'max-w-[48rem] rounded-xl hover:bg-background/70 hover:shadow-[0_8px_22px_rgba(0,0,0,0.10)]'
              : '',
          open
            ? integrated && !toolbar
              ? 'bg-background/55 text-text-primary'
              : toolbar
                ? 'bg-background/70 text-text-primary'
                : 'bg-background/70 text-text-primary shadow-[0_8px_22px_rgba(0,0,0,0.10)]'
            : '',
        ].join(' ')}
        aria-expanded={open}
        aria-haspopup="menu"
        title={title}
      >
        <LayoutDashboard
          className={toolbar ? 'h-4 w-4 shrink-0' : 'h-4 w-4 shrink-0 text-primary'}
          aria-hidden="true"
        />
        <span className={toolbar ? 'min-w-0 truncate' : 'min-w-0 truncate font-medium'}>
          {project?.name ?? t('workbench.default_work_item_board', '我的任务')}
        </span>
        <ChevronDown
          className={toolbar ? 'h-4 w-4 shrink-0' : 'ml-auto h-4 w-4 shrink-0 text-text-muted'}
          aria-hidden="true"
        />
      </button>

      {projectMenu}
    </div>
  )
}
