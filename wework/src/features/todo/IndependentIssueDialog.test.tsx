import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import type { PersonalIssuesApi } from '@/api/personalIssues'
import { IndependentIssueDialog } from './IndependentIssueDialog'
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('./IndependentIssueTaskButton', () => ({ IndependentIssueTaskButton: () => null }))
afterEach(cleanup)

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
  expect(screen.getByTestId('independent-issue-project')).toHaveValue('p1')
  expect(close).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('independent-issue-save'))
  await waitFor(() => expect(open).toHaveBeenCalledWith('p1', 'i1'))
  expect(create).toHaveBeenCalledOnce()
  expect(update).toHaveBeenCalledOnce()
  expect(associate).toHaveBeenLastCalledWith('i1', 'p1', 2, '')
})
