import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import '@/i18n'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { TodoEditor } from './TodoEditor'

const item = {
  id: 'WEG-1',
  cloud_project_id: '11',
  title: 'Completed automation',
  description: '',
  status: 'completed',
  priority: 'none',
  parent_id: null,
  due_at: null,
  tags: [],
  assignee_user_id: null,
  assignee_agent_id: 'agent-1',
  assignee_agent_name: 'Codex 工程师',
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
  version: 1,
  can_edit: true,
  workflow: {
    nodes: [{ id: 'step-1', name: 'Step 1', execution_mode: 'robot', status: 'completed' }],
  },
} as unknown as CloudLoopItem

const project = {
  id: '11',
  name: 'Project',
  access_role: 'Owner',
  current_user_id: 1,
} as CloudProject

function setup(
  overrides: Partial<CloudLoopItem> = {},
  accessRole = 'Owner',
  presentation: 'modal' | 'workspace-panel' = 'workspace-panel'
) {
  const initialItem = { ...item, ...overrides }
  const onClose = vi.fn()
  const api = {
    listDeliveries: vi.fn(async () => ({ items: [] })),
    listTaskBindings: vi.fn(async () => []),
    listLoopItemAttachments: vi.fn(async () => []),
    listLoopItemCollaborators: vi.fn(async () => []),
    listCloudProjectMembers: vi.fn(async () => [
      { id: 5, user_id: 5, user_name: '张三', email: null, role: 'Developer' },
    ]),
    updateLoopItem: vi.fn(async (_id, values) => ({ ...initialItem, ...values, version: 2 })),
    assignLoopItem: vi.fn(async () => ({
      ...initialItem,
      assignee_user_id: 5,
      assignee_name: '张三',
      assignee_agent_id: null,
      assignee_agent_name: null,
      version: 3,
    })),
  }
  function Editor() {
    const [current, setCurrent] = useState(initialItem)
    return (
      <TodoEditor
        mode="edit"
        presentation={presentation}
        readFirst
        item={current}
        project={{ ...project, access_role: accessRole } as CloudProject}
        allItems={[current]}
        onUpdated={setCurrent}
        onClose={onClose}
        api={api as never}
        currentUserId={1}
      />
    )
  }
  render(<Editor />)
  return { ...api, onClose }
}

