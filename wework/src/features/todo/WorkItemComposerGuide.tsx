import { ArrowUpRight, ChevronDown, LayoutDashboard, ListChecks } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import { Button } from '@/components/ui/button'
import { projectKey, type ProjectSpaceApi } from '@/features/todo/projectSpaceSelection'
import { useTranslation } from '@/hooks/useTranslation'
import type { RuntimeTaskAddress } from '@/types/api'
import { ProjectSpacePickerMenu } from './ProjectSpacePickerMenu'
import { useWorkItemPickerOpen } from './workItemPickerOpenState'

type TaskBinding = Awaited<ReturnType<ProjectSpaceApi['listTaskBindings']>>[number]

interface WorkItemComposerGuideProps {
  project?: CloudProject | null
  item?: CloudLoopItem | null
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
  const canChangeProject = Boolean(onSelectProject)
  const pickerStoreKey = currentTask
    ? `task:${currentTask.deviceId}:${currentTask.taskId}`
    : (item?.id ?? null)
  // Open state outlives this component: a pane remount during restore must
  // re-render an open picker instead of silently closing it (issue #4637).
  // Persisted only for identity-stable guides; project-only guides keep
  // local state so a project storage change still resets their picker.
  const [persistedOpen, setPersistedOpen] = useWorkItemPickerOpen(
    canChangeProject ? pickerStoreKey : null
  )
  const [localOpen, setLocalOpen] = useState(false)
  const open = pickerStoreKey !== null ? persistedOpen : localOpen
  const setOpen = useCallback(
    (update: boolean | ((current: boolean) => boolean)) => {
      const next = typeof update === 'function' ? update(open) : update
      if (pickerStoreKey !== null) {
        setPersistedOpen(next)
      } else {
        setLocalOpen(next)
      }
    },
    [open, pickerStoreKey, setPersistedOpen]
  )
  const traceId = useId()
  const [bindingRetry, setBindingRetry] = useState(0)
  const [bindingResult, setBindingResult] = useState<{
    api: ProjectSpaceApi
    itemId: string
    bindings: TaskBinding[] | null
    failed: boolean
    refreshKey: unknown
    retry: number
  } | null>(null)
  const itemId = item?.id
  const menuOpen = open && canChangeProject
  const closeMenu = useCallback(() => {
    if (import.meta.env.VITE_WEWORK_E2E === 'true')
      console.debug(
        '[Wework] Project picker lifecycle',
        JSON.stringify({ event: 'close-requested', traceId })
      )
    setOpen(false)
  }, [setOpen, traceId])

  useEffect(() => {
    if (import.meta.env.VITE_WEWORK_E2E !== 'true') return
    console.debug(
      '[Wework] Project picker lifecycle',
      JSON.stringify({ event: 'mounted', traceId })
    )
    return () => {
      console.debug(
        '[Wework] Project picker lifecycle',
        JSON.stringify({ event: 'unmounted', traceId })
      )
    }
  }, [traceId])

  useEffect(() => {
    if (import.meta.env.VITE_WEWORK_E2E !== 'true') return
    console.debug(
      '[Wework] Project picker lifecycle',
      JSON.stringify({
        event: 'state',
        traceId,
        open,
        projectId: project?.id ?? null,
        projectStore: project?.project_store ?? null,
        itemId: item?.id ?? null,
        taskId: currentTask?.taskId ?? null,
        deviceId: currentTask?.deviceId ?? null,
        pickerStoreKey,
        canChangeProject,
        menuOpen,
      })
    )
  }, [
    traceId,
    open,
    project?.id,
    project?.project_store,
    item?.id,
    currentTask?.taskId,
    currentTask?.deviceId,
    pickerStoreKey,
    canChangeProject,
    menuOpen,
  ])

  useEffect(() => {
    if (!api || !itemId) return
    let active = true
    void api.listTaskBindings(itemId).then(
      bindings => {
        if (active)
          setBindingResult({
            api,
            itemId,
            bindings,
            failed: false,
            refreshKey,
            retry: bindingRetry,
          })
      },
      () => {
        if (active)
          setBindingResult(previous => ({
            api,
            itemId,
            bindings:
              previous && previous.api === api && previous.itemId === itemId
                ? previous.bindings
                : null,
            failed: true,
            refreshKey,
            retry: bindingRetry,
          }))
      }
    )
    return () => {
      active = false
    }
  }, [api, itemId, refreshKey, bindingRetry])

  const resolvedItem = item ?? null
  const ownedBindings =
    bindingResult && bindingResult.api === api && bindingResult.itemId === itemId
      ? bindingResult
      : null
  const taskBindings = !item ? [] : (ownedBindings?.bindings ?? null)
  const bindingsPending =
    !ownedBindings ||
    ownedBindings.refreshKey !== refreshKey ||
    ownedBindings.retry !== bindingRetry
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
    taskCount == null && api && !ownedBindings?.failed
      ? t('workbench.loading_task_count', '任务同步中')
      : taskCount != null && taskCount > 1
        ? `${taskCount} 个任务${otherTaskCount ? `，还有 ${otherTaskCount} 个` : ''}`
        : null

