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
  test('escapes the clipped workbench pane and restores focus when closed', () => {
    const props = {
      project: project('target', '研发看板'),
      currentProject: null,
      items: [],
      loading: false,
      pending: false,
      onClose: vi.fn(),
      onCreate: vi.fn(),
      onSelect: vi.fn(),
    }
    const pane = (open: boolean) => (
      <div style={{ overflow: 'hidden', isolation: 'isolate', transform: 'translateX(0)' }}>
        <button data-testid="association-trigger">加入项目</button>
        <TaskBoardAssociationDialog {...props} project={open ? props.project : null} />
      </div>
    )
    const { container, rerender } = render(pane(false))
    const trigger = screen.getByTestId('association-trigger')
    trigger.focus()

    rerender(pane(true))

    const dialog = screen.getByRole('dialog', { name: '关联到「研发看板」' })
    expect(container).not.toContainElement(dialog)
    expect(dialog.parentElement?.parentElement).toBe(document.body)
    expect(screen.getByTestId('task-board-association-search')).toHaveFocus()
    rerender(pane(false))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

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
    const onSelect = vi.fn()
    const selected = item('THREAD-1', '所选事项', { group_id: 'target' })

    render(
      <TaskBoardAssociationDialog
        project={project('target', '目标看板')}
        currentProject={project('source', '原看板')}
        items={[selected]}
        loading={false}
        pending={false}
        onClose={vi.fn()}
        onCreate={onCreate}
        onSelect={onSelect}
      />
    )

    await user.click(screen.getByTestId('task-board-association-item-THREAD-1'))
    expect(onCreate).not.toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: '移动任务关联' })).toHaveTextContent(
      '将任务关联到所选事项，替换原有关联。私人对话不会公开。'
    )

    await user.click(screen.getByTestId('task-board-move-confirm'))
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(selected)
    expect(onCreate).not.toHaveBeenCalled()
  })

  test('does not treat a classification project as a different owner or confirm before the public form', async () => {
    const user = userEvent.setup()
    const onCreate = vi.fn()
    const onSelect = vi.fn()
    const selected = item('same-owner', '同群事项', {
      group_id: 'group',
      cloud_project_id: 'group',
    })
    render(
      <TaskBoardAssociationDialog
        project={project('classification', '可选项目')}
        currentProject={{ ...project('group', '实际所属群'), resource_type: 'chat_group' }}
        items={[selected]}
        loading={false}
        pending={false}
        onClose={vi.fn()}
        onCreate={onCreate}
        onSelect={onSelect}
      />
    )
    await user.click(screen.getByTestId('task-board-association-item-same-owner'))
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(selected)
    expect(screen.queryByTestId('task-board-move-confirm')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('task-board-association-create'))
    expect(onCreate).toHaveBeenCalledOnce()
    expect(screen.queryByTestId('task-board-move-confirm')).not.toBeInTheDocument()
  })
})
