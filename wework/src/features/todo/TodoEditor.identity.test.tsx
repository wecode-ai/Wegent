import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import { TodoEditor } from './TodoEditor'

const issue = {
  id: 'IDENTITY-1',
  cloud_project_id: '11',
  title: 'Identity',
  description: '',
  status: 'pending',
  priority: 'none',
  parent_id: null,
  due_at: null,
  tags: [],
  created_by_user_id: 1,
  created_by_user_name: 'Creator',
  reporter_user_id: 1,
  reporter_user_name: 'Creator',
  assignee_user_id: null,
  assignee_agent_id: null,
  version: 1,
  can_edit: true,
  is_following: false,
  created_at: '2026-10-30T00:00:00Z',
  updated_at: '2026-10-30T00:00:00Z',
} as CloudLoopItem

function identityApi() {
  return {
    getIssueAssignmentReceipts: vi.fn(async () => []),
    listDeliveries: vi.fn(async () => ({ items: [] })),
    listTaskBindings: vi.fn(async () => []),
    listLoopItemAttachments: vi.fn(async () => []),
    listLoopItemCollaborators: vi.fn(async () => []),
    listCloudProjectMembers: vi.fn(async () => [
      { id: 1, user_id: 1, user_name: 'Creator', email: null, role: 'Developer' },
      { id: 7, user_id: 7, user_name: 'Reporter', email: null, role: 'Developer' },
    ]),
    setLoopItemFollowing: vi.fn(async (_id: string, following: boolean) => ({ following })),
    updateLoopItem: vi.fn(async (_id: string, values: Record<string, unknown>) => ({
      ...issue,
      ...values,
      reporter_user_name: 'Reporter',
      version: 2,
    })),
    assignLoopItem: vi.fn(async () => ({ ...issue, assignee_user_id: 1, version: 2 })),
  }
}

function Editor({
  api,
  initial = issue,
  presentation = 'modal',
}: {
  api: ReturnType<typeof identityApi>
  initial?: CloudLoopItem
  presentation?: 'modal' | 'workspace-panel'
}) {
  const [item, setItem] = useState(initial)
  return (
    <TodoEditor
      mode="edit"
      presentation={presentation}
      item={item}
      project={
        {
          id: '11',
          name: 'Project',
          access_role: initial.can_edit ? 'Developer' : 'Viewer',
        } as CloudProject
      }
      allItems={[item]}
      api={api as never}
      currentUserId={1}
      onUpdated={setItem}
      onAddChild={vi.fn()}
      onClose={vi.fn()}
    />
  )
}

async function openMoreProperties(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId('cloud-todo-more-properties'))
  return screen.findByTestId('cloud-todo-more-properties-popover')
}

