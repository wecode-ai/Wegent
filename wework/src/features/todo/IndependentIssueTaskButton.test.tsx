import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { IndependentIssue, PersonalIssuesApi } from '@/api/personalIssues'
import { IndependentIssueTaskButton } from './IndependentIssueTaskButton'
const { launch } = vi.hoisted(() => ({ launch: vi.fn().mockResolvedValue({ taskId: 1 }) }))
vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbench: () => ({
    createProjectRuntimeTask: launch,
    state: { currentProject: null, selectedDeviceWorkspaceId: null },
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
