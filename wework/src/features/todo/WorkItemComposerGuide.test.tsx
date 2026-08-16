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
  test('shows a meaningful new-work-item choice without exposing the board name', async () => {
    const user = userEvent.setup()
    const onJoinExisting = vi.fn()
    render(<WorkItemComposerGuide onJoinExisting={onJoinExisting} />)

    expect(screen.getByTestId('project-space-context-pill')).toHaveTextContent('工作空间：新建')
    expect(screen.getByTestId('project-space-context-pill')).not.toHaveTextContent('我的任务')

    await user.click(screen.getByTestId('project-space-context-pill'))
    expect(screen.getByTestId('work-item-context-menu')).toHaveTextContent(
      '发送后创建一个工作空间，用来汇总后续关联的任务。'
    )
    expect(screen.getByTestId('work-item-create-option')).toHaveAttribute('aria-checked', 'true')

    await user.click(screen.getByTestId('work-item-join-existing-option'))
    expect(onJoinExisting).toHaveBeenCalledOnce()
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

  test('lists sibling tasks, marks the current task, and opens another task', async () => {
    const user = userEvent.setup()
    const onOpenTask = vi.fn()
    const api = {
      listTaskBindings: vi.fn().mockResolvedValue(taskBindings),
      findCloudContextForTask: vi.fn().mockResolvedValue(null),
    } as unknown as ProjectSpaceApi

    render(
      <WorkItemComposerGuide
        item={item}
        api={api}
        currentTask={{ deviceId: 'local-device', taskId: 'runtime-1' }}
        onOpenTask={onOpenTask}
      />
    )

    await waitFor(() => expect(api.listTaskBindings).toHaveBeenCalledWith('WORK-1'))
    await user.click(screen.getByTestId('project-space-context-pill'))

    expect(screen.getByTestId('work-item-task-1')).toHaveTextContent('当前任务')
    expect(screen.getByTestId('work-item-task-1')).toBeDisabled()
    await user.click(screen.getByTestId('work-item-task-2'))

    expect(onOpenTask).toHaveBeenCalledWith({
      deviceId: 'local-device',
      taskId: 'runtime-2',
    })
  })

  test('opens the work-item context from its dropdown action', async () => {
    const user = userEvent.setup()
    const onOpen = vi.fn()
    render(<WorkItemComposerGuide item={item} onOpen={onOpen} />)

    await user.click(screen.getByTestId('project-space-context-pill'))
    await user.click(screen.getByTestId('work-item-open-details'))

    expect(onOpen).toHaveBeenCalledOnce()
  })
})
