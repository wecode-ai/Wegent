import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import '@/i18n'
import { act, render, screen, waitFor } from '@testing-library/react'
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
  it('assigns immediately, keeps the failed choice and retries without a save action', async () => {
    const api = setup()
    api.assignLoopItem.mockRejectedValueOnce(new Error('Assignment rejected'))
    const user = userEvent.setup()
    await user.click(screen.getByTestId('cloud-todo-detail-assignee'))
    await user.click(await screen.findByTestId('cloud-todo-detail-assignee-option-user:5'))
    expect(await screen.findByText('Assignment rejected')).toBeVisible()
    expect(screen.getByTestId('cloud-todo-state-assignee')).toHaveTextContent('张三')
    expect(screen.queryByTestId('cloud-todo-save')).toBeNull()
    await user.click(screen.getByTestId('cloud-todo-field-retry'))
    await waitFor(() => expect(api.assignLoopItem).toHaveBeenCalledTimes(2))
    expect(api.assignLoopItem).toHaveBeenLastCalledWith(
      '11',
      'WEG-1',
      expect.objectContaining({ notifyAssignee: true })
    )
    await waitFor(() => expect(screen.queryByTestId('cloud-todo-save-error')).toBeNull())
  })

  it('clears the owner immediately and shows the add-owner entry', async () => {
    const api = setup({ assignee_user_id: 5, assignee_name: '张三', assignee_agent_id: null })
    const user = userEvent.setup()
    await user.click(screen.getByTestId('cloud-todo-detail-assignee'))
    await user.click(await screen.findByTestId('cloud-todo-detail-assignee-option-empty'))
    await waitFor(() =>
      expect(api.updateLoopItem).toHaveBeenLastCalledWith('WEG-1', {
        version: 1,
        assignee_user_id: null,
        assignee_agent_id: null,
        assignee_team_id: null,
      })
    )
    expect(
      screen.getByTestId('cloud-todo-state-assignee').querySelector('strong')
    ).toHaveTextContent('未指派')
    expect(screen.queryByTestId('cloud-todo-save')).toBeNull()
    expect(api.assignLoopItem).not.toHaveBeenCalled()
  })

  it('does not assign while searching or dismissing the picker', async () => {
    const api = setup()
    const user = userEvent.setup()
    await user.click(screen.getByTestId('cloud-todo-detail-assignee'))
    await user.type(screen.getByTestId('cloud-todo-detail-assignee-search'), '张三')
    await user.keyboard('{Escape}')
    expect(api.assignLoopItem).not.toHaveBeenCalled()
    expect(api.onClose).not.toHaveBeenCalled()
  })

  it('allows silent assignment before selecting the new owner', async () => {
    const api = setup()
    const user = userEvent.setup()
    await user.click(screen.getByTestId('cloud-todo-detail-assignee'))
    await user.click(screen.getByTestId('cloud-todo-assignee-notify'))
    await user.click(await screen.findByRole('option', { name: '张三' }))
    await waitFor(() =>
      expect(api.assignLoopItem).toHaveBeenCalledWith(
        '11',
        'WEG-1',
        expect.objectContaining({ notifyAssignee: false })
      )
    )
    expect(screen.queryByTestId('cloud-todo-save')).toBeNull()
  })

  it('keeps the picker usable while an assignment is pending', async () => {
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
    expect(api.assignLoopItem).toHaveBeenCalledOnce()
    expect(screen.getByTestId('cloud-todo-detail-assignee')).toBeEnabled()
    expect(screen.queryByTestId('cloud-todo-save')).toBeNull()
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
    expect(screen.getByTestId('cloud-todo-state-assignee')).toHaveTextContent('张三')
  })

  it('restores the saved owner on a routing rejection and retries the intended assignment', async () => {
    const api = setup()
    api.assignLoopItem.mockRejectedValueOnce(
      Object.assign(new Error('Runner conflict'), {
        detail: {
          error_code: 'ISSUE_RUNNER_CONFLICT',
          routing_context: {
            reason: 'policy_mismatch',
            agent_name: 'Conflicting Agent',
            bound_environment: { id: '1', name: 'Original device' },
            policy_environment: { id: '2', name: 'Other device' },
          },
        },
      })
    )
    const user = userEvent.setup()
    await user.click(screen.getByTestId('cloud-todo-detail-assignee'))
    await user.click(await screen.findByRole('option', { name: '张三' }))
    const alert = await screen.findByTestId('cloud-todo-save-error')
    for (const text of [
      'Conflicting Agent',
      'Original device (1)',
      'Other device (2)',
      'ISSUE_RUNNER_CONFLICT',
    ])
      expect(alert).toHaveTextContent(text)
    expect(screen.getByTestId('cloud-todo-state-assignee')).toHaveTextContent('Codex 工程师')
    expect(api.updateLoopItem).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('cloud-todo-field-retry'))
    await waitFor(() => expect(api.assignLoopItem).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('cloud-todo-state-assignee')).toHaveTextContent('张三')
    expect(screen.queryByTestId('cloud-todo-save-error')).toBeNull()
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
