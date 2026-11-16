// @vitest-environment node

import { linkedChangeRequestTarget } from '@/api/changeRequests'
import type { DeviceCommandApi } from '@/api/environment'
import type { DeviceCommandResponse } from '@/types/api'
import { describe, expect, it, vi } from 'vitest'
import { ChangeRequestMonitor } from './changeRequestMonitor'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return { promise, resolve }
}

describe('ChangeRequestMonitor', () => {
  it('keeps distinct PR links in one repository separate and marks failed refreshes stale', async () => {
    const executeCommand = vi
      .fn<DeviceCommandApi['executeCommand']>()
      .mockImplementation(async (_deviceId, request) => {
        const url = request.args![0]
        return {
          success: true,
          stdout: { number: Number(url.split('/').at(-1)), url, state: 'OPEN' },
        }
      })
    const monitor = new ChangeRequestMonitor({ executeCommand })
    const targets = [1, 2].map(
      number =>
        linkedChangeRequestTarget('local-device', `https://github.com/org/repo/pull/${number}`)!
    )
    const unregister = targets.map(target => monitor.register(target))
    try {
      await monitor.refresh()
      expect(targets.map(target => monitor.getSnapshot(target)?.changeRequest?.number)).toEqual([
        1, 2,
      ])
      executeCommand.mockResolvedValue({ success: false, stderr: 'network unavailable' })
      await monitor.refresh()
      expect(targets.map(target => monitor.getSnapshot(target))).toEqual([
        expect.objectContaining({
          stale: true,
          changeRequest: expect.objectContaining({ number: 1 }),
        }),
        expect.objectContaining({
          stale: true,
          changeRequest: expect.objectContaining({ number: 2 }),
        }),
      ])
    } finally {
      unregister.forEach(stop => stop())
    }
  })

  it('queues a fresh request after an in-flight request for explicit refreshes', async () => {
    const firstResponse = deferred<DeviceCommandResponse>()
    const executeCommand = vi
      .fn<DeviceCommandApi['executeCommand']>()
      .mockReturnValueOnce(firstResponse.promise)
      .mockResolvedValue({ success: true, stdout: [] })
    const monitor = new ChangeRequestMonitor({ executeCommand })
    const unregister = monitor.register({
      deviceId: 'local-device',
      taskId: 'runtime-1',
      workspacePath: '/repo',
      remoteUrl: 'https://github.com/wecode-ai/Wegent.git',
      branch: 'fix/pr-status',
    })
    await vi.waitFor(() => expect(executeCommand).toHaveBeenCalledTimes(1))

    const refresh = monitor.refresh({ shareInflight: false })
    firstResponse.resolve({ success: true, stdout: [] })
    await refresh

    expect(executeCommand).toHaveBeenCalledTimes(2)
    unregister()
  })

  it('keeps structured lookup failures when preserving a previous snapshot', async () => {
    const executeCommand = vi
      .fn<DeviceCommandApi['executeCommand']>()
      .mockResolvedValueOnce({ success: true, stdout: [] })
      .mockResolvedValueOnce({
        success: false,
        stdout: '',
        stderr: 'gh: command not found',
      })
    const monitor = new ChangeRequestMonitor({ executeCommand })
    const target = {
      deviceId: 'local-device',
      taskId: 'runtime-1',
      workspacePath: '/repo',
      remoteUrl: 'https://github.com/wecode-ai/Wegent.git',
      branch: 'fix/pr-status',
    }
    const unregister = monitor.register(target)
    await vi.waitFor(() => expect(executeCommand).toHaveBeenCalledTimes(1))

    await monitor.refresh()

    expect(monitor.getSnapshot(target)).toMatchObject({
      provider: 'github',
      lookupState: 'unavailable',
      stale: true,
      error: 'gh: command not found',
    })
    unregister()
  })
})
