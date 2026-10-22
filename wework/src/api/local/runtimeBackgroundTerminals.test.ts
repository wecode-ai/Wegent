import { describe, expect, test, vi } from 'vitest'
import { createRuntimeWorkApiFromIpc } from './localServices'

describe('background terminal executor routing', () => {
  test('cleans the selected task on the local executor', async () => {
    const request = vi.fn().mockResolvedValue({ success: true })
    const api = createRuntimeWorkApiFromIpc(request, async () => 'local-device')
    const address = { deviceId: 'local-device', taskId: 'task-1' }

    await expect(api.cleanRuntimeBackgroundTerminals(address)).resolves.toEqual({ success: true })

    expect(request).toHaveBeenCalledWith(
      'runtime.tasks.background_terminals.clean',
      { taskId: 'task-1', address },
      'local-device'
    )
  })

  test('uses the addressed executor and preserves cleanup failures', async () => {
    const request = vi.fn().mockRejectedValue(new Error('Executor unavailable'))
    const api = createRuntimeWorkApiFromIpc(request, async () => 'default-device', {
      resolveDeviceId: async data => (data.address as { deviceId: string }).deviceId,
    })
    const address = { deviceId: 'other-device', taskId: 'task-2' }

    await expect(api.cleanRuntimeBackgroundTerminals(address)).rejects.toThrow(
      'Executor unavailable'
    )

    expect(request).toHaveBeenCalledWith(
      'runtime.tasks.background_terminals.clean',
      { taskId: 'task-2', address },
      'other-device'
    )
  })
})
