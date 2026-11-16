import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import type { PersonalIssuesApi } from '@/api/personalIssues'
import { ApiError } from '@/api/http'
import { IndependentIssueDialog } from './IndependentIssueDialog'
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('./IndependentIssueTaskButton', () => ({ IndependentIssueTaskButton: () => null }))
afterEach(cleanup)

it.each(['cancel', 'escape', 'discard'] as const)(
  'returns focus to the new-Issue opener after %s',
  async dismissal => {
    const api = {
      projects: vi.fn().mockResolvedValue({ items: [] }),
    } as unknown as PersonalIssuesApi
    function Harness() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button data-testid="new-issue-opener" onClick={() => setOpen(true)}>
            New Issue
          </button>
          {open && (
            <IndependentIssueDialog
              api={api}
              userId={7}
              issueId={null}
              onClose={() => setOpen(false)}
              onSaved={vi.fn()}
            />
          )}
        </>
      )
    }
    render(<Harness />)
    const opener = screen.getByTestId('new-issue-opener')
    await userEvent.click(opener)
    const title = screen.getByTestId('independent-issue-title')
    await waitFor(() => expect(title).toHaveFocus())
    if (dismissal === 'discard') {
      await userEvent.type(title, 'Protected draft')
      await userEvent.keyboard('{Escape}')
      await userEvent.click(screen.getByTestId('independent-issue-discard-confirm-cancel-button'))
      expect(title).toHaveValue('Protected draft')
      await userEvent.keyboard('{Escape}')
      await userEvent.click(screen.getByTestId('independent-issue-discard-confirm'))
    } else if (dismissal === 'cancel') {
      await userEvent.click(screen.getByTestId('independent-issue-editor-cancel'))
    } else await userEvent.keyboard('{Escape}')
    await waitFor(() =>
      expect(screen.queryByTestId('independent-issue-dialog')).not.toBeInTheDocument()
    )
    expect(opener).toHaveFocus()
  }
)

it('keeps a conflicted draft until confirmed reload and saves with the latest version afterward', async () => {
  const initial = {
    id: 'conflict',
    title: 'Original',
    description: 'Original description',
    status: 'pending',
    priority: 'medium',
    creator_id: 7,
    assignee_id: 7,
    version: 1,
    people: {},
    metadata: { standalone: true, participants: [], archived: false, due_at: null },
  }
  const latest = { ...initial, title: 'Server work', description: 'Server description', version: 2 }
  const update = vi
    .fn()
    .mockRejectedValueOnce(new ApiError('Changed', 409))
    .mockResolvedValue({ ...latest, title: 'Revised', version: 3 })
  const get = vi.fn().mockResolvedValueOnce(initial).mockResolvedValue(latest)
  const api = {
    get,
    update,
    comments: vi.fn().mockResolvedValue([]),
  } as unknown as PersonalIssuesApi
  render(
    <IndependentIssueDialog
      api={api}
      userId={7}
      issueId="conflict"
      onClose={vi.fn()}
      onSaved={vi.fn()}
    />
  )
  fireEvent.click(await screen.findByTestId('independent-issue-edit'))
  fireEvent.change(screen.getByTestId('independent-issue-title'), {
    target: { value: 'Local draft' },
  })
  fireEvent.click(screen.getByTestId('independent-issue-save'))
  fireEvent.click(await screen.findByTestId('independent-issue-reload'))
  expect(screen.getByText('issue_creation.reload_hint')).toBeVisible()
  fireEvent.click(screen.getByTestId('independent-issue-discard-confirm-cancel-button'))
  expect(screen.getByTestId('independent-issue-title')).toHaveValue('Local draft')
  expect(get).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByTestId('independent-issue-reload'))
  fireEvent.click(screen.getByTestId('independent-issue-discard-confirm'))
  fireEvent.click(await screen.findByTestId('independent-issue-edit'))
  expect(get).toHaveBeenCalledTimes(2)
  expect(update).toHaveBeenCalledOnce()
  expect(screen.getByTestId('independent-issue-title')).toHaveValue('Server work')
  expect(screen.getByTestId('independent-issue-description')).toHaveValue('Server description')
  fireEvent.change(screen.getByTestId('independent-issue-title'), { target: { value: 'Revised' } })
  fireEvent.click(screen.getByTestId('independent-issue-save'))
  await screen.findByTestId('independent-issue-edit')
  expect(update).toHaveBeenLastCalledWith(
    'conflict',
    expect.objectContaining({
      title: 'Revised',
      description: 'Server description',
      version: 2,
    })
  )
})

it.each(['dialog', 'drawer'] as const)(
  'keeps a %s draft when dismissing the participant picker and canceling discard',
  async presentation => {
    const close = vi.fn()
    const api = {
      projects: vi.fn().mockResolvedValue({ items: [] }),
      searchUsers: vi.fn().mockResolvedValue({ users: [] }),
      create: vi.fn(),
    } as unknown as PersonalIssuesApi
    render(
      <IndependentIssueDialog
        api={api}
        userId={7}
        issueId={null}
        presentation={presentation}
        onClose={close}
        onSaved={vi.fn()}
      />
    )
    const title = screen.getByTestId('independent-issue-title')
    await waitFor(() => expect(title).toHaveFocus())
    await userEvent.type(title, 'Keep this draft')
    fireEvent.change(screen.getByTestId('independent-issue-priority'), {
      target: { value: 'high' },
    })
    await userEvent.click(screen.getByTestId('issue-participant-add'))
    await waitFor(() => expect(screen.getByTestId('independent-issue-search-people')).toHaveFocus())
    await userEvent.keyboard('Nobody{Enter}')
    expect(api.create).not.toHaveBeenCalled()
    await userEvent.keyboard('{Escape}')
    await waitFor(() =>
      expect(screen.queryByTestId('issue-participant-picker')).not.toBeInTheDocument()
    )
    expect(close).not.toHaveBeenCalled()
    expect(title).toHaveValue('Keep this draft')
    expect(screen.queryByTestId('independent-issue-discard-dialog')).not.toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    expect(screen.getByTestId('independent-issue-discard-dialog')).toBeVisible()
    expect(screen.getByTestId('independent-issue-dialog')).not.toBeVisible()
    await userEvent.click(screen.getByTestId('independent-issue-discard-confirm-cancel-button'))
    expect(title).toHaveValue('Keep this draft')
    expect(screen.getByTestId('independent-issue-priority')).toHaveValue('high')
    await userEvent.click(screen.getByTestId('independent-issue-close'))
    await userEvent.click(screen.getByTestId('independent-issue-discard-confirm'))
    expect(close).toHaveBeenCalledOnce()
    expect(api.create).not.toHaveBeenCalled()
  }
)

