import { describe, expect, it, vi } from 'vitest'
import { requireIssueTaskAvailable } from './issueTaskAvailability'

const binding = { taskUserId: 1, deviceId: 'device', taskId: 'task' }
const translate = (key: string) => key

describe('Issue task availability', () => {
  it.each([undefined, { ...binding, taskUserId: 2 }])(
    'rejects missing or foreign bindings before querying the executor',
    async candidate => {
      const reader = { readTask: vi.fn() }
      await expect(requireIssueTaskAvailable(candidate, 1, reader, translate)).rejects.toThrow(
        'todo.linked_task_unavailable'
      )
      expect(reader.readTask).not.toHaveBeenCalled()
    }
  )

  it('reports archived tasks and succeeds after restoration', async () => {
    const reader = {
      readTask: vi
        .fn()
        .mockResolvedValueOnce({ success: false, code: 'task_archived' })
        .mockResolvedValueOnce({ success: true }),
    }
    await expect(requireIssueTaskAvailable(binding, 1, reader, translate)).rejects.toThrow(
      'todo.linked_task_archived'
    )
    await expect(requireIssueTaskAvailable(binding, '1', reader, translate)).resolves.toBe(binding)
    expect(reader.readTask).toHaveBeenLastCalledWith('device', 'task')
  })

  it('preserves executor errors and rejects unavailable executors', async () => {
    const reader = { readTask: vi.fn().mockRejectedValue(new Error('Device is offline')) }
    await expect(requireIssueTaskAvailable(binding, 1, reader, translate)).rejects.toThrow(
      'Device is offline'
    )
    await expect(requireIssueTaskAvailable(binding, 1, undefined, translate)).rejects.toThrow(
      'todo.linked_task_unavailable'
    )
  })
})