  const title = resolvedItem
    ? `${resolvedItem.title}${taskSummary ? ` · ${taskSummary}` : ''}`
    : (project?.name ?? t('workbench.default_work_item_board', '我的任务'))
  const openSummary = onOpen ?? onOpenBoard

  const projectMenu = menuOpen ? (
    <ProjectSpacePickerMenu
      key={project ? projectKey(project) : 'none'}
      projects={projects}
      project={project}
      triggerRef={triggerRef}
      containerRef={containerRef}
      onClose={closeMenu}
      onSelect={option => onSelectProject?.(option)}
      onRemoveProject={onRemoveProject}
    />
  ) : null

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
          <button
            type="button"
            data-testid="work-item-guide-open-summary"
            onClick={() => {
              closeMenu()
              openSummary?.()
            }}
            disabled={!openSummary}
            className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden rounded-lg text-left transition hover:bg-background/70 focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-inset keyboard:focus-visible:ring-primary/30 disabled:cursor-default disabled:hover:bg-transparent"
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
            {taskSummary ? (
              <span
                data-testid="work-item-guide-summary-details"
                className="min-w-0 truncate text-xs text-text-muted"
              >
                · {taskSummary}
              </span>
            ) : null}
          </button>
          {ownedBindings?.failed ? (
            <Button
              variant="ghost"
              type="button"
              data-testid="work-item-guide-retry-task-count"
              disabled={bindingsPending}
              onClick={() => setBindingRetry(current => current + 1)}
              className="h-6 shrink-0 px-1 py-0 text-xs text-text-muted"
            >
              {t('workbench.task_count_load_failed_retry', '任务数加载失败，重试')}
            </Button>
          ) : null}
          {onOpen ? (
            <button
              type="button"
              data-testid="work-item-open-details"
              onClick={() => {
                closeMenu()
                onOpen()
              }}
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
              onClick={() => {
                closeMenu()
                onOpenBoard()
              }}
              title={t('workbench.open_in_work_item_board', '在工作空间中打开')}
              aria-label={t('workbench.open_in_work_item_board', '在工作空间中打开')}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-text-muted transition hover:bg-background/70 hover:text-text-primary"
            >
              <ArrowUpRight className="h-3.5 w-3.5" />
            </button>
          ) : null}
          {canChangeProject ? (
            <button
              ref={triggerRef}
              type="button"
              data-testid="work-item-change-board"
              onClick={() => setOpen(current => !current)}
              title={t('workbench.task_board_change', '更改看板关联')}
              aria-label={t('workbench.task_board_change', '更改看板关联')}
              aria-expanded={open}
              aria-haspopup="dialog"
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

  const projectContextClassName = [
    'flex w-full min-w-[44px] items-center overflow-hidden text-sm font-normal leading-[18px] text-text-secondary',
    toolbar ? 'h-8 gap-1.5 rounded-lg px-2' : 'h-9 gap-2 px-2',
    !toolbar ? 'max-w-[48rem] rounded-xl' : '',
    canChangeProject
      ? 'group transition-[background-color,color] hover:text-text-primary focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-primary/30'
      : '',
    canChangeProject && toolbar ? 'hover:bg-background/70' : '',
    canChangeProject && integrated && !toolbar ? 'hover:bg-background/55' : '',
    canChangeProject && !integrated && !toolbar
      ? 'hover:bg-background/70 hover:shadow-[0_8px_22px_rgba(0,0,0,0.10)]'
      : '',
    open
      ? integrated && !toolbar
        ? 'bg-background/55 text-text-primary'
        : toolbar
          ? 'bg-background/70 text-text-primary'
          : 'bg-background/70 text-text-primary shadow-[0_8px_22px_rgba(0,0,0,0.10)]'
      : '',
  ].join(' ')

  const projectContextContent = (
    <>
      <LayoutDashboard
        className={toolbar ? 'h-4 w-4 shrink-0' : 'h-4 w-4 shrink-0 text-primary'}
        aria-hidden="true"
      />
      <span className={toolbar ? 'min-w-0 truncate' : 'min-w-0 truncate font-medium'}>
        {project?.name ?? t('workbench.default_work_item_board', '我的任务')}
      </span>
      {canChangeProject ? (
        <ChevronDown
          className={toolbar ? 'h-4 w-4 shrink-0' : 'ml-auto h-4 w-4 shrink-0 text-text-muted'}
          aria-hidden="true"
        />
      ) : null}
    </>
  )

  return (
    <div
      ref={containerRef}
      className={toolbar ? 'relative min-w-0 max-w-[12rem] shrink' : 'relative min-w-0 flex-1'}
    >
      {canChangeProject ? (
        <button
          ref={triggerRef}
          type="button"
          data-testid="project-space-context-pill"
          onClick={() => setOpen(current => !current)}
          className={projectContextClassName}
          aria-expanded={open}
          aria-haspopup="dialog"
          title={title}
        >
          {projectContextContent}
        </button>
      ) : (
        <div
          data-testid="project-space-context-pill"
          className={projectContextClassName}
          title={title}
        >
          {projectContextContent}
        </div>
      )}

      {projectMenu}
    </div>
  )
}
