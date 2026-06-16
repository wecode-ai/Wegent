import { describe, expect, test, vi } from 'vitest'
import { createDeviceApi } from './devices'
import type { HttpClient } from './http'

describe('createDeviceApi', () => {
  test('uses cloud device endpoints for restart and delete actions', async () => {
    const client = {
      delete: vi.fn().mockResolvedValue({ message: 'deleted' }),
      post: vi.fn().mockResolvedValue({ message: 'restart sent' }),
    } as unknown as HttpClient

    const api = createDeviceApi(client)

    await api.restartCloudDevice('device/1')
    await api.deleteCloudDevice('device/1')
    await api.deleteDevice('device/1')
    await api.upgradeDevice('device/1', { auto_confirm: true })

    expect(client.post).toHaveBeenCalledWith('/cloud-devices/device%2F1/restart')
    expect(client.delete).toHaveBeenCalledWith('/cloud-devices/device%2F1')
    expect(client.delete).toHaveBeenCalledWith('/devices/device%2F1')
    expect(client.post).toHaveBeenCalledWith('/devices/device%2F1/upgrade', { auto_confirm: true })
  })

  test('opens a local terminal through the configured device command', async () => {
    const client = {
      post: vi.fn().mockResolvedValue({ success: true }),
    } as unknown as HttpClient

    const api = createDeviceApi(client)

    await api.openLocalTerminal('device/1', ' /workspace/project ')

    expect(client.post).toHaveBeenCalledWith('/devices/device%2F1/commands', {
      command_key: 'open_terminal',
      args: ['/workspace/project'],
      timeout_seconds: 10,
      max_output_bytes: 4096,
    })
  })
})
