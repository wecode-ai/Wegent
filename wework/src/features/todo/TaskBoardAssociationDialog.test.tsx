import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'

import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import '@/i18n'
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
  test('prevents duplicate actions while an association is pending', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const onCreate = vi.fn()
    const onSelect = vi.fn()
    render(
      <TaskBoardAssociationDialog
        project={project('target', '研发看板')}
        currentProject={null}
        items={[item('DEV-1', '修复登录')]}
        loading={false}
        pending
        onClose={onClose}
        onCreate={onCreate}
        onSelect={onSelect}
      />
    )

    for (const id of ['create', 'close', 'search', 'item-DEV-1']) {
      const control = screen.getByTestId(`task-board-association-${id}`)
      expect(control).toBeDisabled()
      await user.click(control)
    }
    await user.keyboard('{Escape}')
    expect(onCreate).not.toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
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
