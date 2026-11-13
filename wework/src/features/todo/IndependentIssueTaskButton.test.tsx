import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { IndependentIssue, PersonalIssuesApi } from '@/api/personalIssues'
import { IndependentIssueTaskButton } from './IndependentIssueTaskButton'

const workbench = vi.hoisted(() => ({ state: { currentProject: null, selectedDeviceWorkspaceId: 42 }, createProjectRuntimeTask: vi.fn() }))
vi.mock('@/features/workbench/useWorkbench', () => ({ useWorkbench: () => workbench }))
afterEach(() => { cleanup(); vi.clearAllMocks() })

it('uses currently authorized content and never attaches files from another task draft', async () => {
  const issue = { id: 'independent', title: 'Old content' } as IndependentIssue
  const current = { ...issue, title: 'Current title', description: 'Latest authorized requirements' }
  const get = vi.fn().mockResolvedValue(current)
  workbench.createProjectRuntimeTask.mockResolvedValue({ deviceId: 'mine', taskId: 'new-task' })
  render(<IndependentIssueTaskButton issue={issue} api={{ get } as unknown as PersonalIssuesApi} onError={vi.fn()} />)
  fireEvent.click(screen.getByTestId('independent-issue-create-task'))
  await waitFor(() => expect(workbench.createProjectRuntimeTask).toHaveBeenCalledOnce())
  expect(get).toHaveBeenCalledWith(issue.id)
  expect(workbench.createProjectRuntimeTask.mock.calls[0][0]).toContain(current.description)
  expect(workbench.createProjectRuntimeTask.mock.calls[0][1]).toMatchObject({ attachments: [], project: null, deviceWorkspaceId: 42 })
})

it('does not start an AI task after the invitation was revoked', async () => {
  const onError = vi.fn()
  render(<IndependentIssueTaskButton issue={{ id: 'revoked' } as IndependentIssue} api={{ get: vi.fn().mockRejectedValue(new Error('Issue not found')) } as unknown as PersonalIssuesApi} onError={onError} />)
  fireEvent.click(screen.getByTestId('independent-issue-create-task'))
  await waitFor(() => expect(onError).toHaveBeenCalledWith('Issue not found'))
  expect(workbench.createProjectRuntimeTask).not.toHaveBeenCalled()
})
