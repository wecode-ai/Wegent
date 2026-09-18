import { useCallback, useMemo, useState } from 'react'
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
import { runtimeMyWorkItems, type RuntimeMyWorkItem } from '@/features/todo/runtimeMyWork'
import { columnDotClasses, columns } from '@/features/todo/todoShared'
import type { RuntimeTaskLifecycleStoreSnapshot } from '@/features/workbench/runtimeTaskLifecycle'
import { useTranslation } from '@/hooks/useTranslation'
import type { RuntimeTaskAddress, RuntimeWorkListResponse } from '@/types/api'

interface TaskBoardViewProps {
  runtimeWork: RuntimeWorkListResponse | null
  runtimeTaskLifecycle: RuntimeTaskLifecycleStoreSnapshot
  onCreateTask: () => void
  onOpenRuntimeTask: (address: RuntimeTaskAddress) => void
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
  onCreateTask,
  onOpenRuntimeTask,
}: TaskBoardViewProps) {
  const { t } = useTranslation('common')
  const [activeLocalProjectFilter, setActiveLocalProjectFilter] = useState('all')
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
  const items = useMemo(
    () =>
      activeLocalProjectFilter === 'all' || !selectedLocalProject
        ? allItems
        : allItems.filter(item => item.local_project_id === selectedLocalProject.id),
    [activeLocalProjectFilter, allItems, selectedLocalProject]
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
        renderColumnHeaderActions={column => {
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
            processingStatus={item.status !== 'inbox'}
            taskBindings={[taskBinding(item)]}
            onClick={() => onOpenRuntimeTask(item.runtime_address)}
            onArchive={() => undefined}
            onOpenRuntimeTask={onOpenRuntimeTask}
            display={boardCardDisplay}
            dragDisabled
            archiveDisabled
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
    </div>
  )
}
