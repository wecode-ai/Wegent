import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import type {
  CollaborationIssue,
  CollaborationProject,
  CollaborationStatus,
} from '@wegent/collaboration'
import { createCollaborationTranslator } from '../../../packages/collaboration/src/i18n'
import { ProjectBoardAdapter } from '../../../packages/collaboration/src/web-adapter/ProjectBoardAdapter'
import { ProjectCalendarView } from '../../../packages/collaboration/src/project-schedule/ProjectCalendarView'
import { ProjectGanttView } from '../../../packages/collaboration/src/project-schedule/ProjectGanttView'
import {
  defaultScheduleViewOptions,
  localDateKey,
  addLocalDays,
} from '../../../packages/collaboration/src/project-schedule/model'

const project: CollaborationProject = {
  id: 'planning-story',
  public_id: 'planning-story',
  project_key: 'PLAN',
  name: 'Planning',
  description: '',
  project_store: 'local',
  task_provider: 'local',
  provider_config: {},
  status: 'active',
  tags: [],
  version: 1,
  created_by_user_id: 1,
  created_at: '2026-11-01',
  updated_at: '2026-11-01',
}
const statuses: CollaborationStatus[] = [
  { id: 'pending', name: '待开始', color: 'gray' },
  { id: 'in_progress', name: '进行中', color: 'blue' },
  { id: 'completed', name: '已完成', color: 'green' },
]
const today = localDateKey(new Date())
const later = localDateKey(addLocalDays(new Date(), 2))
const initial: CollaborationIssue[] = [
  {
    id: 'planning-1',
    cloud_project_id: project.id,
    sequence_number: 1,
    parent_id: null,
    created_by_user_id: 1,
    assignee_user_id: null,
    title: '跨列移动并保留标签',
    description: '',
    status: 'pending',
    priority: 'medium',
    start_at: today,
    due_at: later,
    tags: ['设计', '共享'],
    sort_order: 0,
    version: 1,
    created_at: today,
    updated_at: today,
    completed_at: null,
    can_edit: true,
  },
  {
    id: 'planning-2',
    cloud_project_id: project.id,
    sequence_number: 2,
    parent_id: null,
    created_by_user_id: 1,
    assignee_user_id: null,
    title: '从未安排时间拖到日期',
    description: '',
    status: 'in_progress',
    priority: 'high',
    start_at: null,
    due_at: null,
    tags: ['共享'],
    sort_order: 1,
    version: 1,
    created_at: today,
    updated_at: today,
    completed_at: null,
    can_edit: true,
  },
]
function Example({
  view = 'board',
  readOnly = false,
  rejectSave = false,
}: {
  view?: 'board' | 'calendar' | 'gantt'
  readOnly?: boolean
  rejectSave?: boolean
}) {
  const [issues, setIssues] = useState<CollaborationIssue[]>(() =>
    initial.map(issue => ({ ...issue, can_edit: !readOnly }))
  )
  const [opened, setOpened] = useState('')
  const schedule = {
    issues,
    statuses,
    locale: 'zh-CN' as const,
    viewOptions: defaultScheduleViewOptions,
    onOpen: (issue: CollaborationIssue) => setOpened(issue.title),
    onSchedule: async (issue: CollaborationIssue, range: { startAt: string; dueAt: string }) =>
      setIssues(current =>
        current.map(value =>
          value.id === issue.id ? { ...value, start_at: range.startAt, due_at: range.dueAt } : value
        )
      ),
  }
  return (
    <div className="flex h-[720px] min-h-0 flex-col gap-3">
      <p className="text-sm text-text-muted">
        看板卡片可拖拽；键盘按空格拾取，方向键移动，空格投放，Escape
        取消。日历和甘特支持移动及调整起止日期。
      </p>
      <div className="min-h-0 flex-1 overflow-auto">
        {view === 'board' ? (
          <ProjectBoardAdapter
            project={project}
            issues={issues}
            agents={[]}
            members={[]}
            taskBindings={[]}
            statuses={statuses}
            boardError={null}
            translate={createCollaborationTranslator('zh-CN')}
            labels={{
              groupBy: '分组',
              groupStatus: '状态',
              groupPriority: '优先级',
              groupAssignee: '人员',
              groupTag: '标签',
              noIssues: '暂无任务',
              noPriority: '无优先级',
              noTag: '无标签',
              search: '搜索',
              unassigned: '未分配',
            }}
            onCreateIssue={() => {}}
            onOpen={issue => setOpened(issue.title)}
            onMove={async (_issue, mutation) => {
              if (rejectSave) throw new Error('保存失败示例：保留原数据')
              setIssues(mutation.optimisticItems)
            }}
          />
        ) : view === 'calendar' ? (
          <ProjectCalendarView {...schedule} />
        ) : (
          <ProjectGanttView {...schedule} />
        )}
      </div>
      <output className="text-xs text-text-muted" data-testid="planning-story-opened">
        {opened}
      </output>
    </div>
  )
}
const meta = {
  title: 'Business/PlanningDragAndDrop',
  component: Example,
  parameters: {
    docs: {
      description: {
        component:
          '真实看板、日历和甘特视图。看板使用 SDK createTransfer；日历/甘特使用 SDK bindDrag、预览与自动滚动，复用原有日期及持久化模型。',
      },
    },
  },
} satisfies Meta<typeof Example>
export default meta
type Story = StoryObj<typeof meta>
export const Board: Story = { args: { view: 'board' } }
export const Calendar: Story = { args: { view: 'calendar' } }
export const Gantt: Story = { args: { view: 'gantt' } }
export const ReadOnly: Story = { args: { view: 'board', readOnly: true } }
export const PersistFailure: Story = { args: { view: 'board', rejectSave: true } }