describe('workspace Issue assignee', () => {
  it('retains the inline save action and draft after a rejected assignment', async () => {
    const api = setup()
    api.assignLoopItem.mockRejectedValueOnce(new Error('Assignment rejected'))
    const user = userEvent.setup()
    await user.click(screen.getByTestId('cloud-todo-detail-assignee'))
    await user.click(await screen.findByTestId('cloud-todo-detail-assignee-option-user:5'))
    await user.click(screen.getByTestId('cloud-todo-save-options'))
    await user.click(screen.getByTestId('cloud-todo-save-without-notification'))
    expect(await screen.findByText('Assignment rejected')).toBeVisible()
    const save = within(screen.getByTestId('cloud-todo-state-summary')).getByTestId(
      'cloud-todo-save'
    )
    expect(save).toBeEnabled()
    expect(save).toHaveTextContent('保存并通知')
    expect(screen.getByTestId('cloud-todo-state-assignee')).toHaveTextContent('张三')
    await user.click(save)
    await vi.waitFor(() => expect(screen.queryByTestId('cloud-todo-save')).not.toBeInTheDocument())
    expect(api.assignLoopItem).toHaveBeenNthCalledWith(
      1,
      '11',
      'WEG-1',
      expect.objectContaining({ notifyAssignee: false })
    )
    expect(api.assignLoopItem).toHaveBeenNthCalledWith(
      2,
      '11',
      'WEG-1',
      expect.objectContaining({ notifyAssignee: true })
    )
  })

  it('clears the owner and shows the add-owner entry', async () => {
    const api = setup({ assignee_user_id: 5, assignee_name: '张三', assignee_agent_id: null })
    const user = userEvent.setup()
    await user.click(screen.getByTestId('cloud-todo-detail-assignee'))
    await user.click(await screen.findByTestId('cloud-todo-detail-assignee-option-empty'))
    const owner = screen.getByTestId('cloud-todo-state-assignee')
    expect(owner.querySelector('strong')).toHaveTextContent('未指派')
    expect(screen.queryByTestId('cloud-todo-save-options')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('cloud-todo-save'))
    await vi.waitFor(() =>
      expect(api.updateLoopItem).toHaveBeenLastCalledWith('WEG-1', {
        version: 1,
        assignee_user_id: null,
        assignee_agent_id: null,
        assignee_team_id: null,
      })
    )
    expect(api.assignLoopItem).not.toHaveBeenCalled()
  })

  it('dismisses the notification menu with Escape and restores keyboard focus without saving', async () => {
    const api = setup()
    const user = userEvent.setup()
    await user.click(screen.getByTestId('cloud-todo-detail-assignee'))
    await user.click(await screen.findByRole('option', { name: '张三' }))
    const options = screen.getByTestId('cloud-todo-save-options')
    options.focus()
    await user.keyboard('{ArrowDown}')
    const silentSave = await screen.findByRole('menuitem', { name: '仅保存不通知' })
    await vi.waitFor(() => expect(silentSave).toHaveFocus())
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    await vi.waitFor(() => expect(options).toHaveFocus())
    expect(screen.getByTestId('cloud-todo-detail')).toBeInTheDocument()
    expect(api.onClose).not.toHaveBeenCalled()
    expect(api.assignLoopItem).not.toHaveBeenCalled()
    await user.keyboard('{ArrowDown}')
    await vi.waitFor(() =>
      expect(screen.getByRole('menuitem', { name: '仅保存不通知' })).toHaveFocus()
    )
    await user.keyboard('{Enter}')
    await vi.waitFor(() =>
      expect(api.assignLoopItem).toHaveBeenCalledWith(
        '11',
        'WEG-1',
        expect.objectContaining({ notifyAssignee: false })
      )
    )
  })

  it('disables both save actions while an assignment is pending', async () => {
    const api = setup()
    let complete!: (value: Awaited<ReturnType<typeof api.assignLoopItem>>) => void
    api.assignLoopItem.mockReturnValueOnce(
      new Promise(resolve => {
        complete = resolve
      })
    )
    const user = userEvent.setup()
    await user.click(screen.getByTestId('cloud-todo-detail-assignee'))
    await user.click(await screen.findByRole('option', { name: '张三' }))
    await user.click(screen.getByTestId('cloud-todo-save'))
    expect(screen.getByTestId('cloud-todo-save')).toBeDisabled()
    expect(screen.getByTestId('cloud-todo-save-options')).toBeDisabled()
    expect(screen.getByTestId('cloud-todo-save')).toHaveTextContent('保存中')
    await user.click(screen.getByTestId('cloud-todo-save-options'))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(api.assignLoopItem).toHaveBeenCalledOnce()
    await act(async () => {
      complete({
        ...item,
        assignee_user_id: 5,
        assignee_name: '张三',
        assignee_agent_id: null,
        assignee_agent_name: null,
        version: 2,
      })
    })
    expect(screen.queryByTestId('cloud-todo-save')).not.toBeInTheDocument()
  })

  it.each([
    { canViewDetail: false, role: 'Owner' },
    { canViewDetail: true, role: 'Viewer' },
  ])(
    'keeps the owner visible without assignment permission: %j',
    async ({ canViewDetail, role }) => {
      setup({ can_view_detail: canViewDetail }, role)
      expect(screen.getByTestId('cloud-todo-state-assignee')).toHaveTextContent('Codex 工程师')
      expect(screen.getByTestId('cloud-todo-detail-assignee')).toBeDisabled()
    }
  )

  it('keeps a Viewer Issue creator read-only under CP06 and CP07', () => {
    const api = setup({ created_by_user_id: 1 }, 'Viewer')
    expect(screen.getByTestId('cloud-todo-state-assignee')).toHaveTextContent('Codex 工程师')
    expect(screen.getByTestId('cloud-todo-detail-assignee')).toBeDisabled()
    expect(api.assignLoopItem).not.toHaveBeenCalled()
    expect(api.updateLoopItem).not.toHaveBeenCalled()
  })
})