it('closes an unchanged form without a discard decision', async () => {
  const close = vi.fn()
  const api = { projects: vi.fn().mockResolvedValue({ items: [] }) } as unknown as PersonalIssuesApi
  render(
    <IndependentIssueDialog api={api} userId={7} issueId={null} onClose={close} onSaved={vi.fn()} />
  )
  await userEvent.click(screen.getByTestId('independent-issue-editor-cancel'))
  expect(close).toHaveBeenCalledOnce()
  expect(screen.queryByTestId('independent-issue-discard-dialog')).not.toBeInTheDocument()
})

it('retains the saved Issue on association failure so retry cannot create a second Issue', async () => {
  const row = {
    id: 'i1',
    title: 'Work',
    description: '',
    status: 'pending',
    priority: 'medium',
    creator_id: 7,
    assignee_id: 7,
    version: 1,
    people: {},
    metadata: { standalone: true, participants: [], archived: false, due_at: null },
  }
  const create = vi.fn().mockResolvedValue(row)
  const update = vi.fn().mockResolvedValue({ ...row, version: 2 })
  const associate = vi
    .fn()
    .mockRejectedValueOnce(new Error('Project changed'))
    .mockResolvedValueOnce({ project_id: 'p1', issue_id: 'i1' })
  const api = {
    create,
    update,
    associate,
    projects: vi.fn().mockResolvedValue({
      items: [
        {
          id: 'p1',
          name: 'Project',
          task_provider: 'backend',
          access_role: 'Owner',
          board_config: { statuses: [] },
        },
      ],
    }),
  } as unknown as PersonalIssuesApi
  const close = vi.fn(),
    open = vi.fn()
  render(
    <IndependentIssueDialog
      api={api}
      userId={7}
      issueId={null}
      onClose={close}
      onSaved={vi.fn()}
      onOpenProjectIssue={open}
    />
  )
  fireEvent.change(screen.getByTestId('independent-issue-title'), { target: { value: 'Work' } })
  await screen.findByRole('option', { name: 'Project' })
  fireEvent.change(screen.getByTestId('independent-issue-project'), { target: { value: 'p1' } })
  fireEvent.click(screen.getByTestId('independent-issue-save'))
  await screen.findByText('Project changed')
  expect(screen.getByText('issue_creation.association_pending')).toBeVisible()
  expect(screen.getByTestId('independent-issue-project')).toHaveValue('p1')
  expect(close).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('independent-issue-save'))
  await waitFor(() => expect(open).toHaveBeenCalledWith('p1', 'i1'))
  expect(create).toHaveBeenCalledOnce()
  expect(update).toHaveBeenCalledOnce()
  expect(update).toHaveBeenCalledWith('i1', expect.objectContaining({ version: 1 }))
  expect(associate).toHaveBeenLastCalledWith('i1', 'p1', 2, '')
})

it.each(['independent-issue-close', 'independent-issue-editor-cancel'])(
  'explains that an Issue survives a failed project association and refreshes it via %s',
  async dismissal => {
    const row = {
      id: 'saved',
      title: 'Saved work',
      description: '',
      status: 'pending',
      priority: 'medium',
      creator_id: 7,
      assignee_id: 7,
      version: 1,
      people: {},
      metadata: { standalone: true, participants: [], archived: false, due_at: null },
    }
    const api = {
      create: vi.fn().mockResolvedValue(row),
      associate: vi.fn().mockRejectedValue(new Error('Project unavailable')),
      projects: vi.fn().mockResolvedValue({
        items: [
          {
            id: 'p',
            name: 'Project',
            task_provider: 'backend',
            access_role: 'Owner',
            board_config: { statuses: [] },
          },
        ],
      }),
    } as unknown as PersonalIssuesApi
    const close = vi.fn()
    const saved = vi.fn()
    render(
      <IndependentIssueDialog api={api} userId={7} issueId={null} onClose={close} onSaved={saved} />
    )
    fireEvent.change(screen.getByTestId('independent-issue-title'), {
      target: { value: row.title },
    })
    await screen.findByRole('option', { name: 'Project' })
    fireEvent.change(screen.getByTestId('independent-issue-project'), { target: { value: 'p' } })
    fireEvent.click(screen.getByTestId('independent-issue-save'))
    await screen.findByText('issue_creation.association_pending')
    fireEvent.click(screen.getByTestId(dismissal))
    expect(screen.getByText('issue_creation.saved_issue_discard_hint')).toBeVisible()
    fireEvent.click(screen.getByTestId('independent-issue-discard-confirm'))
    expect(saved).toHaveBeenCalledWith(row)
    expect(close).toHaveBeenCalledTimes(dismissal === 'independent-issue-close' ? 1 : 0)
    expect(api.create).toHaveBeenCalledOnce()
  }
)
