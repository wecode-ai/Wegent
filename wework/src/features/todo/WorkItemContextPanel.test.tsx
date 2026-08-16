import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'

import '@/i18n'
import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import type { ProjectSpaceApi } from './projectSpaceSelection'
import { WorkItemContextPanel } from './WorkItemContextPanel'

vi.mock('./TodoEditor', () => ({
  TodoEditor: ({
    item,
    allItems,
    presentation,
    workspacePanelFill,
    showPanelControls,
    headerActions,
    selectedTaskId,
    onUpdated,
    onOpenTaskConversation,
  }: {
    item: CloudLoopItem
    allItems: CloudLoopItem[]
    presentation?: string
    workspacePanelFill?: boolean
    showPanelControls?: boolean
    headerActions?: React.ReactNode
    selectedTaskId?: string | null
    onUpdated: (item: CloudLoopItem) => void
    onOpenTaskConversation?: (task: {
      id: number
      device_id: string
      task_id: string
      task_title: string | null
    }) => void
  }) => (
    <div
      data-testid="mock-todo-editor"
      data-presentation={presentation}
      data-fill={workspacePanelFill ? 'yes' : 'no'}
      data-controls={showPanelControls === false ? 'no' : 'yes'}
      data-selected-task={selectedTaskId}
      data-item-count={allItems.length}
    >
      {headerActions}
      <span>{item.title}</span>
      <button
        type="button"
        data-testid="mock-related-task"
        onClick={() =>
          onOpenTaskConversation?.({
            id: 2,
            device_id: 'local-device',
            task_id: 'runtime-2',
            task_title: '第二个任务',
          })
        }
      >
        打开相关任务
      </button>
      <button
        type="button"
        data-testid="mock-update-item"
        onClick={() => onUpdated({ ...item, title: '更新后的工作项', version: item.version + 1 })}
      >
        更新
      </button>
    </div>
  ),
}))

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
  test('reuses the workspace work-item editor and opens related tasks', async () => {
    const user = userEvent.setup()
    const onOpenTask = vi.fn()
    const onOpenBoard = vi.fn()
    const child = { ...item, id: 'WORK-2', parent_id: item.id, title: '子工作项' }
    const api = {
      listLoopItems: vi.fn().mockResolvedValue({ items: [item, child] }),
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

    const editor = screen.getByTestId('mock-todo-editor')
    expect(editor).toHaveAttribute('data-presentation', 'workspace-panel')
    expect(editor).toHaveAttribute('data-fill', 'yes')
    expect(editor).toHaveAttribute('data-controls', 'no')
    expect(editor).toHaveAttribute('data-selected-task', 'runtime-1')
    await waitFor(() => expect(editor).toHaveAttribute('data-item-count', '2'))

    await user.click(screen.getByTestId('mock-related-task'))
    expect(onOpenTask).toHaveBeenCalledWith({
      deviceId: 'local-device',
      taskId: 'runtime-2',
    })

    await user.click(screen.getByTestId('work-item-open-board'))
    expect(onOpenBoard).toHaveBeenCalledOnce()
  })

  test('keeps edits in the shared detail component', async () => {
    const api = {
      listLoopItems: vi.fn().mockResolvedValue({ items: [item] }),
    } as unknown as ProjectSpaceApi

    render(
      <WorkItemContextPanel
        api={api}
        project={project}
        item={item}
        currentTask={{ deviceId: 'local-device', taskId: 'runtime-1' }}
        onOpenBoard={vi.fn()}
        onOpenTask={vi.fn()}
      />
    )

    await userEvent.click(screen.getByTestId('mock-update-item'))
    expect(screen.getByTestId('mock-todo-editor')).toHaveTextContent('更新后的工作项')
  })
})
