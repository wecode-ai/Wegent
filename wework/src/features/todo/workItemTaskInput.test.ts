import { expect, test, vi } from 'vitest'
import { updateIssueWhenPersonalTaskStarts } from './workItemTaskInput'

test('rebases the start transition after a concurrent delivery changes the Issue version', async () => {
  const issues = {
    get: vi
      .fn()
      .mockResolvedValueOnce({ id: 'ISSUE-1', status: 'pending', tags: [], version: 3 })
      .mockResolvedValueOnce({ id: 'ISSUE-1', status: 'pending', tags: ['delivery'], version: 4 }),
    update: vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('Version conflict'), { status: 409 }))
      .mockResolvedValueOnce({}),
  }

  await expect(updateIssueWhenPersonalTaskStarts(issues, 'ISSUE-1')).resolves.toBeNull()
  expect(issues.update.mock.calls).toEqual([
    ['ISSUE-1', { version: 3, status: 'in_progress' }],
    ['ISSUE-1', { version: 4, status: 'in_progress' }],
  ])
})

test('does not reopen an Issue completed concurrently with task creation', async () => {
  const issues = {
    get: vi
      .fn()
      .mockResolvedValueOnce({ id: 'ISSUE-1', status: 'pending', tags: [], version: 3 })
      .mockResolvedValueOnce({ id: 'ISSUE-1', status: 'done', tags: [], version: 4 }),
    update: vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('Version conflict'), { status: 409 })),
  }

  await expect(updateIssueWhenPersonalTaskStarts(issues, 'ISSUE-1')).resolves.toBeNull()
  expect(issues.update).toHaveBeenCalledTimes(1)
})

test('reports a repeated conflict without unbounded mutation attempts', async () => {
  const issues = {
    get: vi.fn().mockResolvedValue({ id: 'ISSUE-1', status: 'pending', tags: [], version: 3 }),
    update: vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('Version conflict'), { status: 409 })),
  }

  await expect(updateIssueWhenPersonalTaskStarts(issues, 'ISSUE-1')).resolves.toBe(
    'Version conflict'
  )
  expect(issues.update).toHaveBeenCalledTimes(2)
})
