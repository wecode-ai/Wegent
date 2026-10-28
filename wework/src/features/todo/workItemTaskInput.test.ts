import { describe, expect, it, vi } from 'vitest'
import type { SharedWorkspaceApi } from '@wegent/collaboration'
import { updateIssueWhenPersonalTaskStarts } from './workItemTaskInput'

const source = { id: 'issue-1', status: 'pending', tags: [], version: 3 }
const conflict = { code: 'version_conflict' }

function issuesFor(latest: Partial<typeof source>, error: unknown = conflict) {
  const get = vi
    .fn()
    .mockResolvedValueOnce(source)
    .mockResolvedValue({ ...source, ...latest })
  const update = vi
    .fn()
    .mockRejectedValueOnce(error)
    .mockResolvedValue({ ...source, ...latest })
  return { get, update }
}

const start = (issues: ReturnType<typeof issuesFor>) =>
  updateIssueWhenPersonalTaskStarts(issues as unknown as SharedWorkspaceApi['issues'], source.id)

describe('personal task Issue start', () => {
  it('preserves a concurrent delivery when rebasing its start transition', async () => {
    const issues = issuesFor({ version: 4 })
    await expect(start(issues)).resolves.toBeNull()
    expect(issues.update.mock.calls).toEqual([
      [source.id, { version: 3, status: 'in_progress' }],
      [source.id, { version: 4, status: 'in_progress' }],
    ])
  })

  it('does not overwrite a concurrent status edit', async () => {
    const issues = issuesFor({ version: 4, status: 'completed' })
    await expect(start(issues)).resolves.not.toBeNull()
    expect(issues.update).toHaveBeenCalledTimes(1)
  })

  it('does not rebase permission denials', async () => {
    const issues = issuesFor({ version: 4 }, new Error('Forbidden'))
    await expect(start(issues)).resolves.toBe('Forbidden')
    expect(issues.get).toHaveBeenCalledTimes(1)
    expect(issues.update).toHaveBeenCalledTimes(1)
  })

  it('reports another conflict after rebasing instead of looping', async () => {
    const issues = issuesFor({ version: 4 })
    issues.update.mockRejectedValue(conflict)
    await expect(start(issues)).resolves.not.toBeNull()
    expect(issues.update).toHaveBeenCalledTimes(2)
  })
})
