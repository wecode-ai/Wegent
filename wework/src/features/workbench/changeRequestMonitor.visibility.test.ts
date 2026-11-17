// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { linkedChangeRequestTarget } from '@/api/changeRequests'
import type { DeviceCommandApi } from '@/api/environment'
import type { DeviceCommandResponse, DeviceInfo } from '@/types/api'
import { connectionObserverReply } from '@/test/connection-observer'
import { ChangeRequestMonitor } from './changeRequestMonitor'

const target = linkedChangeRequestTarget('device', 'https://github.com/org/repo/pull/1')!

describe('visible PR status lifecycle', () => {
  it('releases on hide and establishes a fresh activation on show without Git polling', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const executeCommand = vi
      .fn<DeviceCommandApi['executeCommand']>()
      .mockImplementation(async (_device, request) => connectionObserverReply(request))
    const monitor = new ChangeRequestMonitor({ executeCommand })
    monitor.syncConnectionObservations(null, [
      {
        device_id: 'device',
        runtime_features: { schemaVersion: 4, connectionEvents: { protocolVersion: 1 } },
      },
    ] as DeviceInfo[])
    const stop = monitor.register(target)
    try {
      await monitor.refresh()
      expect(monitor.getSnapshot(target)?.changeRequest?.number).toBe(1)
      const first = JSON.parse(executeCommand.mock.calls[0][1].args![0])
      visibility.mockReturnValue('hidden')
      document.dispatchEvent(new Event('visibilitychange'))
      await monitor.refresh()
      expect(executeCommand.mock.calls.map(([, request]) => request.command_key)).toEqual([
        'connection_observer_start',
        'connection_observer_stop',
      ])
      visibility.mockReturnValue('visible')
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.waitFor(() => expect(executeCommand).toHaveBeenCalledTimes(3))
      const next = JSON.parse(executeCommand.mock.calls[2][1].args![0])
      expect(next.generation).not.toBe(first.generation)
      expect(executeCommand.mock.calls[2][1].command_key).toBe('connection_observer_start')
    } finally {
      stop()
      visibility.mockRestore()
    }
  })

  it('retains the last PR while an explicit refresh is pending or fails', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    let resolve!: (result: DeviceCommandResponse) => void
    const pending = new Promise<DeviceCommandResponse>(res => {
      resolve = res
    })
    const executeCommand = vi
      .fn<DeviceCommandApi['executeCommand']>()
      .mockImplementation(async (_device, request) =>
        request.command_key === 'connection_observer_refresh'
          ? pending
          : connectionObserverReply(request)
      )
    const monitor = new ChangeRequestMonitor({ executeCommand })
    monitor.syncConnectionObservations(null, [
      {
        device_id: 'device',
        runtime_features: { schemaVersion: 4, connectionEvents: { protocolVersion: 1 } },
      },
    ] as DeviceInfo[])
    const stop = monitor.register(target)
    try {
      await monitor.refresh()
      const timestamp = monitor.getSnapshot(target)?.fetchedAt
      const running = monitor.refresh({ shareInflight: false })
      expect(monitor.getSnapshot(target)).toMatchObject({
        changeRequest: { number: 1 },
        observation: { state: 'refreshing' },
      })
      resolve({ success: false, stdout: '', stderr: 'connector_auth_required' })
      await running
      expect(monitor.getSnapshot(target)).toMatchObject({
        changeRequest: { number: 1 },
        fetchedAt: timestamp,
        stale: true,
        observation: { state: 'auth_required', transport: 'connection' },
      })
    } finally {
      stop()
      visibility.mockRestore()
    }
  })

  it('does not republish a start reply after the final view closes', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    let resolve!: (result: DeviceCommandResponse) => void
    const pending = new Promise<DeviceCommandResponse>(res => {
      resolve = res
    })
    const executeCommand = vi
      .fn<DeviceCommandApi['executeCommand']>()
      .mockImplementation(async (_device, request) =>
        request.command_key === 'connection_observer_start'
          ? pending
          : connectionObserverReply(request)
      )
    const monitor = new ChangeRequestMonitor({ executeCommand })
    monitor.syncConnectionObservations(null, [
      {
        device_id: 'device',
        runtime_features: { schemaVersion: 4, connectionEvents: { protocolVersion: 1 } },
      },
    ] as DeviceInfo[])
    const stop = monitor.register(target)
    const running = monitor.refresh()
    try {
      const before = monitor.getSnapshot(target)
      stop()
      resolve(connectionObserverReply(executeCommand.mock.calls[0][1]))
      await running
      expect(monitor.getSnapshot(target)).toBe(before)
      expect(executeCommand.mock.calls.map(([, request]) => request.command_key)).toEqual([
        'connection_observer_start',
        'connection_observer_stop',
      ])
    } finally {
      stop()
      visibility.mockRestore()
    }
  })
})
