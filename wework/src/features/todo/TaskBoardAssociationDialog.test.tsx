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
        items={[
          first,
          second,
          item('DEV-3', '无权限任务', { can_edit: false }),
          item('DEV-4', '不可查看的任务', { can_view_detail: false }),
        ]}
        loading={false}
        pending={false}
        onClose={vi.fn()}
        onCreate={onCreate}
        onSelect={onSelect}
      />
    )

    expect(screen.queryByTestId('task-board-association-item-DEV-3')).not.toBeInTheDocument()
    expect(screen.queryByTestId('task-board-association-item-DEV-4')).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: '关联已有看板任务' })).toHaveFocus()
    await user.type(screen.getByTestId('task-board-association-search'), '没有这个任务')
    expect(screen.getByRole('status')).toHaveTextContent('未找到匹配的看板任务')
    expect(screen.queryByTestId('task-board-association-item-DEV-1')).not.toBeInTheDocument()
    await user.clear(screen.getByTestId('task-board-association-search'))
    expect(screen.getByTestId('task-board-association-item-DEV-1')).toBeInTheDocument()
    await user.type(screen.getByTestId('task-board-association-search'), '搜索')
    expect(screen.queryByTestId('task-board-association-item-DEV-1')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('task-board-association-item-DEV-2'))
    expect(onSelect).toHaveBeenCalledWith(second)

    await user.click(screen.getByTestId('task-board-association-create'))
    expect(onCreate).toHaveBeenCalledOnce()
  })

  test.each([0, 1, 40])(
    'preserves a create click when loading resolves to %i existing cards',
    async count => {
      const user = userEvent.setup()
      const onCreate = vi.fn()
      const onSelect = vi.fn()
      const props = {
        project: project('target', '研发看板'),
        currentProject: null,
        pending: false,
        onClose: vi.fn(),
        onCreate,
        onSelect,
      }
      const { rerender } = render(<TaskBoardAssociationDialog {...props} loading items={[]} />)
      const create = screen.getByTestId('task-board-association-create')
      expect(screen.getByTestId('task-board-association-list')).toHaveAttribute('aria-busy', 'true')
      await user.pointer({ target: create, keys: '[MouseLeft>]' })

      rerender(
        <TaskBoardAssociationDialog
          {...props}
          loading={false}
          items={Array.from({ length: count }, (_, index) => item(`DEV-${index}`, `任务 ${index}`))}
        />
      )

      expect(screen.getByTestId('task-board-association-create')).toBe(create)
      expect(screen.getByTestId('task-board-association-list')).toHaveAttribute(
        'aria-busy',
        'false'
      )
      expect(screen.queryByTestId('task-board-association-loading')).not.toBeInTheDocument()
      await user.pointer({ keys: '[/MouseLeft]' })
      expect(onCreate).toHaveBeenCalledOnce()
      expect(onSelect).not.toHaveBeenCalled()
    }
  )

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
