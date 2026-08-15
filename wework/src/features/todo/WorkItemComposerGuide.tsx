import { ArrowUpRight, Check, ChevronDown, LayoutDashboard, ListChecks, Users } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import { useAnchoredPortalMenu } from '@/components/chat/composer/useAnchoredPortalMenu'
import { useOutsideClick } from '@/components/chat/composer/useOutsideClick'
import type { ProjectSpaceApi } from '@/features/todo/projectSpaceSelection'
import { useTranslation } from '@/hooks/useTranslation'
import type { RuntimeTaskAddress } from '@/types/api'

interface WorkItemComposerGuideProps {
  project: CloudProject
  projects?: CloudProject[]
  item?: CloudLoopItem | null
  api?: ProjectSpaceApi
  currentTask?: RuntimeTaskAddress | null
  currentUserName?: string | null
  bindingPending?: boolean
  refreshKey?: unknown
  onSelectProject?: (project: CloudProject) => void
  onOpen?: () => void
  onOpenBoard?: () => void
  onCancel?: () => void
}

const nextStepLabelKeys: Record<CloudLoopItem['status'], string> = {
  inbox: 'workbench.work_item_next_step_start',
  pending: 'workbench.work_item_next_step_start',
  in_progress: 'workbench.work_item_next_step_continue',
  in_review: 'workbench.work_item_next_step_review',
  completed: 'workbench.work_item_next_step_completed',
}

function participantSummary(names: string[]): string {
  if (names.length <= 2) return names.join('、')
  return `${names.slice(0, 2).join('、')} +${names.length - 2}`
}

function itemParticipantNames(item: CloudLoopItem | null): string[] {
  if (!item) return []
  return [item.assignee_name, item.assignee_agent_name, item.ai_state?.agent_name].flatMap(name => {
    const trimmed = name?.trim()
    return trimmed ? [trimmed] : []
  })
}

