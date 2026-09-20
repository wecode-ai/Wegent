import { useCallback, useEffect, useMemo, useState } from 'react'
import { Archive, CheckCheck } from 'lucide-react'
import { isDefaultWorkItemProject } from '@/api/deliveries'
import {
  createStandardCloudBoardColumns,
  ProjectBoardBody,
  ProjectBoardGroupPicker,
  useStandardCloudBoardController,
  type ProjectBoardColumn,
  type ProjectBoardGroupBy,
} from '@wegent/collaboration/project-board'
import { projectBoardDnd } from '@wegent/collaboration/project-board/projectBoardDnd'
import {
  CloudTodoBoardCard,
  type BoardCardDisplaySettings,
  type CloudTodoBoardTaskBinding,
} from '@/features/todo/CloudTodoBoardCard'
import { TaskBoardColumnCreateButton } from '@/features/todo/TaskBoardActions'
import { CloudTodoModal as Modal } from '@/features/todo/CloudTodoModal'
import {
  findProjectSpaceContextSourceForTask,
  type ProjectSpaceApi,
  type ProjectSpaceTaskContextSource,
} from '@/features/todo/projectSpaceSelection'
import { runtimeMyWorkItems, type RuntimeMyWorkItem } from '@/features/todo/runtimeMyWork'
import { columnDotClasses, columns } from '@/features/todo/todoShared'
import { getRuntimeTaskReminderKey } from '@/features/workbench/runtimeTaskReminders'
import type { RuntimeTaskLifecycleStoreSnapshot } from '@/features/workbench/runtimeTaskLifecycle'
import type { ArchiveRuntimeConversationsResult } from '@/features/workbench/workbenchContextTypes'
import { useTranslation } from '@/hooks/useTranslation'
import { Tooltip } from '@/components/ui/tooltip'
import type { RuntimeTaskAddress, RuntimeWorkListResponse } from '@/types/api'

interface TaskBoardViewProps {
  runtimeWork: RuntimeWorkListResponse | null
  runtimeTaskLifecycle: RuntimeTaskLifecycleStoreSnapshot
  unreadRuntimeTaskKeys: ReadonlySet<string>
  onCreateTask: () => void
  projectSpaceApis: ProjectSpaceApi[]
  onArchiveRuntimeTasks: (
    addresses: RuntimeTaskAddress[]
  ) => Promise<ArchiveRuntimeConversationsResult | void>
  onMarkRuntimeTaskRead: (address: RuntimeTaskAddress) => void
  onOpenRuntimeTask: (address: RuntimeTaskAddress) => void
}

type RuntimeTaskContextSource = ProjectSpaceTaskContextSource<ProjectSpaceApi>

function runtimeTaskKey(address: RuntimeTaskAddress): string {
  return `${address.deviceId}\0${address.taskId}`
}

async function trackDefaultWorkItem(
  candidates: Array<{
    api: ProjectSpaceApi
    project: Awaited<ReturnType<ProjectSpaceApi['listCloudProjects']>>['items'][number]
  }>,
  item: RuntimeMyWorkItem
): Promise<RuntimeTaskContextSource> {
  const failures: unknown[] = []
  for (const { api, project } of candidates) {
    try {
      const tracked = await api.trackProjectTask(
        project.id,
        item.runtime_address,
        item.title,
        item.description ?? ''
      )
      return {
        api,
        context: {
          project,
          loop_item: tracked.item,
        },
      }
    } catch (error) {
      failures.push(error)
    }
  }
  throw new AggregateError(failures, 'Task could not be linked to My Tasks')
}

async function loadDefaultWorkItemSources(apis: ProjectSpaceApi[]) {
  const projectResults = await Promise.allSettled(
    apis.map(async api => ({
      api,
      projects: (await api.listCloudProjects()).items,
    }))
  )
  const failures = projectResults.flatMap(result =>
    result.status === 'rejected' ? [result.reason] : []
  )
  const candidates = projectResults.flatMap(result =>
    result.status === 'fulfilled'
      ? result.value.projects
          .filter(isDefaultWorkItemProject)
          .map(project => ({ api: result.value.api, project }))
      : []
  )
  if (candidates.length === 0) {
    throw new AggregateError(failures, 'My Tasks project is unavailable')
  }
  return candidates
}

