import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

function setup(assignmentError?: Error, workspacePanel = false, backend = false) {
  let replaceIssue!: (item: CloudLoopItem) => void
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
    replaceIssue = setItem
    return (
      <TodoEditor
        mode="edit"
        presentation={workspacePanel ? 'workspace-panel' : 'modal'}
        readFirst={workspacePanel}
        item={item}
        project={backend ? { ...project, project_store: 'backend' } : project}
        allItems={[item]}
        api={api as never}
        onUpdated={setItem}
        onClose={vi.fn()}
      />
    )
  }
  render(<Editor />)
  return {
    updateLoopItem,
    read: () => persisted,
    replaceIssue: (item: CloudLoopItem) => act(() => replaceIssue(item)),
  }
}

describe('immediate Issue properties', () => {
  it('opens the parent picker from visible expanded properties and returns keyboard focus', async () => {
    setup(undefined, true)
    const parent = screen.getByTestId('cloud-todo-detail-parent')
    expect(parent).not.toBeVisible()
    await userEvent.click(screen.getByTestId('cloud-todo-more-properties'))
    expect(parent).toBeVisible()
    await userEvent.click(parent)
    const search = await screen.findByTestId('cloud-todo-detail-parent-search')
    expect(search).toHaveFocus()
    await userEvent.type(search, 'Missing parent')
    expect(await screen.findByText('没有匹配的父任务')).toBeVisible()
    await userEvent.keyboard('{Escape}')
    expect(parent).toHaveFocus()
    expect(parent).toBeVisible()
    await userEvent.click(screen.getByTestId('cloud-todo-more-properties'))
    await userEvent.tab()
    expect(parent).not.toHaveFocus()
  })

  it('isolates pending security writes when switching Issues', async () => {
    const { updateLoopItem, replaceIssue } = setup(undefined, true, true)
    const pending = Promise.withResolvers<CloudLoopItem>()
    updateLoopItem.mockImplementationOnce(() => pending.promise)
    fireEvent.change(screen.getByTestId('cloud-issue-security-level'), {
      target: { value: 'related' },
    })
    expect(screen.getByTestId('cloud-issue-security-level')).toBeDisabled()
    replaceIssue({ ...initial, id: 'PROPS-2', security_level: 'open' })
    expect(screen.getByTestId('cloud-issue-security-level')).not.toBeDisabled()
    await act(async () => pending.resolve({ ...initial, security_level: 'related', version: 2 }))
    expect(screen.getByTestId('cloud-issue-security-level')).toHaveValue('open')
    fireEvent.change(screen.getByTestId('cloud-issue-security-level'), {
      target: { value: 'related' },
    })
    await waitFor(() => expect(updateLoopItem).toHaveBeenCalledTimes(2))
    expect(updateLoopItem.mock.calls[1]).toEqual([
      'PROPS-2',
      { security_level: 'related', version: 1 },
    ])
  })

  it('does not close another Issue editor when an earlier description write finishes', async () => {
    const { updateLoopItem, replaceIssue } = setup(undefined, true)
    fireEvent.click(screen.getByTestId('issue-description-edit'))
    fireEvent.change(screen.getByTestId('test-description'), { target: { value: 'Same text' } })
    const pending = Promise.withResolvers<CloudLoopItem>()
    updateLoopItem.mockImplementationOnce(() => pending.promise)
    fireEvent.click(screen.getByTestId('cloud-todo-save'))
    replaceIssue({ ...initial, id: 'PROPS-2', description: 'Same text' })
    fireEvent.click(await screen.findByTestId('issue-description-edit'))
    expect(screen.getByTestId('cloud-todo-cancel-content-edit')).toBeVisible()
    await act(async () => pending.resolve({ ...initial, description: 'Same text', version: 2 }))
    expect(screen.getByTestId('cloud-todo-cancel-content-edit')).toBeVisible()
    expect(screen.getByTestId('test-description')).toHaveValue('Same text')
  })

  it('preserves a cleared date through an older acknowledgement, a newer failure and retry', async () => {
    const { updateLoopItem } = setup()
    const first = Promise.withResolvers<CloudLoopItem>()
    const latest = Promise.withResolvers<CloudLoopItem>()
    updateLoopItem
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => latest.promise)
      .mockResolvedValueOnce({ ...initial, due_at: null, version: 3 })
    fireEvent.click(screen.getByRole('button', { name: '时间范围' }))
    const due = await screen.findByTestId('cloud-todo-detail-due-date')
    fireEvent.change(due, { target: { value: '2026-11-20' } })
    fireEvent.change(due, { target: { value: '' } })
    await act(async () => first.resolve({ ...initial, due_at: '2026-11-20', version: 2 }))
    expect(due).toHaveValue('')
    await waitFor(() => expect(updateLoopItem).toHaveBeenCalledTimes(2))
    await act(async () => latest.reject(new Error('Latest date save failed')))
    await screen.findByTestId('cloud-todo-field-retry')
    expect(due).toHaveValue('')
    fireEvent.click(screen.getByTestId('cloud-todo-field-retry'))
    await waitFor(() => expect(screen.getByTestId('issue-save-status')).toHaveTextContent('已保存'))
    expect(updateLoopItem.mock.lastCall?.[1]).toMatchObject({ version: 2, due_at: null })
    expect(due).toHaveValue('')
  })

  it('discards a failed title when the user restores the persisted title', async () => {
    const { updateLoopItem } = setup()
    updateLoopItem.mockRejectedValueOnce(new Error('Offline'))
    const title = screen.getByTestId('cloud-todo-detail-title')
    fireEvent.change(title, { target: { value: 'Abandoned' } })
    fireEvent.blur(title)
    await screen.findByTestId('cloud-todo-field-retry')
    fireEvent.change(title, { target: { value: initial.title } })
    fireEvent.blur(title)
    expect(screen.queryByTestId('cloud-todo-field-retry')).toBeNull()
    expect(title).toHaveValue(initial.title)
    expect(updateLoopItem).toHaveBeenCalledOnce()
  })

  it.each([
    { value: '', workspacePanel: true, enter: true },
    { value: '   ', workspacePanel: false, enter: false },
  ])(
    'explains an empty title without submitting it: %j',
    async ({ value, workspacePanel, enter }) => {
      const { updateLoopItem } = setup(undefined, workspacePanel)
      const title = screen.getByTestId('cloud-todo-detail-title')
      fireEvent.change(title, { target: { value } })
      if (enter) fireEvent.keyDown(title, { key: 'Enter' })
      else fireEvent.blur(title)
      expect(await screen.findByTestId('issue-title-error')).toHaveTextContent('请输入事项标题')
      expect(title).toHaveAttribute('aria-invalid', 'true')
      expect(title).toHaveAccessibleDescription('请输入事项标题')
      expect(title).toHaveValue(value)
      expect(updateLoopItem).not.toHaveBeenCalled()
      fireEvent.blur(title)
      expect(updateLoopItem).not.toHaveBeenCalled()
      fireEvent.change(title, { target: { value: 'Corrected title' } })
      expect(screen.queryByTestId('issue-title-error')).not.toBeInTheDocument()
      fireEvent.blur(title)
      await waitFor(() => expect(updateLoopItem).toHaveBeenCalledOnce())
      expect(updateLoopItem.mock.lastCall?.[1]).toMatchObject({ title: 'Corrected title' })
    }
  )

  it('discards a superseded title retry when a newer title fails local validation', async () => {
    const { updateLoopItem } = setup()
    updateLoopItem.mockRejectedValueOnce(new Error('Offline'))
    const title = screen.getByTestId('cloud-todo-detail-title')
    fireEvent.change(title, { target: { value: 'Abandoned' } })
    fireEvent.blur(title)
    await screen.findByTestId('cloud-todo-field-retry')
    fireEvent.change(title, { target: { value: '' } })
    fireEvent.blur(title)
    expect(await screen.findByTestId('issue-title-error')).toBeVisible()
    expect(screen.queryByTestId('cloud-todo-field-retry')).not.toBeInTheDocument()
    expect(updateLoopItem).toHaveBeenCalledOnce()
  })

  it('keeps a restored title visible while older writes finish and persists the latest intent', async () => {
    const { updateLoopItem } = setup()
    const first = Promise.withResolvers<CloudLoopItem>()
    const latest = Promise.withResolvers<CloudLoopItem>()
    updateLoopItem
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => latest.promise)
    const title = screen.getByTestId('cloud-todo-detail-title')
    fireEvent.change(title, { target: { value: 'Abandoned' } })
    fireEvent.blur(title)
    fireEvent.change(title, { target: { value: initial.title } })
    fireEvent.blur(title)
    await act(async () => first.resolve({ ...initial, title: 'Abandoned', version: 2 }))
    expect(title).toHaveValue(initial.title)
    await waitFor(() => expect(updateLoopItem).toHaveBeenCalledTimes(2))
    expect(updateLoopItem).toHaveBeenLastCalledWith(initial.id, {
      version: 2,
      title: initial.title,
    })
    await act(async () => latest.resolve({ ...initial, version: 3 }))
    expect(title).toHaveValue(initial.title)
    expect(screen.getByTestId('issue-save-status')).toHaveTextContent('已保存')
  })

  it('keeps description save and cancel disabled while its write is pending', async () => {
    const { updateLoopItem } = setup(undefined, true)
    fireEvent.click(screen.getByTestId('issue-description-edit'))
    fireEvent.change(screen.getByTestId('test-description'), { target: { value: 'Edited' } })
    const pending = Promise.withResolvers<CloudLoopItem>()
    updateLoopItem.mockImplementationOnce(() => pending.promise)
    fireEvent.click(screen.getByTestId('cloud-todo-save'))
    expect(screen.getByTestId('cloud-todo-save')).toBeDisabled()
    expect(screen.getByTestId('cloud-todo-cancel-content-edit')).toBeDisabled()
    expect(screen.getByTestId('issue-save-status')).toHaveTextContent('保存中')
    await act(async () => pending.resolve({ ...initial, description: 'Edited', version: 2 }))
    expect(screen.getByTestId('issue-save-status')).toHaveTextContent('已保存')
    expect(screen.queryByTestId('cloud-todo-cancel-content-edit')).toBeNull()
  })

  it('discards a failed description save when the edit is cancelled', async () => {
    const { updateLoopItem } = setup(undefined, true)
    fireEvent.click(screen.getByTestId('issue-description-edit'))
    fireEvent.change(screen.getByTestId('test-description'), { target: { value: 'Abandoned' } })
    updateLoopItem.mockRejectedValueOnce(new Error('Offline'))
    fireEvent.click(screen.getByTestId('cloud-todo-save'))
    await screen.findByTestId('cloud-todo-field-retry')
    fireEvent.click(screen.getByTestId('cloud-todo-cancel-content-edit'))
    expect(screen.queryByTestId('cloud-todo-field-retry')).toBeNull()
    expect(screen.getByTestId('test-description')).toHaveValue('Saved description')
    const title = screen.getByTestId('cloud-todo-detail-title')
    fireEvent.change(title, { target: { value: 'Kept title' } })
    fireEvent.blur(title)
    await waitFor(() => expect(screen.getByTestId('issue-save-status')).toHaveTextContent('已保存'))
    expect(updateLoopItem).toHaveBeenCalledTimes(2)
    expect(updateLoopItem).toHaveBeenLastCalledWith(initial.id, { version: 1, title: 'Kept title' })
  })

  it('marks a retained invalid date range as unsaved after a successful save', async () => {
    const { updateLoopItem } = setup()
    const title = screen.getByTestId('cloud-todo-detail-title')
    fireEvent.change(title, { target: { value: 'Saved title' } })
    fireEvent.blur(title)
    await waitFor(() => expect(screen.getByTestId('issue-save-status')).toHaveTextContent('已保存'))
    fireEvent.click(screen.getByRole('button', { name: '时间范围' }))
    fireEvent.change(await screen.findByTestId('cloud-todo-detail-due-date'), {
      target: { value: '2026-11-20' },
    })
    await waitFor(() => expect(screen.getByTestId('issue-save-status')).toHaveTextContent('已保存'))
    const savedCalls = updateLoopItem.mock.calls.length
    fireEvent.change(screen.getByTestId('cloud-todo-detail-start-date'), {
      target: { value: '2026-11-21' },
    })
    expect(screen.getByTestId('issue-save-status')).toHaveTextContent('有未保存的修改')
    expect(updateLoopItem).toHaveBeenCalledTimes(savedCalls)
  })

  it('announces unsaved, pending, failed and retried title saves without losing the draft', async () => {
    const { updateLoopItem } = setup()
    expect(screen.queryByTestId('issue-save-status')).toBeNull()
    const pending = Promise.withResolvers<CloudLoopItem>()
    updateLoopItem.mockImplementationOnce(() => pending.promise)
    const title = screen.getByTestId('cloud-todo-detail-title')
    fireEvent.change(title, { target: { value: 'Edited title' } })
    expect(screen.getByTestId('issue-save-status')).toHaveTextContent('有未保存的修改')
    fireEvent.blur(title)
    expect(screen.getByTestId('issue-save-status')).toHaveTextContent('保存中')
    await act(async () => pending.reject(new Error('Offline')))
    expect(await screen.findByTestId('cloud-todo-save-error')).toHaveTextContent('Offline')
    expect(screen.getByTestId('issue-save-status')).toHaveTextContent('保存失败')
    expect(title).toHaveValue('Edited title')
    await userEvent.click(screen.getByTestId('cloud-todo-field-retry'))
    await waitFor(() => expect(screen.getByTestId('issue-save-status')).toHaveTextContent('已保存'))
    expect(title).toHaveValue('Edited title')
  })

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
