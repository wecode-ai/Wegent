import { describe, expect, test, vi } from 'vitest'
import { createRuntimeWorkApiFromIpc } from './localServices'

const address = { deviceId: 'owner', taskId: 'task-1', workspacePath: '/workspace' }

describe('runtime task point lookup', () => {
  test.each(['task_not_found', 'task_archived'])(
    'returns null for %s without a catalog read',
    async code => {
      const request = vi.fn().mockResolvedValue({ success: false, code, error: 'Unavailable task' })
      const api = createRuntimeWorkApiFromIpc(request, async () => address.deviceId)
      await expect(api.getRuntimeTask(address)).resolves.toBeNull()
      expect(request).toHaveBeenCalledExactlyOnceWith('runtime.tasks.get', address, 'owner')
    }
  )

  test('propagates authorization failures instead of treating them as missing tasks', async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ success: false, code: 'forbidden', error: 'Denied' })
    const api = createRuntimeWorkApiFromIpc(request, async () => address.deviceId)
    await expect(api.getRuntimeTask(address)).rejects.toThrow('Denied')
    expect(request).toHaveBeenCalledExactlyOnceWith('runtime.tasks.get', address, 'owner')
  })

  test('does not query a project-authorized session through the owner lookup', async () => {
    const request = vi.fn()
    const api = createRuntimeWorkApiFromIpc(request, async () => address.deviceId)
    await expect(
      api.getRuntimeTask({
        ...address,
        projectSession: { projectId: 'project-1', issueId: 'issue-1' },
      })
    ).resolves.toBeNull()
    expect(request).not.toHaveBeenCalled()
  })
})