const boardCardDisplay: BoardCardDisplaySettings = {
  showAssignee: true,
  showPriority: true,
  showReference: false,
  showTags: true,
  showDate: true,
}

function taskBinding(item: RuntimeMyWorkItem): CloudTodoBoardTaskBinding {
  return {
    id: item.id,
    device_id: item.runtime_address.deviceId,
    task_id: item.runtime_address.taskId,
    task_title: item.title,
    running: item.status === 'in_progress',
  }
}

export function TaskBoardView({
  runtimeWork,
  runtimeTaskLifecycle,
  unreadRuntimeTaskKeys,
  onCreateTask,
  projectSpaceApis,
  onArchiveRuntimeTasks,
  onMarkRuntimeTaskRead,
  onOpenRuntimeTask,
}: TaskBoardViewProps) {
  const { t } = useTranslation('common')
  const [activeLocalProjectFilter, setActiveLocalProjectFilter] = useState('all')
  const [taskContexts, setTaskContexts] = useState<Map<string, RuntimeTaskContextSource>>(
    () => new Map()
  )
  const [batchConfirmItems, setBatchConfirmItems] = useState<RuntimeMyWorkItem[] | null>(null)
  const [batchConfirmBusy, setBatchConfirmBusy] = useState(false)
  const [batchConfirmError, setBatchConfirmError] = useState<string | null>(null)
  const [batchArchiveItems, setBatchArchiveItems] = useState<RuntimeMyWorkItem[] | null>(null)
  const [batchArchiveBusy, setBatchArchiveBusy] = useState(false)
  const [batchArchiveError, setBatchArchiveError] = useState<string | null>(null)
  const groupFields = useMemo<Array<{ id: ProjectBoardGroupBy; name: string }>>(
    () => [
      { id: 'status', name: t('todo.task_board_group_status', '状态') },
      { id: 'priority', name: t('todo.task_board_group_priority', '优先级') },
      { id: 'assignee', name: t('todo.task_board_group_assignee', '负责人') },
      { id: 'tag', name: t('todo.task_board_group_tag', '标签') },
    ],
    [t]
  )
  const boardStatuses = useMemo(
    () =>
      columns.map(column => ({
        id: column.status,
        name: t(`todo.task_board_status_${column.status}`, column.label),
      })),
    [t]
  )
  const allItems = useMemo(
    () =>
      runtimeMyWorkItems(
        runtimeWork,
        {
          projectId: 'runtime-local-tasks',
          projectStore: 'local',
          createdByUserId: 0,
        },
        runtimeTaskLifecycle
      ),
    [runtimeTaskLifecycle, runtimeWork]
  )
  const localProjectOptions = useMemo(
    () =>
      (runtimeWork?.projects ?? []).flatMap(project =>
        project.project.id === undefined
          ? []
          : [{ id: project.project.id, name: project.project.name }]
      ),
    [runtimeWork]
  )
  const selectedLocalProject = localProjectOptions.find(
    project => String(project.id) === activeLocalProjectFilter
  )
  const filteredItems = useMemo(
    () =>
      activeLocalProjectFilter === 'all' || !selectedLocalProject
        ? allItems
        : allItems.filter(item => item.local_project_id === selectedLocalProject.id),
    [activeLocalProjectFilter, allItems, selectedLocalProject]
  )
  const reviewItems = useMemo(
    () => allItems.filter(item => item.status === 'in_review'),
    [allItems]
  )
  useEffect(() => {
    if (projectSpaceApis.length === 0 || reviewItems.length === 0) return
    let active = true
    void Promise.allSettled(
      reviewItems.map(async item => ({
        key: runtimeTaskKey(item.runtime_address),
        source: await findProjectSpaceContextSourceForTask(projectSpaceApis, item.runtime_address),
      }))
    ).then(results => {
      if (!active) return
      const resolved = results.flatMap(result =>
        result.status === 'fulfilled' && result.value.source.context.loop_item ? [result.value] : []
      )
      if (resolved.length === 0) return
      setTaskContexts(current => {
        const next = new Map(current)
        for (const { key, source } of resolved) next.set(key, source)
        return next
      })
    })
    return () => {
      active = false
    }
  }, [projectSpaceApis, reviewItems])
  const items = useMemo(
    () =>
      filteredItems.map(item => {
        const trackedItem = taskContexts.get(runtimeTaskKey(item.runtime_address))?.context
          .loop_item
        return item.status === 'in_review' && trackedItem?.status === 'completed'
          ? { ...item, status: 'completed' as const }
          : item
      }),
    [filteredItems, taskContexts]
  )
  const createColumns = useCallback(
    (groupBy: ProjectBoardGroupBy): ProjectBoardColumn[] =>
      createStandardCloudBoardColumns({
        getDotClass: (nextGroupBy, value) =>
          nextGroupBy === 'status' || nextGroupBy === 'priority'
            ? (columnDotClasses[value] ?? 'bg-zinc-400')
            : 'bg-zinc-400',
        groupBy,
        items,
        labels: {
          noPriority: t('todo.task_board_no_priority', '普通'),
          noTag: t('todo.task_board_no_tag', '无标签'),
          priority: {
            low: t('todo.task_board_priority_low', '低'),
            medium: t('todo.task_board_priority_medium', '中'),
            high: t('todo.task_board_priority_high', '高'),
            urgent: t('todo.task_board_priority_urgent', '紧急'),
          },
          unassigned: t('todo.task_board_unassigned', '未指定'),
        },
        statuses: boardStatuses,
      }),
    [boardStatuses, items, t]
  )
  const board = useStandardCloudBoardController({
    createColumns,
    defaultGroupBy: 'status',
    extensions: {
      getSearchText: item => `${item.title} ${item.description ?? ''}`,
      noTagGroupValue: '',
    },
    focusStorageKey: 'wework:task-board:focus-execution-columns',
    items,
    onMove: () => undefined,
    personalGroupStorageKey: 'wework:task-board:group-by',
  })

  async function confirmReviewTasks(reviewItemsToConfirm: RuntimeMyWorkItem[]) {
    if (batchConfirmBusy || reviewItemsToConfirm.length === 0) return
    setBatchConfirmBusy(true)
    setBatchConfirmError(null)
    let defaultWorkItemSources: ReturnType<typeof loadDefaultWorkItemSources> | null = null
    const repairTaskContext = async (item: RuntimeMyWorkItem) => {
      defaultWorkItemSources ??= loadDefaultWorkItemSources(projectSpaceApis)
      return trackDefaultWorkItem(await defaultWorkItemSources, item)
    }
    const localContextKeys = new Set<string>()
    const results = await Promise.allSettled(
      reviewItemsToConfirm.map(async item => {
        const key = runtimeTaskKey(item.runtime_address)
        let source = taskContexts.get(key)
        if (!source) {
          try {
            source = await findProjectSpaceContextSourceForTask(
              projectSpaceApis,
              item.runtime_address
            )
          } catch {
            source = await repairTaskContext(item)
          }
        }
        if (!source.context.loop_item) {
          source = await repairTaskContext(item)
        }
        const trackedItem = source.context.loop_item
        if (!trackedItem) throw new Error('Task could not be linked to My Tasks')
        if (source.context.project.project_store === 'local') localContextKeys.add(key)
        const updated =
          trackedItem.status === 'completed'
            ? trackedItem
            : await source.api.updateLoopItem(trackedItem.id, {
                version: trackedItem.version,
                status: 'completed',
              })
        return {
          key,
          source: {
            ...source,
            context: { ...source.context, loop_item: updated },
          },
        }
      })
    )
    const succeeded = results.flatMap(result =>
      result.status === 'fulfilled' ? [result.value] : []
    )
    const failed = results.flatMap((result, index) =>
      result.status === 'rejected' ? [reviewItemsToConfirm[index]] : []
    )
    for (const result of results) {
      if (result.status === 'rejected') {
        console.error('[TaskBoard] Failed to confirm Runtime Task', result.reason)
      }
    }
    if (succeeded.length > 0) {
      setTaskContexts(current => {
        const next = new Map(current)
        for (const result of succeeded) next.set(result.key, result.source)
        return next
      })
    }
    if (failed.some(item => localContextKeys.has(runtimeTaskKey(item.runtime_address)))) {
      setTaskContexts(current => {
        const next = new Map(current)
        for (const item of failed) {
          const key = runtimeTaskKey(item.runtime_address)
          if (localContextKeys.has(key)) next.delete(key)
        }
        return next
      })
    }
    if (failed.length === 0) {
      setBatchConfirmItems(null)
    } else {
      setBatchConfirmItems(failed)
      setBatchConfirmError(
        t('todo.batch_confirm_task_failed', '{{count}} 个任务确认失败，请稍后重试', {
          count: failed.length,
        })
      )
    }
    setBatchConfirmBusy(false)
  }

  async function archiveCompletedTasks(completedItems: RuntimeMyWorkItem[]) {
    if (batchArchiveBusy || completedItems.length === 0) return
    setBatchArchiveBusy(true)
    setBatchArchiveError(null)
    try {
      const result = await onArchiveRuntimeTasks(completedItems.map(item => item.runtime_address))
      if (result?.status === 'failed') {
        setBatchArchiveError(
          t('todo.batch_archive_failed', '{{count}} 个任务归档失败，请稍后重试', {
            count: completedItems.length,
          })
        )
        return
      }
      setBatchArchiveItems(null)
    } catch (error) {
      console.error('[TaskBoard] Failed to archive completed Runtime Tasks', error)
      setBatchArchiveError(
        error instanceof Error
          ? error.message
          : t('todo.batch_archive_failed', '{{count}} 个任务归档失败，请稍后重试', {
              count: completedItems.length,
            })
      )
    } finally {
      setBatchArchiveBusy(false)
    }
  }

  return (
    <div className="contents" data-testid="task-board-surface">
      <ProjectBoardBody<RuntimeMyWorkItem>
        state={board.state}
        activeDragItemId={board.activeDragItemId}
        boardError={null}
        boardItemsLoading={false}
        breadcrumb={board.breadcrumb}
        columns={board.columns}
        currentParent={board.currentParent}
        currentParentId={board.currentParentId}
        dnd={projectBoardDnd}
        dndContextProps={{}}
        externalGroupLabel="记录"
        externalGroupValues={[]}
        externalManagedLabel=""
        externalSearchPlaceholder="搜索记录"
        focusLabels={{
          enter: t('todo.focus_view_description', '展开进行中与待确认列'),
          exit: t('todo.exit_focus_view_description', '退出执行阶段专注视图'),
          title: t('todo.focus_view', '专注视图'),
        }}
        getColumnDragHint={() => undefined}
        getColumnEmptyState={column => {
          const hints: Record<string, string> = {
            inbox: t('todo.task_column_empty_inbox', '先记录一个需要推进的问题、目标或具体工作。'),
            pending: t('todo.task_column_empty_pending', '目标和执行方式明确后，从这里等待开始。'),
            in_progress: t(
              'todo.task_column_empty_in_progress',
              '拖到这里开始处理；需要运行环境时系统会先提示。'
            ),
            in_review: t(
              'todo.task_column_empty_in_review',
              '成员或 AI 提交结果后，可在这里确认。'
            ),
            completed: t('todo.task_column_empty_completed', '确认通过的任务会显示在这里。'),
          }
          const hint = hints[column.status]
          if (!hint) return undefined
          return column.status === 'inbox' || column.status === 'pending'
            ? {
                hint,
                action: {
                  label: t('todo.create_first_task', '创建第一个任务'),
                  ariaLabel: t('todo.new_task_in_column', '在{{column}}中新建任务', {
                    column: column.label,
                  }),
                  onClick: onCreateTask,
                },
              }
            : { hint }
        }}
        getColumnItems={board.getColumnItems}
        getItemKey={item => item.id}
        groupFields={groupFields}
        isExternalBoard={false}
        isMyTasksBoard
        layerCount={items.length}
        localProjectFilter={{
          activeId: activeLocalProjectFilter,
          allLabel: t('todo.all_local_projects', '全部项目'),
          ariaLabel: t('todo.local_project_filter', '本地项目'),
          label: t('todo.project_with_name', '项目：{{project}}', {
            project: '{{project}}',
          }),
          options: localProjectOptions,
          selectedName:
            activeLocalProjectFilter === 'all'
              ? t('todo.all_local_projects', '全部项目')
              : (selectedLocalProject?.name ?? t('todo.select_local_project', '选择项目')),
          onChange: setActiveLocalProjectFilter,
        }}
        onBreadcrumbSelect={board.setCurrentParentId}
        onSaveGlobalGroupBy={() => undefined}
        renderColumnHeaderActions={(column, columnItems, state) => {
          if (state.groupBy !== 'status') return null
          if (column.status === 'in_review' && columnItems.length > 0) {
            return (
              <Tooltip
                label={t('todo.batch_confirm_review_tasks', '批量确认完成待确认任务')}
                side="bottom"
                align="end"
              >
                <button
                  type="button"
                  data-testid="task-board-batch-confirm-review"
                  disabled={batchConfirmBusy}
                  onClick={() => {
                    setBatchConfirmError(null)
                    setBatchConfirmItems([...columnItems])
                  }}
                  className="flex h-6 w-6 items-center justify-center rounded-md text-text-muted opacity-0 transition hover:bg-background hover:text-text-primary focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30 disabled:opacity-50 group-hover:opacity-100"
                  aria-label={t('todo.batch_confirm_review_tasks', '批量确认完成待确认任务')}
                >
                  <CheckCheck className="h-3.5 w-3.5" />
                </button>
              </Tooltip>
            )
          }
          if (column.status === 'completed' && columnItems.length > 0) {
            return (
              <Tooltip
                label={t('todo.archive_completed_tasks', '批量归档已完成任务')}
                side="bottom"
                align="end"
              >
                <button
                  type="button"
                  data-testid="task-board-batch-archive-completed"
                  disabled={batchArchiveBusy}
                  onClick={() => {
                    setBatchArchiveError(null)
                    setBatchArchiveItems([...columnItems])
                  }}
                  className="flex h-6 w-6 items-center justify-center rounded-md text-text-muted opacity-0 transition hover:bg-background hover:text-text-primary focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30 disabled:opacity-50 group-hover:opacity-100"
                  aria-label={t('todo.archive_completed_tasks', '批量归档已完成任务')}
                >
                  <Archive className="h-3.5 w-3.5" />
                </button>
              </Tooltip>
            )
          }
          if (column.status !== 'inbox' && column.status !== 'pending') return null
          return (
            <TaskBoardColumnCreateButton
              columnKey={column.key}
              label={t('todo.new_task_in_column', '在{{column}}中新建任务', {
                column: column.label,
              })}
              onClick={onCreateTask}
            />
          )
        }}
        renderDragOverlay={() => null}
        renderExternalGroupPicker={() => null}
        renderGroupPicker={(value, onChange) => (
          <ProjectBoardGroupPicker
            fields={groupFields}
            value={value}
            testIdPrefix="cloud-board-group"
            searchPlaceholder={t('todo.task_board_search_group_fields', '搜索分组字段')}
            onChange={id => onChange(id as ProjectBoardGroupBy)}
          />
        )}
        renderItem={(item, column, state) => (
          <CloudTodoBoardCard
            item={item}
            unread={unreadRuntimeTaskKeys.has(getRuntimeTaskReminderKey(item.runtime_address))}
            processingStatus={item.status !== 'inbox'}
            taskBindings={[taskBinding(item)]}
            onClick={() => {
              onMarkRuntimeTaskRead(item.runtime_address)
              onOpenRuntimeTask(item.runtime_address)
            }}
            onArchive={() => undefined}
            onOpenRuntimeTask={onOpenRuntimeTask}
            display={boardCardDisplay}
            dragDisabled
            archiveDisabled
            cardAction={
              item.status === 'in_review'
                ? {
                    kind: 'confirm',
                    label: t('todo.confirm_complete', '确认完成'),
                    testId: `task-board-card-confirm-${item.id}`,
                    onClick: () => {
                      setBatchConfirmError(null)
                      setBatchConfirmItems([item])
                    },
                  }
                : item.status === 'completed'
                  ? {
                      kind: 'archive',
                      label: t('todo.archive_task', '归档任务'),
                      testId: `task-board-card-archive-${item.id}`,
                      onClick: () => {
                        setBatchArchiveError(null)
                        setBatchArchiveItems([item])
                      },
                    }
                  : undefined
            }
            progressDisplay={
              state.focusExecutionColumns &&
              state.groupBy === 'status' &&
              (column.status === 'in_progress' || column.status === 'in_review')
                ? 'focused'
                : 'compact'
            }
          />
        )}
        renderSkeleton={() => null}
        rootLabel={t('todo.task_board_root_label', '任务')}
        rootUnitLabel={t('todo.task_board_root_unit', '个任务')}
        searchPlaceholder={t('todo.search_tasks', '搜索任务')}
        saveGlobalDisabled
        saveGlobalLabel="应用到全局"
        showQuickStart={false}
        showSaveGlobal={false}
      />
      {batchConfirmItems && (
        <Modal
          title={t('todo.batch_confirm_task_title', '确认待确认任务？')}
          onClose={() => {
            if (batchConfirmBusy) return
            setBatchConfirmItems(null)
            setBatchConfirmError(null)
          }}
        >
          <div className="px-5 pb-5 pt-4" data-testid="task-board-batch-confirm-review-dialog">
            <p className="text-sm leading-5 text-text-secondary">
              {t(
                'todo.batch_confirm_task_description',
                '将当前列中的 {{count}} 个任务标记为已完成。',
                { count: batchConfirmItems.length }
              )}
            </p>
            {batchConfirmError ? (
              <p className="mt-3 text-xs text-destructive" role="alert">
                {batchConfirmError}
              </p>
            ) : null}
            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                data-testid="task-board-batch-confirm-review-cancel"
                disabled={batchConfirmBusy}
                onClick={() => {
                  setBatchConfirmItems(null)
                  setBatchConfirmError(null)
                }}
                className="h-9 rounded-lg border border-border px-4 text-sm text-text-primary hover:bg-muted disabled:opacity-50"
              >
                {t('common.cancel', '取消')}
              </button>
              <button
                type="button"
                data-testid="task-board-batch-confirm-review-confirm"
                disabled={batchConfirmBusy}
                onClick={() => void confirmReviewTasks(batchConfirmItems)}
                className="h-9 rounded-lg bg-text-primary px-4 text-sm font-medium text-background hover:bg-text-primary/90 disabled:opacity-50"
              >
                {batchConfirmBusy
                  ? t('todo.batch_confirming', '确认中…')
                  : t('todo.confirm_complete', '确认完成')}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {batchArchiveItems && (
        <Modal
          title={t('todo.archive_completed_tasks_title', '归档已完成任务？')}
          onClose={() => {
            if (batchArchiveBusy) return
            setBatchArchiveItems(null)
            setBatchArchiveError(null)
          }}
        >
          <div className="px-5 pb-5 pt-4" data-testid="task-board-batch-archive-completed-dialog">
            <p className="text-sm leading-5 text-text-secondary">
              {t(
                'todo.archive_completed_tasks_description',
                '将从任务列表中归档 {{count}} 个已完成任务。归档后可在设置中恢复。',
                { count: batchArchiveItems.length }
              )}
            </p>
            {batchArchiveError ? (
              <p className="mt-3 text-xs text-destructive" role="alert">
                {batchArchiveError}
              </p>
            ) : null}
            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                data-testid="task-board-batch-archive-completed-cancel"
                disabled={batchArchiveBusy}
                onClick={() => {
                  setBatchArchiveItems(null)
                  setBatchArchiveError(null)
                }}
                className="h-9 rounded-lg border border-border px-4 text-sm text-text-primary hover:bg-muted disabled:opacity-50"
              >
                {t('common.cancel', '取消')}
              </button>
              <button
                type="button"
                data-testid="task-board-batch-archive-completed-confirm"
                disabled={batchArchiveBusy}
                onClick={() => void archiveCompletedTasks(batchArchiveItems)}
                className="h-9 rounded-lg bg-red-600 px-4 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {batchArchiveBusy
                  ? t('todo.archiving', '归档中…')
                  : t('todo.confirm_archive', '确认归档')}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