describe('Issue identity controls', () => {
  it('lets a viewer follow and unfollow without editing or assigning the Issue', async () => {
    const api = identityApi()
    render(
      <Editor
        api={api}
        presentation="workspace-panel"
        initial={{
          ...issue,
          can_edit: false,
          permissions: { edit_content: false, comment: false, assign: false, execute: false },
        }}
      />
    )
    const user = userEvent.setup()
    expect(screen.getByTestId('cloud-todo-detail-status')).toBeDisabled()
    expect(screen.getByRole('button', { name: '时间范围' })).toBeDisabled()
    expect(screen.queryByTestId('cloud-todo-reporter')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-assign-to-me')).not.toBeInTheDocument()
    const properties = await openMoreProperties(user)
    expect(within(properties).getByTestId('cloud-todo-identity-creator')).toHaveTextContent(
      'Creator'
    )
    expect(within(properties).queryByRole('button', { name: '报告人' })).not.toBeInTheDocument()
    await user.keyboard('{Escape}')
    await user.click(screen.getByTestId('cloud-todo-follow'))
    await waitFor(() =>
      expect(screen.getByTestId('cloud-todo-follow')).toHaveAttribute('aria-pressed', 'true')
    )
    await user.click(screen.getByTestId('cloud-todo-follow'))
    await waitFor(() =>
      expect(screen.getByTestId('cloud-todo-follow')).toHaveAttribute('aria-pressed', 'false')
    )
    expect(api.setLoopItemFollowing.mock.calls).toEqual([
      ['IDENTITY-1', true],
      ['IDENTITY-1', false],
    ])
    expect(api.updateLoopItem).not.toHaveBeenCalled()
    expect(api.assignLoopItem).not.toHaveBeenCalled()
  })

  it('changes the reporter while retaining the recorded creator', async () => {
    const api = identityApi()
    render(<Editor api={api} />)
    const user = userEvent.setup()
    await openMoreProperties(user)
    await user.click(screen.getByRole('button', { name: '报告人' }))
    const search = screen.getByTestId('cloud-todo-reporter-search')
    expect(search).toHaveFocus()
    await user.type(search, 'Reporter')
    await user.click(await screen.findByRole('option', { name: 'Reporter' }))
    await waitFor(() =>
      expect(api.updateLoopItem).toHaveBeenCalledWith('IDENTITY-1', {
        version: 1,
        reporter_user_id: 7,
      })
    )
    expect(screen.getByTestId('cloud-todo-identity-creator')).toHaveTextContent('Creator')
    expect(screen.getByTestId('cloud-todo-reporter')).toHaveAttribute('data-value', '7')
    expect(screen.queryByTestId('cloud-todo-reporter-menu')).not.toBeInTheDocument()
  })

  it.each(['modal', 'workspace-panel'] as const)(
    'discloses identity metadata in more properties and keeps following in the %s header',
    async presentation => {
      render(
        <TodoEditor
          mode="edit"
          presentation={presentation}
          item={issue}
          project={{ id: '11', name: 'Project', access_role: 'Developer' } as CloudProject}
          api={identityApi() as never}
          currentUserId={1}
          allItems={[issue]}
          onUpdated={vi.fn()}
          onClose={vi.fn()}
        />
      )
      const header = screen.getByTestId('cloud-todo-detail').querySelector('header')!
      const user = userEvent.setup()
      expect(header).toContainElement(screen.getByTestId('cloud-todo-follow'))
      expect(header).toContainElement(screen.getByTestId('cloud-todo-more-properties'))
      expect(screen.queryByTestId('cloud-todo-identity-creator')).not.toBeInTheDocument()
      expect(screen.queryByTestId('cloud-todo-reporter')).not.toBeInTheDocument()
      expect(screen.getAllByTestId('cloud-todo-detail-assignee')).toHaveLength(1)
      const properties = await openMoreProperties(user)
      const creator = within(properties).getByTestId('cloud-todo-identity-creator')
      expect(creator).toHaveTextContent('Creator')
      expect(creator.closest('button, input, select')).toBeNull()
      expect(within(properties).getByTestId('cloud-todo-detail-creator')).toContainElement(creator)
      expect(within(properties).getByTestId('cloud-todo-reporter')).toHaveAttribute(
        'data-value',
        '1'
      )
      expect(within(properties).queryByTestId('cloud-todo-detail-assignee')).not.toBeInTheDocument()
      expect(within(properties).queryByRole('button', { name: '时间范围' })).not.toBeInTheDocument()
    }
  )

  it('keeps status in the header and assignment with schedule available without opening more', () => {
    render(<Editor api={identityApi()} presentation="workspace-panel" />)
    const header = screen.getByTestId('cloud-todo-detail').querySelector('header')!
    const summary = screen.getByTestId('cloud-todo-state-summary')
    expect(header).toContainElement(screen.getByTestId('cloud-todo-detail-status'))
    expect(header).toContainElement(screen.getByTestId('cloud-todo-follow'))
    expect(summary).toContainElement(screen.getByTestId('cloud-todo-detail-assignee'))
    expect(summary).toContainElement(screen.getByTestId('cloud-todo-assign-to-me'))
    expect(summary).toContainElement(screen.getByRole('button', { name: '时间范围' }))
    expect(summary).not.toContainElement(screen.getByTestId('cloud-todo-detail-status'))
    expect(screen.queryByTestId('cloud-todo-more-properties-popover')).not.toBeInTheDocument()
  })

  it('focuses the first menu control when opened with the keyboard and restores focus on Escape', async () => {
    const user = userEvent.setup()
    render(<Editor api={identityApi()} presentation="workspace-panel" />)
    const more = screen.getByTestId('cloud-todo-more-properties')
    more.focus()

    await user.keyboard('{Enter}')

    const properties = await screen.findByTestId('cloud-todo-more-properties-popover')
    expect(within(properties).getByTestId('cloud-todo-reporter')).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(screen.queryByTestId('cloud-todo-more-properties-popover')).not.toBeInTheDocument()
    expect(more).toHaveFocus()
    expect(screen.getByTestId('cloud-todo-detail')).toBeVisible()
  })

  it('copies the Issue identifier and expands from more while retaining the saved status and schedule', async () => {
    const api = identityApi()
    const initial = {
      ...issue,
      start_at: '2026-11-02T00:00:00Z',
      due_at: '2026-11-04T00:00:00Z',
    }
    api.updateLoopItem.mockImplementation(async (_id, values) => ({
      ...initial,
      ...values,
      version: 2,
    }))
    const user = userEvent.setup()
    render(<Editor api={api} presentation="workspace-panel" initial={initial} />)
    const status = screen.getByTestId('cloud-todo-detail-status')
    const schedule = screen.getByRole('button', { name: '时间范围' }).textContent
    await user.selectOptions(status, 'completed')
    await waitFor(() =>
      expect(api.updateLoopItem).toHaveBeenCalledExactlyOnceWith(issue.id, {
        version: 1,
        status: 'completed',
      })
    )
    expect(screen.queryByRole('button', { name: '复制任务编号' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('cloud-todo-detail-fullscreen')).not.toBeInTheDocument()

    const properties = await openMoreProperties(user)
    await user.click(within(properties).getByRole('button', { name: '复制任务编号' }))
    expect(await navigator.clipboard.readText()).toBe(issue.id)
    await user.click(document.body)
    const nextProperties = await openMoreProperties(user)
    await user.click(within(nextProperties).getByRole('button', { name: '展开详情' }))
    await user.click(document.body)
    const expandedProperties = await openMoreProperties(user)
    await user.click(within(expandedProperties).getByRole('button', { name: '还原侧边栏' }))
    await user.click(document.body)

    expect(status).toHaveValue('completed')
    expect(screen.getByRole('button', { name: '时间范围' })).toHaveTextContent(schedule!)
    expect(api.updateLoopItem).toHaveBeenCalledOnce()
    expect(api.assignLoopItem).not.toHaveBeenCalled()
  })

  it('shows a followed state and exposes the unfollow action by its accessible name', async () => {
    const api = identityApi()
    render(<Editor api={api} initial={{ ...issue, is_following: true }} />)
    expect(screen.getByRole('button', { name: '取消关注' })).toHaveTextContent(/^$/)
    expect(screen.getByRole('button', { name: '取消关注' })).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(screen.getByRole('button', { name: '取消关注' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '关注' })).toHaveAttribute('aria-pressed', 'false')
    )
    expect(screen.getByRole('button', { name: '关注' })).toHaveTextContent(/^$/)
  })

  it('keeps the reporter and creator after a failed change and permits retry', async () => {
    const api = identityApi()
    api.updateLoopItem.mockRejectedValueOnce(new Error('Reporter update rejected'))
    render(<Editor api={api} />)
    const user = userEvent.setup()
    await openMoreProperties(user)
    await user.click(screen.getByTestId('cloud-todo-reporter'))
    await user.click(await screen.findByRole('option', { name: 'Reporter' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Reporter update rejected')
    expect(screen.getByTestId('cloud-todo-reporter')).toHaveAttribute('data-value', '1')
    expect(screen.getByTestId('cloud-todo-identity-creator')).toHaveTextContent('Creator')
    await user.click(screen.getByTestId('cloud-todo-reporter'))
    await user.click(await screen.findByRole('option', { name: 'Reporter' }))
    await waitFor(() =>
      expect(screen.getByTestId('cloud-todo-reporter')).toHaveAttribute('data-value', '7')
    )
  })

  it('omits assign to me when the current member already owns the Issue', () => {
    render(<Editor api={identityApi()} initial={{ ...issue, assignee_user_id: 1 }} />)
    expect(screen.queryByTestId('cloud-todo-assign-to-me')).not.toBeInTheDocument()
  })

  it('retains a reporter outside the member list and restores focus after an empty search', async () => {
    render(
      <Editor
        api={identityApi()}
        initial={{ ...issue, reporter_user_id: 99, reporter_user_name: 'Former member' }}
      />
    )
    const user = userEvent.setup()
    await openMoreProperties(user)
    const trigger = screen.getByRole('button', { name: '报告人' })
    expect(trigger).toHaveTextContent('Former member')
    await user.click(trigger)
    expect(screen.getByRole('option', { name: 'Former member' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    await user.type(screen.getByTestId('cloud-todo-reporter-search'), 'No matching person')
    expect(screen.getByText('没有匹配的成员')).toBeVisible()
    await user.keyboard('{Escape}')
    expect(screen.queryByTestId('cloud-todo-reporter-menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    expect(trigger).toHaveAttribute('data-value', '99')
  })

  it('assigns an unassigned Issue to the current member through the assignment API', async () => {
    const api = identityApi()
    render(<Editor api={api} />)
    await userEvent.click(screen.getByTestId('cloud-todo-assign-to-me'))
    await waitFor(() =>
      expect(api.assignLoopItem).toHaveBeenCalledWith('11', 'IDENTITY-1', {
        version: 1,
        assigneeType: 'user',
        assigneeId: '1',
        notifyAssignee: false,
      })
    )
    expect(api.setLoopItemFollowing).not.toHaveBeenCalled()
  })

  it.each(['follow', 'reporter', 'assign'] as const)(
    'ignores a late %s response after the detail switches to another Issue',
    async operation => {
      const api = identityApi()
      let complete!: () => void
      const pending = new Promise<void>(resolve => {
        complete = resolve
      })
      if (operation === 'follow') {
        api.setLoopItemFollowing.mockImplementation(async () => {
          await pending
          return { following: true }
        })
      } else if (operation === 'reporter') {
        api.updateLoopItem.mockImplementation(async () => {
          await pending
          return { ...issue, reporter_user_id: 7, reporter_user_name: 'Reporter', version: 2 }
        })
      } else {
        api.assignLoopItem.mockImplementation(async () => {
          await pending
          return { ...issue, assignee_user_id: 1, version: 2 }
        })
      }
      const onUpdated = vi.fn()
      const detail = (item: CloudLoopItem) => (
        <TodoEditor
          mode="edit"
          item={item}
          project={{ id: '11', access_role: 'Developer' } as CloudProject}
          api={api as never}
          currentUserId={1}
          allItems={[item]}
          onUpdated={onUpdated}
          onClose={vi.fn()}
        />
      )
      const view = render(detail(issue))
      const user = userEvent.setup()
      if (operation === 'reporter') {
        await openMoreProperties(user)
        await user.click(screen.getByTestId('cloud-todo-reporter'))
        await user.click(await screen.findByRole('option', { name: 'Reporter' }))
      } else {
        await user.click(
          screen.getByTestId(`cloud-todo-${operation === 'follow' ? 'follow' : 'assign-to-me'}`)
        )
      }
      view.rerender(detail({ ...issue, id: 'IDENTITY-2', title: 'Other Issue' }))
      await act(async () => {
        complete()
        await pending
      })
      expect(onUpdated).not.toHaveBeenCalled()
    }
  )
})
