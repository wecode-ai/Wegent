import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import { TodoEditor } from './TodoEditor'

// Exercise the shared detail persistence contract independently of rich-text parsing.
vi.mock('./TaskDescriptionEditor', () => ({
  TaskDescriptionEditor: ({
    value,
    onChange,
  }: {
    value: string
    onChange(value: string): void
  }) => (
    <textarea
      data-testid="test-description"
      value={value}
      onChange={event => onChange(event.target.value)}
    />
  ),
}))

const initial = {
  id: 'PROPS-1',
  cloud_project_id: '11',
  title: 'Original',
  description: 'Saved description',
  status: 'inbox',
  priority: 'none',
  parent_id: null,
  due_at: null,
  tags: [],
  assignee_user_id: null,
  assignee_agent_id: null,
  created_at: '2026-11-05T00:00:00Z',
  updated_at: '2026-11-05T00:00:00Z',
  version: 1,
  can_edit: true,
} as CloudLoopItem
const project = {
  id: '11',
  name: 'Properties',
  task_provider: 'local',
  project_store: 'local',
  access_role: 'Owner',
} as CloudProject

function setup(assignmentError?: Error) {
  let persisted = initial
  const updateLoopItem = vi.fn(async (_id: string, values: Partial<CloudLoopItem>) => {
    persisted = { ...persisted, ...values, version: persisted.version + 1 }
    return persisted
  })
  const api = {
    listDeliveries: vi.fn(async () => ({ items: [] })),
    listTaskBindings: vi.fn(async () => []),
    listLoopItemAttachments: vi.fn(async () => []),
    listLoopItemCollaborators: vi.fn(async () => []),
    listCloudProjectMembers: vi.fn(async () => [
      { id: 8, user_id: 8, user_name: 'Member', role: 'Developer' },
    ]),
    assignLoopItem: vi.fn(async () => {
      if (assignmentError) throw assignmentError
      return { ...persisted, assignee_user_id: 8, version: persisted.version + 1 }
    }),
    listMilestones: vi.fn(async () => [
      { id: 'ms-release', project_id: '11', title: 'Release target', state: 'open', version: 1 },
      { id: 'ms-other', project_id: '11', title: 'Other milestone', state: 'open', version: 1 },
    ]),
    updateLoopItem,
  }
  function Editor() {
    const [item, setItem] = useState(initial)
    return (
      <TodoEditor
        mode="edit"
        item={item}
        project={project}
        allItems={[item]}
        api={api as never}
        onUpdated={setItem}
        onClose={vi.fn()}
      />
    )
  }
  render(<Editor />)
  return { updateLoopItem, read: () => persisted }
}

describe('immediate Issue properties', () => {
  it('saves title and priority independently while description requires explicit save', async () => {
    const user = userEvent.setup()
    const { updateLoopItem, read } = setup()
    fireEvent.change(screen.getByTestId('test-description'), {
      target: { value: 'Unsubmitted description' },
    })
    const title = screen.getByTestId('cloud-todo-detail-title')
    fireEvent.change(title, { target: { value: 'New title' } })
    fireEvent.blur(title)
    await waitFor(() =>
      expect(updateLoopItem).toHaveBeenCalledWith(initial.id, { version: 1, title: 'New title' })
    )
    await user.selectOptions(screen.getByTestId('cloud-todo-detail-priority'), 'urgent')
    await waitFor(() =>
      expect(updateLoopItem).toHaveBeenLastCalledWith(initial.id, {
        version: 2,
        priority: 'urgent',
      })
    )
    expect(read().description).toBe('Saved description')
    expect(screen.getByTestId('test-description')).toHaveValue('Unsubmitted description')
    await user.click(screen.getByTestId('cloud-todo-save'))
    await waitFor(() =>
      expect(updateLoopItem).toHaveBeenLastCalledWith(initial.id, {
        version: 3,
        description: 'Unsubmitted description',
      })
    )
    expect(read()).toMatchObject({
      title: 'New title',
      priority: 'urgent',
      description: 'Unsubmitted description',
    })
  })

  it('keeps description Save available after assignment fails', async () => {
    const user = userEvent.setup()
    const { updateLoopItem } = setup(new Error('Assignment rejected'))
    fireEvent.change(screen.getByTestId('test-description'), {
      target: { value: 'Independent description' },
    })
    await user.click(screen.getByTestId('cloud-todo-detail-assignee'))
    await user.click(await screen.findByTestId('cloud-todo-detail-assignee-option-user:8'))
    expect(await screen.findByText('Assignment rejected')).toBeVisible()
    expect(screen.getByTestId('cloud-todo-save')).toBeEnabled()
    await user.click(screen.getByTestId('cloud-todo-save'))
    await waitFor(() =>
      expect(updateLoopItem).toHaveBeenLastCalledWith(initial.id, {
        version: 1,
        description: 'Independent description',
      })
    )
  })

  it('searches milestone choices, saves immediately and can clear the selection', async () => {
    const user = userEvent.setup()
    const { updateLoopItem } = setup()
    await waitFor(() => expect(screen.getByTestId('issue-milestone')).toBeEnabled())
    await user.click(screen.getByTestId('issue-milestone'))
    await user.type(screen.getByTestId('issue-milestone-search'), 'release')
    expect(screen.queryByRole('option', { name: 'Other milestone' })).toBeNull()
    await user.click(screen.getByRole('option', { name: 'Release target' }))
    await waitFor(() =>
      expect(updateLoopItem).toHaveBeenLastCalledWith(initial.id, {
        version: 1,
        milestone_id: 'ms-release',
      })
    )
    expect(screen.getByTestId('issue-milestone')).toHaveTextContent('Release target')
    await user.click(screen.getByTestId('issue-milestone'))
    await user.click(screen.getByRole('option', { name: '未设置' }))
    await waitFor(() =>
      expect(updateLoopItem).toHaveBeenLastCalledWith(initial.id, {
        version: 2,
        milestone_id: null,
      })
    )
  })
})
