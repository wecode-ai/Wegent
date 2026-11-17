import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { IndependentIssue, PersonalIssuesApi } from '@/api/personalIssues'
import { IndependentIssueTaskButton } from './IndependentIssueTaskButton'
const { launch } = vi.hoisted(() => ({ launch: vi.fn().mockResolvedValue({ taskId: 1 }) }))
vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbench: () => ({
    createProjectRuntimeTask: launch,
    state: { currentProject: null, selectedDeviceWorkspaceId: 42 },
  }),
}))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})
const issue = {
  id: 'i1',
  title: 'Independent work',
  description: 'Review the plan',
  metadata: {
    resource_participants: [{ kind: 'agent', id: 12, name: 'Reviewer', team_id: 12 }],
    assignee_resource: { kind: 'agent', id: 12 },
  },
} as IndependentIssue
it('only launches the invited Agent after an explicit action and rereads current access', async () => {
  const get = vi.fn().mockResolvedValue(issue),
    error = vi.fn()
  render(
    <IndependentIssueTaskButton
      api={
        {
          get,
          processingResource: vi
            .fn()
            .mockResolvedValue({ name: 'Reviewer', team_id: 12, instructions: '' }),
        } as unknown as PersonalIssuesApi
      }
      issue={issue}
      onError={error}
    />
  )
  expect(launch).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('independent-issue-create-task'))
  await waitFor(() =>
    expect(launch).toHaveBeenCalledWith(
      expect.stringContaining('Independent work'),
      expect.objectContaining({ wegentTeamId: 12 })
    )
  )
  expect(get).toHaveBeenCalledWith('i1')
  expect(error).not.toHaveBeenCalled()
})
it('does not launch a resource removed since the dialog opened', async () => {
  const get = vi.fn().mockResolvedValue({ ...issue, metadata: { resource_participants: [] } }),
    error = vi.fn()
  render(
    <IndependentIssueTaskButton
      api={{ get } as unknown as PersonalIssuesApi}
      issue={issue}
      onError={error}
    />
  )
  fireEvent.click(screen.getByTestId('independent-issue-create-task'))
  await waitFor(() => expect(error).toHaveBeenCalled())
  expect(launch).not.toHaveBeenCalled()
})

it.each(['added', 'replaced'])(
  'selects the current invited resource when it is %s',
  async transition => {
    const initial =
      transition === 'added' ? { ...issue, metadata: { resource_participants: [] } } : issue
    const next = {
      ...issue,
      metadata: {
        resource_participants: [{ kind: 'agent', id: 22, name: 'New reviewer', team_id: 22 }],
      },
    } as IndependentIssue
    const processingResource = vi.fn().mockResolvedValue({ name: 'New reviewer', team_id: 22 })
    const api = {
      get: vi.fn().mockResolvedValue(next),
      processingResource,
    } as unknown as PersonalIssuesApi
    const { rerender } = render(
      <IndependentIssueTaskButton api={api} issue={initial as IndependentIssue} onError={vi.fn()} />
    )
    rerender(<IndependentIssueTaskButton api={api} issue={next} onError={vi.fn()} />)
    expect(screen.getByTestId('independent-issue-processing-agent')).toHaveValue('agent:22')
    fireEvent.click(screen.getByTestId('independent-issue-create-task'))
    await waitFor(() => expect(processingResource).toHaveBeenCalledWith('i1', 'agent', 22))
    await waitFor(() =>
      expect(launch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ wegentTeamId: 22 })
      )
    )
  }
)

it('uses currently authorized content and never attaches files from another task draft', async () => {
  const issue = { id: 'independent', title: 'Old content', metadata: {} } as IndependentIssue
  const current = {
    ...issue,
    title: 'Current title',
    description: 'Latest authorized requirements',
  }
  const get = vi.fn().mockResolvedValue(current)
  launch.mockResolvedValue({ deviceId: 'mine', taskId: 'new-task' })
  render(
    <IndependentIssueTaskButton
      issue={issue}
      api={{ get } as unknown as PersonalIssuesApi}
      onError={vi.fn()}
    />
  )
  fireEvent.click(screen.getByTestId('independent-issue-create-task'))
  await waitFor(() => expect(launch).toHaveBeenCalledOnce())
  expect(get).toHaveBeenCalledWith(issue.id)
  expect(launch.mock.calls[0][0]).toContain(current.description)
  expect(launch.mock.calls[0][1]).toMatchObject({
    attachments: [],
    project: null,
    deviceWorkspaceId: 42,
  })
})

it('does not start an AI task after the invitation was revoked', async () => {
  const onError = vi.fn()
  render(
    <IndependentIssueTaskButton
      issue={{ id: 'revoked', metadata: {} } as IndependentIssue}
      api={
        {
          get: vi.fn().mockRejectedValue(new Error('Issue not found')),
        } as unknown as PersonalIssuesApi
      }
      onError={onError}
    />
  )
  fireEvent.click(screen.getByTestId('independent-issue-create-task'))
  await waitFor(() => expect(onError).toHaveBeenCalledWith('Issue not found'))
  expect(launch).not.toHaveBeenCalled()
})
