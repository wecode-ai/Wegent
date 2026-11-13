import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { PersonalIssuesApi } from '@/api/personalIssues'
import { IndependentIssueDialog } from './IndependentIssueDialog'
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('./IndependentIssueTaskButton', () => ({ IndependentIssueTaskButton: () => null }))
afterEach(cleanup)

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
