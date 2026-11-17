import { describe, expect, test, vi } from 'vitest'
import { cancelConnectionEventSubscription } from './connectionEventSubscriptions'

const supportedDevice = {
  runtime_features: { schemaVersion: 4, connectionEvents: { protocolVersion: 1 } },
}

const address = {
  deviceId: 'remote-device',
  taskId: 'task',
  workspacePath: '/work',
  runtime: 'codex' as const,
}
describe('cancelConnectionEventSubscription', () => {
  test.each([
    undefined,
    { runtime_features: { schemaVersion: 4 } },
    { runtime_features: { schemaVersion: 4, connectionEvents: { protocolVersion: 2 } } },
  ])('never sends new RPCs without the supported protocol: %j', async device => {
    const api = { executeCommand: vi.fn() }
    await expect(
      cancelConnectionEventSubscription(api, address, 'watch', device)
    ).rejects.toMatchObject({ code: 'connection_event_upgrade_required' })
    expect(api.executeCommand).not.toHaveBeenCalled()
  })
  test('uses the exact owner and accepts only confirmed cancellation', async () => {
    const api = {
      executeCommand: vi.fn().mockResolvedValue({
        success: true,
        stdout: { subscription: { subscription_key: 'watch', status: 'cancelled' } },
      }),
    }
    await cancelConnectionEventSubscription(api, address, 'watch', supportedDevice)
    expect(api.executeCommand).toHaveBeenCalledWith('remote-device', {
      command_key: 'connection_subscription_cancel',
      args: ['task', 'watch'],
    })
  })
  test.each([
    { success: false, stdout: {} },
    { success: true, stdout: { subscription: { subscription_key: 'other', status: 'cancelled' } } },
    { success: true, stdout: { subscription: { subscription_key: 'watch', status: 'armed' } } },
    { success: true, stdout: {} },
  ])('does not turn an unconfirmed or foreign receipt into success: %j', async response => {
    await expect(
      cancelConnectionEventSubscription(
        { executeCommand: vi.fn().mockResolvedValue(response) },
        address,
        'watch',
        supportedDevice
      )
    ).rejects.toThrow()
  })
})
