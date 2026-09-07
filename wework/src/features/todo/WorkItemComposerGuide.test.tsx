import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import '@/i18n'
import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import type { ProjectSpaceApi } from '@/features/todo/projectSpaceSelection'
import { WorkItemComposerGuide } from './WorkItemComposerGuide'

const project = {
  id: 'work-items',
  project_key: 'WORK',
  name: '我的任务',
  project_store: 'local',
} as CloudProject

const teamProject = {
  ...project,
  id: 'team-work',
  project_key: 'TEAM',
  name: '团队研发',
} as CloudProject

const item = {
  id: 'WORK-1',
  title: '完成默认工作项流程',
  status: 'in_review',
  assignee_name: '张三',
  assignee_agent_name: null,
  ai_state: null,
} as CloudLoopItem

const taskBindings = [
  {
    id: 1,
    loop_item_id: 'WORK-1',
    task_user_id: 7,
    device_id: 'local-device',
    task_id: 'runtime-1',
    task_title: '当前执行任务',
    backend_task_id: null,
    linked_at: '2026-08-16T00:00:00Z',
  },
  {
    id: 2,
    loop_item_id: 'WORK-1',
    task_user_id: 7,
    device_id: 'local-device',
    task_id: 'runtime-2',
    task_title: '补充验证任务',
    backend_task_id: null,
    linked_at: '2026-08-16T00:01:00Z',
  },
]

