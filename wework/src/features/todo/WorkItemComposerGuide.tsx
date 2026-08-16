import {
  ArrowUpRight,
  Check,
  ChevronDown,
  LayoutDashboard,
  Link2,
  ListChecks,
  ListTodo,
  Plus,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CloudLoopItem } from '@/api/deliveries'
import { useAnchoredPortalMenu } from '@/components/chat/composer/useAnchoredPortalMenu'
import { useOutsideClick } from '@/components/chat/composer/useOutsideClick'
import type { ProjectSpaceApi } from '@/features/todo/projectSpaceSelection'
import { useTranslation } from '@/hooks/useTranslation'
import type { RuntimeTaskAddress } from '@/types/api'

type TaskBinding = Awaited<ReturnType<ProjectSpaceApi['listTaskBindings']>>[number]

interface WorkItemComposerGuideProps {
  item?: CloudLoopItem | null
  api?: ProjectSpaceApi
  currentTask?: RuntimeTaskAddress | null
  bindingPending?: boolean
  goalPresent?: boolean
  integrated?: boolean
  refreshKey?: unknown
  onJoinExisting?: () => void
  onOpen?: () => void
  onOpenBoard?: () => void
  onOpenTask?: (task: RuntimeTaskAddress) => void | Promise<void>
  onCancel?: () => void
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

export function WorkItemComposerGuide({
  item,
  api,
  currentTask,
  bindingPending = false,
  goalPresent = false,
  integrated = false,
  refreshKey,
  onJoinExisting,
  onOpen,
  onOpenBoard,
  onOpenTask,
  onCancel,
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
  const statusLabel = resolvedItem ? itemStatusLabels[resolvedItem.status] : null
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
    : t('workbench.work_item_create_title', '工作空间：新建')

  return (
    <div ref={containerRef} className="relative min-w-0 flex-1">
      <button
        ref={triggerRef}
        type="button"
        data-testid="project-space-context-pill"
        onClick={() => setOpen(current => !current)}
        className={[
          'group flex h-9 w-full min-w-[44px] items-center gap-2 overflow-hidden px-2 text-sm font-normal leading-[18px] text-text-secondary transition-[background-color,color] hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30',
          integrated
            ? 'hover:bg-background/55'
            : 'max-w-[48rem] rounded-xl hover:bg-background/70 hover:shadow-[0_8px_22px_rgba(0,0,0,0.10)]',
          open
            ? integrated
              ? 'bg-background/55 text-text-primary'
              : 'bg-background/70 text-text-primary shadow-[0_8px_22px_rgba(0,0,0,0.10)]'
            : '',
        ].join(' ')}
        aria-expanded={open}
        aria-haspopup="menu"
        title={title}
      >
        <LayoutDashboard className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
        {resolvedItem ? (
          <>
            {!goalPresent ? (
              <span
                data-testid="work-item-guide-summary-title"
                className="min-w-0 truncate font-medium text-text-primary"
              >
                {resolvedItem.title}
              </span>
            ) : (
              <span className="shrink-0 font-medium text-text-primary">
                {t('workbench.work_item_label', '工作空间')}
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
          </>
        ) : bindingPending ? (
          <>
            <span className="shrink-0 font-medium text-text-primary">
              {t('workbench.work_item_label', '工作空间')}
            </span>
            <span
              data-testid="work-item-guide-summary-pending"
              className="min-w-0 truncate text-xs text-text-muted"
            >
              · {t('workbench.work_item_binding_pending', '正在关联')}
            </span>
          </>
        ) : (
          <span className="min-w-0 truncate font-medium text-text-primary">
            {t('workbench.work_item_create_title', '工作空间：新建')}
          </span>
        )}
        <ChevronDown className="ml-auto h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
      </button>

      {open &&
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
            className="fixed z-system-popover w-[22rem] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-2xl border border-border bg-background p-2 shadow-[0_16px_44px_rgba(0,0,0,0.16)]"
          >
            {resolvedItem ? (
              <>
                <div className="px-2 pb-2 pt-1">
                  <div className="truncate text-sm font-semibold text-text-primary">
                    {resolvedItem.title}
                  </div>
                  <div className="mt-1 text-xs text-text-muted">
                    {statusLabel}
                    {taskCount != null ? ` · ${taskCount} 个任务` : ''}
                  </div>
                </div>

                {taskBindings && taskBindings.length > 0 ? (
                  <>
                    <div className="my-1 h-px bg-border" />
                    <div className="px-2 pb-1 pt-1 text-xs font-medium text-text-muted">
                      {t('workbench.tasks_in_work_item', '同一工作空间中的任务')}
                    </div>
                    {taskBindings.map(binding => {
                      const current = isCurrentBinding(binding, currentTask)
                      return (
                        <button
                          key={binding.id}
                          type="button"
                          role="menuitem"
                          data-testid={`work-item-task-${binding.id}`}
                          disabled={current || !onOpenTask}
                          onClick={() => {
                            closeMenu()
                            void onOpenTask?.({
                              deviceId: binding.device_id,
                              taskId: binding.task_id,
                            })
                          }}
                          className="flex min-h-10 w-full items-center gap-2.5 rounded-xl px-2 text-left text-sm text-text-primary hover:bg-muted disabled:cursor-default disabled:opacity-100"
                        >
                          <ListTodo className="h-4 w-4 shrink-0 text-text-secondary" />
                          <span className="min-w-0 flex-1 truncate">
                            {binding.task_title || t('workbench.untitled_task', '未命名任务')}
                          </span>
                          {current ? (
                            <span className="shrink-0 text-xs text-primary">
                              {t('workbench.current_task', '当前任务')}
                            </span>
                          ) : null}
                        </button>
                      )
                    })}
                  </>
                ) : null}

                {onOpen || onOpenBoard ? (
                  <>
                    <div className="my-1 h-px bg-border" />
                    {onOpen ? (
                      <button
                        type="button"
                        role="menuitem"
                        data-testid="work-item-open-details"
                        onClick={() => {
                          closeMenu()
                          onOpen()
                        }}
                        className="flex h-10 w-full items-center gap-2.5 rounded-xl px-2 text-left text-sm text-text-primary hover:bg-muted"
                      >
                        <ListChecks className="h-4 w-4 shrink-0 text-text-secondary" />
                        <span className="min-w-0 flex-1">
                          {t('workbench.view_work_item_details', '查看工作空间详情')}
                        </span>
                      </button>
                    ) : null}
                    {onOpenBoard ? (
                      <button
                        type="button"
                        role="menuitem"
                        data-testid="work-item-open-board-menu"
                        onClick={() => {
                          closeMenu()
                          onOpenBoard()
                        }}
                        className="flex h-10 w-full items-center gap-2.5 rounded-xl px-2 text-left text-sm text-text-primary hover:bg-muted"
                      >
                        <ArrowUpRight className="h-4 w-4 shrink-0 text-text-secondary" />
                        <span className="min-w-0 flex-1">
                          {t('workbench.open_in_work_item_board', '在工作空间中查看')}
                        </span>
                      </button>
                    ) : null}
                  </>
                ) : null}
              </>
            ) : (
              <>
                <div className="px-2 pb-2 pt-1">
                  <div className="text-sm font-semibold text-text-primary">
                    {t('workbench.work_item_for_new_task', '新任务的工作空间')}
                  </div>
                  <div className="mt-1 text-xs leading-5 text-text-muted">
                    {t(
                      'workbench.work_item_new_explanation',
                      '发送后创建一个工作空间，用来汇总后续关联的任务。'
                    )}
                  </div>
                </div>
                <div className="my-1 h-px bg-border" />
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked="true"
                  data-testid="work-item-create-option"
                  className="flex min-h-10 w-full items-center gap-2.5 rounded-xl px-2 text-left text-sm text-text-primary hover:bg-muted"
                >
                  <Plus className="h-4 w-4 shrink-0 text-text-secondary" />
                  <span className="min-w-0 flex-1">
                    {t('workbench.create_new_work_item', '新建工作空间')}
                  </span>
                  <Check className="h-4 w-4 shrink-0" />
                </button>
                {onJoinExisting ? (
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="work-item-join-existing-option"
                    onClick={() => {
                      closeMenu()
                      onJoinExisting()
                    }}
                    className="flex min-h-10 w-full items-center gap-2.5 rounded-xl px-2 text-left text-sm text-text-primary hover:bg-muted"
                  >
                    <Link2 className="h-4 w-4 shrink-0 text-text-secondary" />
                    <span className="min-w-0 flex-1">
                      {t('workbench.join_existing_work_item', '加入已有工作空间')}
                    </span>
                  </button>
                ) : null}
                {onCancel ? (
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="clear-project-space-context-button"
                    onClick={() => {
                      closeMenu()
                      onCancel()
                    }}
                    className="flex min-h-10 w-full items-center gap-2.5 rounded-xl px-2 text-left text-sm text-text-muted hover:bg-muted hover:text-text-primary"
                  >
                    <X className="h-4 w-4 shrink-0" />
                    <span>{t('workbench.disable_work_item', '不使用工作空间')}</span>
                  </button>
                ) : null}
              </>
            )}
          </div>,
          document.body
        )}
    </div>
  )
}