export function WorkItemComposerGuide({
  project,
  projects = [],
  item,
  api,
  currentTask,
  currentUserName,
  bindingPending = false,
  refreshKey,
  onSelectProject,
  onOpen,
  onOpenBoard,
  onCancel,
}: WorkItemComposerGuideProps) {
  const { t } = useTranslation('common')
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [refreshedItem, setRefreshedItem] = useState<CloudLoopItem | null>(null)
  const [taskCount, setTaskCount] = useState<number | null>(item ? null : 0)
  const [participantNames, setParticipantNames] = useState<string[]>([])
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
      api.listLoopItemCollaborators(item.id),
      currentTask ? api.findCloudContextForTask(currentTask) : Promise.resolve(null),
    ]).then(([bindingsResult, collaboratorsResult, contextResult]) => {
      if (!active) return
      if (bindingsResult.status === 'fulfilled') {
        setTaskCount(bindingsResult.value.length)
      }
      const names = new Set<string>()
      if (bindingsResult.status === 'fulfilled' && bindingsResult.value.length > 0) {
        names.add(currentUserName?.trim() || t('workbench.you', '你'))
      }
      if (collaboratorsResult.status === 'fulfilled') {
        for (const collaborator of collaboratorsResult.value) {
          if (collaborator.user_name.trim()) names.add(collaborator.user_name.trim())
        }
      }
      if (item.assignee_name?.trim()) names.add(item.assignee_name.trim())
      if (item.assignee_agent_name?.trim()) names.add(item.assignee_agent_name.trim())
      if (item.ai_state?.agent_name?.trim()) names.add(item.ai_state.agent_name.trim())
      setParticipantNames(Array.from(names))
      if (contextResult.status === 'fulfilled' && contextResult.value?.loop_item) {
        setRefreshedItem(contextResult.value.loop_item)
      }
    })
    return () => {
      active = false
    }
  }, [api, currentTask, currentUserName, item, refreshKey, t])

  const resolvedItem = refreshedItem?.id === item?.id ? refreshedItem : (item ?? null)
  const nextStep = resolvedItem
    ? t(nextStepLabelKeys[resolvedItem.status] ?? '', resolvedItem.status)
    : null
  const participants = useMemo(() => {
    const names = new Set([...itemParticipantNames(resolvedItem), ...participantNames])
    return participantSummary(Array.from(names))
  }, [participantNames, resolvedItem])
  const selectableProjects = useMemo(() => {
    const uniqueProjects = new Map<string, CloudProject>()
    for (const option of [project, ...projects]) uniqueProjects.set(String(option.id), option)
    return Array.from(uniqueProjects.values())
  }, [project, projects])

  return (
    <div ref={containerRef} className="relative min-w-0 flex-1">
      <button
        ref={triggerRef}
        type="button"
        data-testid="project-space-context-pill"
        onClick={() => setOpen(current => !current)}
        className={[
          'group flex h-9 w-full min-w-[44px] max-w-[48rem] items-center gap-2 rounded-xl px-2 text-sm font-normal leading-[18px] text-text-secondary transition-[background-color,color,box-shadow] hover:bg-background/70 hover:text-text-primary hover:shadow-[0_8px_22px_rgba(0,0,0,0.10)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30',
          open ? 'bg-background/70 text-text-primary shadow-[0_8px_22px_rgba(0,0,0,0.10)]' : '',
        ].join(' ')}
        aria-expanded={open}
        aria-haspopup="menu"
        title={
          resolvedItem
            ? `${resolvedItem.id} · ${resolvedItem.title}`
            : t('workbench.work_item_context_pending_title', '当前任务会自动同步到工作项')
        }
      >
        <LayoutDashboard className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
        <span className="shrink-0">{project.name}</span>
        {resolvedItem ? (
          <>
            <span className="shrink-0 text-xs text-text-muted">· {resolvedItem.id}</span>
            <span
              data-testid="work-item-guide-summary-title"
              className="min-w-[6rem] truncate text-text-primary"
            >
              {resolvedItem.title}
            </span>
            <span className="h-4 w-px shrink-0 bg-border" aria-hidden="true" />
            <span
              data-testid="work-item-guide-summary-next-step"
              className="shrink-0 text-xs text-text-muted"
            >
              {t('workbench.next_step', '下一步')}：{nextStep}
            </span>
            <span
              data-testid="work-item-guide-summary-details"
              className="shrink-0 text-xs text-text-muted"
            >
              {taskCount == null
                ? t('workbench.loading_task_count', '任务 …')
                : `${taskCount} ${t('workbench.tasks_unit', '个任务')}`}
            </span>
            <span className="flex min-w-0 items-center gap-1 text-xs text-text-muted">
              <Users className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span data-testid="work-item-guide-summary-participants" className="truncate">
                {participants || t('workbench.no_participants', '暂无参与者')}
              </span>
            </span>
          </>
        ) : (
          <span
            data-testid="work-item-guide-summary-pending"
            className="min-w-0 truncate text-xs text-text-muted"
          >
            {bindingPending
              ? t('workbench.work_item_binding_pending', '正在关联当前任务')
              : t('workbench.work_item_auto_create_hint', '发送后自动创建，并同步任务进展')}
          </span>
        )}
        <ChevronDown className="h-4 w-4 shrink-0" aria-hidden="true" />
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
            <div className="px-2 pb-2 pt-1">
              <div className="text-xs font-medium text-text-muted">
                {t('workbench.task_destination', '任务归属')}
              </div>
              <div className="mt-1 truncate text-sm font-semibold text-text-primary">
                {resolvedItem ? `${resolvedItem.id} · ${resolvedItem.title}` : project.name}
              </div>
              <div className="mt-1 text-xs leading-5 text-text-muted">
                {resolvedItem
                  ? `${t('workbench.next_step', '下一步')}：${nextStep}`
                  : bindingPending
                    ? t('workbench.work_item_binding_pending', '正在关联当前任务')
                    : t('workbench.work_item_auto_create_hint', '发送后自动创建，并同步任务进展')}
              </div>
              {resolvedItem ? (
                <div className="mt-2 flex items-center gap-3 text-xs text-text-muted">
                  <span data-testid="work-item-guide-next-step" className="sr-only">
                    {t('workbench.next_step', '下一步')}：{nextStep}
                  </span>
                  <span data-testid="work-item-guide-details">
                    {taskCount == null
                      ? t('workbench.loading_task_count', '任务 …')
                      : `${taskCount} ${t('workbench.tasks_unit', '个任务')}`}
                  </span>
                  <span className="flex min-w-0 items-center gap-1">
                    <Users className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span data-testid="work-item-guide-participants" className="truncate">
                      {participants || t('workbench.no_participants', '暂无参与者')}
                    </span>
                  </span>
                </div>
              ) : null}
            </div>

            {!resolvedItem && selectableProjects.length > 0 ? (
              <>
                <div className="my-1 h-px bg-border" />
                <div className="px-2 pb-1 pt-1 text-xs font-medium text-text-muted">
                  {t('workbench.select_work_item_board', '选择工作项看板')}
                </div>
                {selectableProjects.map(option => {
                  const selected = String(option.id) === String(project.id)
                  return (
                    <button
                      key={option.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={selected}
                      data-testid={`work-item-project-option-${option.id}`}
                      onClick={() => {
                        onSelectProject?.(option)
                        closeMenu()
                      }}
                      className="flex min-h-10 w-full items-center gap-2.5 rounded-xl px-2 text-left text-sm text-text-primary hover:bg-muted"
                    >
                      <LayoutDashboard className="h-4 w-4 shrink-0 text-text-secondary" />
                      <span className="min-w-0 flex-1 truncate">{option.name}</span>
                      {selected ? <Check className="h-4 w-4 shrink-0" /> : null}
                    </button>
                  )
                })}
              </>
            ) : null}

            {resolvedItem && (onOpen || onOpenBoard) ? (
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
                      {t('workbench.view_work_item_details', '查看工作项详情')}
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
                      {t('workbench.open_in_work_item_board', '在工作项看板中查看')}
                    </span>
                  </button>
                ) : null}
              </>
            ) : null}

            {!resolvedItem && onCancel ? (
              <>
                <div className="my-1 h-px bg-border" />
                <button
                  type="button"
                  role="menuitem"
                  data-testid="clear-project-space-context-button"
                  onClick={() => {
                    closeMenu()
                    onCancel()
                  }}
                  className="flex h-10 w-full items-center rounded-xl px-2 text-left text-sm text-text-muted hover:bg-muted hover:text-text-primary"
                >
                  {t('workbench.clear_work_item_context', '不加入工作项看板')}
                </button>
              </>
            ) : null}
          </div>,
          document.body
        )}
    </div>
  )
}