describe('WorkItemComposerGuide', () => {
  test('shows the default workspace as the selected destination for a new task', async () => {
    const user = userEvent.setup()
    const onSelectProject = vi.fn()
    render(
      <WorkItemComposerGuide
        project={project}
        projects={[teamProject]}
        toolbar
        onSelectProject={onSelectProject}
      />
    )

    const trigger = screen.getByTestId('project-space-context-pill')
    expect(trigger).toHaveTextContent('我的任务')
    expect(trigger).toHaveClass(
      'h-8',
      'gap-1.5',
      'rounded-lg',
      'px-2',
      'text-sm',
      'font-normal',
      'text-text-secondary'
    )
    expect(trigger).not.toHaveClass('text-primary', 'font-medium')

    await user.click(trigger)
    const menu = screen.getByTestId('work-item-context-menu')
    expect(menu).not.toHaveTextContent('我的任务')
    expect(screen.getByTestId('work-item-workspace-option-team-work')).toHaveTextContent('团队研发')

    await user.click(screen.getByTestId('work-item-workspace-option-team-work'))
    expect(onSelectProject).toHaveBeenCalledWith(teamProject)
  })

  test('uses the goal as primary context and only shows work-item status plus sibling tasks', async () => {
    const api = {
      listTaskBindings: vi.fn().mockResolvedValue(taskBindings),
      findCloudContextForTask: vi.fn().mockResolvedValue({
        project,
        loop_item: item,
      }),
    } as unknown as ProjectSpaceApi

    render(
      <WorkItemComposerGuide
        item={item}
        api={api}
        currentTask={{ deviceId: 'local-device', taskId: 'runtime-1' }}
        goalPresent
      />
    )

    await waitFor(() =>
      expect(screen.getByTestId('work-item-guide-summary-details')).toHaveTextContent(
        '2 个任务，还有 1 个'
      )
    )
    expect(screen.getByTestId('project-space-context-pill')).toHaveTextContent('工作空间')
    expect(screen.getByTestId('work-item-guide-summary-status')).toHaveTextContent('等待确认')
    expect(screen.queryByTestId('work-item-guide-summary-title')).not.toBeInTheDocument()
    expect(screen.getByTestId('project-space-context-pill')).not.toHaveTextContent('我的任务')
    expect(screen.getByTestId('project-space-context-pill')).not.toHaveTextContent('WORK-1')
    expect(screen.getByTestId('project-space-context-pill')).not.toHaveTextContent('下一步')
  })

  test('shows the work-item title when there is no active goal', async () => {
    const api = {
      listTaskBindings: vi.fn().mockResolvedValue(taskBindings),
      findCloudContextForTask: vi.fn().mockResolvedValue(null),
    } as unknown as ProjectSpaceApi

    render(
      <WorkItemComposerGuide
        item={item}
        api={api}
        currentTask={{ deviceId: 'local-device', taskId: 'runtime-1' }}
      />
    )

    await waitFor(() =>
      expect(screen.getByTestId('work-item-guide-summary-title')).toHaveTextContent(
        '完成默认工作项流程'
      )
    )
    expect(screen.getByTestId('work-item-guide-summary-status')).toHaveTextContent('等待确认')
  })

  test('refreshes the work-item status when runtime execution settles', async () => {
    const runningItem = { ...item, status: 'in_progress' as const }
    const api = {
      listTaskBindings: vi.fn().mockResolvedValue(taskBindings),
      findCloudContextForTask: vi
        .fn()
        .mockResolvedValueOnce({ project, loop_item: runningItem })
        .mockResolvedValueOnce({ project, loop_item: item }),
    } as unknown as ProjectSpaceApi
    const props = {
      item: runningItem,
      api,
      currentTask: { deviceId: 'local-device', taskId: 'runtime-1' },
    }
    const { rerender } = render(<WorkItemComposerGuide {...props} refreshKey="running" />)

    await waitFor(() =>
      expect(screen.getByTestId('work-item-guide-summary-status')).toHaveTextContent('进行中')
    )

    rerender(<WorkItemComposerGuide {...props} refreshKey="done" />)

    await waitFor(() =>
      expect(screen.getByTestId('work-item-guide-summary-status')).toHaveTextContent('等待确认')
    )
    expect(api.findCloudContextForTask).toHaveBeenCalledTimes(2)
  })

  test('keeps a runtime status override ahead of a lagging refreshed context', async () => {
    const runningItem = { ...item, status: 'in_progress' as const }
    const refreshedItem = { ...item, title: 'Refreshed stale item' }
    const api = {
      listTaskBindings: vi.fn().mockResolvedValue(taskBindings),
      findCloudContextForTask: vi.fn().mockResolvedValue({
        project,
        loop_item: refreshedItem,
      }),
    } as unknown as ProjectSpaceApi

    render(
      <WorkItemComposerGuide
        item={runningItem}
        statusOverride="in_progress"
        api={api}
        currentTask={{ deviceId: 'local-device', taskId: 'runtime-1' }}
        refreshKey="running"
      />
    )

    await waitFor(() =>
      expect(screen.getByTestId('work-item-guide-summary-title')).toHaveTextContent(
        'Refreshed stale item'
      )
    )
    expect(screen.getByTestId('work-item-guide-summary-status')).toHaveTextContent('进行中')
  })

  test('summarizes sibling tasks without opening a second menu', async () => {
    const api = {
      listTaskBindings: vi.fn().mockResolvedValue(taskBindings),
      findCloudContextForTask: vi.fn().mockResolvedValue(null),
    } as unknown as ProjectSpaceApi

    render(
      <WorkItemComposerGuide
        item={item}
        api={api}
        currentTask={{ deviceId: 'local-device', taskId: 'runtime-1' }}
      />
    )

    await waitFor(() =>
      expect(screen.getByTestId('work-item-guide-summary-details')).toHaveTextContent(
        '2 个任务，还有 1 个'
      )
    )
    expect(screen.queryByTestId('work-item-context-menu')).not.toBeInTheDocument()
    expect(screen.queryByTestId('work-item-task-1')).not.toBeInTheDocument()
  })

  test('exposes direct actions for details and the full workspace', async () => {
    const user = userEvent.setup()
    const onOpen = vi.fn()
    const onOpenBoard = vi.fn()
    render(<WorkItemComposerGuide item={item} onOpen={onOpen} onOpenBoard={onOpenBoard} />)

    const detailsButton = screen.getByTestId('work-item-open-details')
    const workspaceButton = screen.getByTestId('work-item-open-board-menu')
    expect(detailsButton).toHaveAccessibleName('查看 Issue 详情')
    expect(workspaceButton).toHaveAccessibleName('在工作空间中打开')
    expect(detailsButton).toHaveTextContent('')
    expect(workspaceButton).toHaveTextContent('')

    await user.click(detailsButton)
    expect(onOpen).toHaveBeenCalledOnce()

    await user.click(workspaceButton)
    expect(onOpenBoard).toHaveBeenCalledOnce()
    expect(screen.queryByTestId('work-item-context-menu')).not.toBeInTheDocument()
  })

  test('allows an already linked task to choose another board', async () => {
    const user = userEvent.setup()
    const onSelectProject = vi.fn()
    render(
      <WorkItemComposerGuide
        project={project}
        item={item}
        projects={[project, teamProject]}
        onSelectProject={onSelectProject}
      />
    )

    await user.click(screen.getByTestId('work-item-change-board'))
    await user.click(screen.getByTestId('work-item-workspace-option-team-work'))

    expect(onSelectProject).toHaveBeenCalledWith(teamProject)
  })
})
