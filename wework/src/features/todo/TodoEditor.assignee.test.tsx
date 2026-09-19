import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@/i18n'
import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
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

function setup(overrides: Partial<CloudLoopItem> = {}, accessRole = 'Owner') {
  const initialItem = { ...item, ...overrides }
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
        presentation="workspace-panel"
        readFirst
        item={current}
        project={{ ...project, access_role: accessRole } as CloudProject}
        allItems={[current]}
        onUpdated={setCurrent}
        onClose={vi.fn()}
        api={api as never}
        currentUserId={1}
      />
    )
  }
  render(<Editor />)
  return api
}

describe('workspace Issue assignee', () => {
  it.each([true, false])('switches the completed automation owner with notify=%s', async notify => {
    const api = setup()
    const user = userEvent.setup()
    const summary = screen.getByTestId('cloud-todo-state-summary')
    const owner = within(summary).getByTestId('cloud-todo-state-assignee')
    expect(owner).toHaveTextContent('Codex 工程师')
    const select = within(owner).getByRole('button', { name: '负责人' })
    await user.click(select)
    await user.click(await screen.findByRole('option', { name: '张三' }))
    expect(owner.querySelector('strong')).toHaveTextContent('张三')
    await user.click(
      screen.getByTestId(
        notify
          ? 'wework-assignment-notify-confirm'
          : 'wework-assignment-notify-confirm-cancel-button'
      )
    )
    await user.click(screen.getByTestId('cloud-todo-save'))
    await vi.waitFor(() => {
      expect(api.assignLoopItem).toHaveBeenCalledWith('11', 'WEG-1', {
        version: 2,
        assigneeType: 'user',
        assigneeId: '5',
        notifyAssignee: notify,
      })
      expect(screen.queryByTestId('cloud-todo-save')).not.toBeInTheDocument()
    })
    expect(owner.querySelector('strong')).toHaveTextContent('张三')
  })

  it('clears the owner and shows the add-owner entry', async () => {
    const api = setup({ assignee_user_id: 5, assignee_name: '张三', assignee_agent_id: null })
    const user = userEvent.setup()
    await user.click(screen.getByTestId('cloud-todo-detail-assignee'))
    await user.click(await screen.findByTestId('cloud-todo-detail-assignee-option-empty'))
    const owner = screen.getByTestId('cloud-todo-state-assignee')
    expect(owner.querySelector('strong')).toHaveTextContent('未指派')
    await user.click(screen.getByTestId('cloud-todo-save'))
    await vi.waitFor(() =>
      expect(api.updateLoopItem).toHaveBeenLastCalledWith('WEG-1', {
        version: 2,
        assignee_user_id: null,
        assignee_agent_id: null,
        assignee_team_id: null,
      })
    )
    expect(api.assignLoopItem).not.toHaveBeenCalled()
  })

  it.each([
    { canEdit: false, role: 'Owner' },
    { canEdit: true, role: 'Developer' },
  ])('keeps the owner visible without assignment permission: %j', async ({ canEdit, role }) => {
    setup({ can_edit: canEdit }, role)
    expect(screen.getByTestId('cloud-todo-state-assignee')).toHaveTextContent('Codex 工程师')
    expect(screen.getByTestId('cloud-todo-detail-assignee')).toBeDisabled()
  })
})
