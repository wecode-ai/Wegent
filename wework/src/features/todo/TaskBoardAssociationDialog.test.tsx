import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'

import '@/i18n'
import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import { TaskBoardAssociationDialog } from './TaskBoardAssociationDialog'

function project(id: string, name: string): CloudProject {
  return {
    id,
    public_id: id,
    project_key: id.toUpperCase(),
    name,
    description: '',
    project_store: 'local',
    task_provider: 'local',
    provider_config: {},
    created_by_user_id: 1,
    status: 'active',
    tags: [],
    version: 1,
    created_at: '',
    updated_at: '',
  }
}

function item(id: string, title: string, overrides: Partial<CloudLoopItem> = {}): CloudLoopItem {
  return {
    id,
    cloud_project_id: 'target',
    sequence_number: 1,
    parent_id: null,
    created_by_user_id: 1,
    assignee_user_id: null,
    title,
    description: '',
    status: 'pending',
    priority: 'none',
    due_at: null,
    tags: [],
    sort_order: 1,
    current_delivery_id: null,
    version: 1,
    created_at: '',
    updated_at: '',
    completed_at: null,
    ...overrides,
  }
}

describe('TaskBoardAssociationDialog', () => {
  test('supports creating a card and searching editable existing cards', async () => {
    const user = userEvent.setup()
    const target = project('target', '研发看板')
    const first = item('DEV-1', '修复登录')
    const second = item('DEV-2', '优化搜索')
    const onCreate = vi.fn()
    const onSelect = vi.fn()

    render(
      <TaskBoardAssociationDialog
        project={target}
        currentProject={null}
        items={[first, second, item('DEV-3', '无权限任务', { can_edit: false })]}
        loading={false}
        pending={false}
        onClose={vi.fn()}
        onCreate={onCreate}
        onSelect={onSelect}
      />
    )

    expect(screen.queryByTestId('task-board-association-item-DEV-3')).not.toBeInTheDocument()
    await user.type(screen.getByTestId('task-board-association-search'), '搜索')
    expect(screen.queryByTestId('task-board-association-item-DEV-1')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('task-board-association-item-DEV-2'))
    expect(onSelect).toHaveBeenCalledWith(second)

    await user.click(screen.getByTestId('task-board-association-create'))
    expect(onCreate).toHaveBeenCalledOnce()
  })

  test('requires confirmation before moving a task from another board', async () => {
    const user = userEvent.setup()
    const onCreate = vi.fn()

    render(
      <TaskBoardAssociationDialog
        project={project('target', '目标看板')}
        currentProject={project('source', '原看板')}
        items={[]}
        loading={false}
        pending={false}
        onClose={vi.fn()}
        onCreate={onCreate}
        onSelect={vi.fn()}
      />
    )

    await user.click(screen.getByTestId('task-board-association-create'))
    expect(onCreate).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: '移动任务关联' })).toHaveTextContent('原看板')
    expect(screen.getByRole('dialog', { name: '移动任务关联' })).toHaveTextContent('目标看板')

    await user.click(screen.getByTestId('task-board-move-confirm'))
    expect(onCreate).toHaveBeenCalledOnce()
  })
})
