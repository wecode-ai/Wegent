import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import '@/i18n'
import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import type { ProjectSpaceApi } from './projectSpaceSelection'
import { WorkItemContextPanel } from './WorkItemContextPanel'

const project: CloudProject = {
  id: 'default-work-items',
  public_id: 'default-work-items',
  project_key: 'WORK',
  name: '工作项',
  description: '',
  project_store: 'local',
  task_provider: 'local',
  provider_config: {},
  created_by_user_id: 0,
  status: 'active',
  tags: [],
  version: 1,
  created_at: '2026-08-15T00:00:00Z',
  updated_at: '2026-08-15T00:00:00Z',
}

const item: CloudLoopItem = {
  id: 'WORK-1',
  cloud_project_id: project.id,
  sequence_number: 1,
  parent_id: null,
  created_by_user_id: 0,
  assignee_user_id: null,
  title: '验证工作项与任务执行关系',
  description: '一个工作项可以关联多次任务执行。',
  status: 'in_progress',
  priority: 'high',
  due_at: null,
  tags: [],
  sort_order: 0,
  current_delivery_id: null,
  version: 1,
  created_at: '2026-08-15T00:00:00Z',
  updated_at: '2026-08-15T00:00:00Z',
  completed_at: null,
}

describe('WorkItemContextPanel', () => {
  test('shows the work item and opens a related task execution', async () => {
    const user = userEvent.setup()
    const onOpenTask = vi.fn()
    const onOpenBoard = vi.fn()
    const api = {
      listTaskBindings: vi.fn().mockResolvedValue([
        {
          id: 7,
          loop_item_id: item.id,
          task_user_id: 0,
          device_id: 'local-device',
          task_id: 'runtime-1',
          task_title: '第一次执行',
          backend_task_id: null,
          linked_at: '2026-08-15T00:00:00Z',
        },
      ]),
    } as unknown as ProjectSpaceApi

    render(
      <WorkItemContextPanel
        api={api}
        project={project}
        item={item}
        currentTask={{ deviceId: 'local-device', taskId: 'runtime-1' }}
        onOpenBoard={onOpenBoard}
        onOpenTask={onOpenTask}
      />
    )

    expect(screen.getByTestId('work-item-context-panel')).toHaveTextContent(
      'WORK-1 · 验证工作项与任务执行关系'
    )
    await waitFor(() =>
      expect(screen.getByTestId('work-item-execution-7')).toHaveTextContent('当前')
    )

    await user.click(screen.getByTestId('work-item-execution-7'))
    expect(onOpenTask).toHaveBeenCalledWith({
      deviceId: 'local-device',
      taskId: 'runtime-1',
    })

    await user.click(screen.getByTestId('work-item-open-board'))
    expect(onOpenBoard).toHaveBeenCalledOnce()
  })

  test('shows a human-readable label when priority is unset', async () => {
    const api = {
      listTaskBindings: vi.fn().mockResolvedValue([]),
    } as unknown as ProjectSpaceApi

    render(
      <WorkItemContextPanel
        api={api}
        project={project}
        item={{ ...item, priority: 'none' }}
        currentTask={{ deviceId: 'local-device', taskId: 'runtime-1' }}
        onOpenBoard={vi.fn()}
        onOpenTask={vi.fn()}
      />
    )

    expect(screen.getByTestId('work-item-context-panel')).toHaveTextContent('优先级未设置')
    expect(screen.getByTestId('work-item-context-panel')).not.toHaveTextContent('none')
  })

  test('shows an error when opening a related task fails', async () => {
    const api = {
      listTaskBindings: vi.fn().mockResolvedValue([
        {
          id: 7,
          loop_item_id: item.id,
          task_user_id: 0,
          device_id: 'local-device',
          task_id: 'runtime-1',
          task_title: '第一次执行',
          backend_task_id: null,
          linked_at: '2026-08-15T00:00:00Z',
        },
      ]),
    } as unknown as ProjectSpaceApi

    render(
      <WorkItemContextPanel
        api={api}
        project={project}
        item={item}
        currentTask={{ deviceId: 'local-device', taskId: 'runtime-1' }}
        onOpenBoard={vi.fn()}
        onOpenTask={vi.fn().mockRejectedValue(new Error('任务不存在'))}
      />
    )

    await userEvent.click(await screen.findByTestId('work-item-execution-7'))
    expect(await screen.findByTestId('work-item-executions-error')).toHaveTextContent('任务不存在')
  })
})
