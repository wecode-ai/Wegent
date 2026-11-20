// @vitest-environment node

import { linkedChangeRequestTarget } from '@/api/changeRequests'
import type { DeviceCommandApi } from '@/api/environment'
import type { DeviceCommandResponse, DeviceInfo, RuntimeWorkListResponse } from '@/types/api'
import { describe, expect, it, vi } from 'vitest'
import { ChangeRequestMonitor } from './changeRequestMonitor'
import { connectionEventSubscriptions } from '@/lib/runtime-connection-events'
import { connectionObserverReply } from '@/test/connection-observer'
import { qualifyLocalRuntimeSource } from '@/lib/local-runtime-sidebar-identity'

const devices = [
  {
    device_id: 'local-device',
    runtime_features: { schemaVersion: 4, connectionEvents: { protocolVersion: 1 } },
  },
] as DeviceInfo[]

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return { promise, resolve }
}

describe('ChangeRequestMonitor', () => {
  it('loads a task registered while another task is refreshing', async () => {
    const pending = deferred<DeviceCommandResponse>()
    let reply: DeviceCommandResponse | undefined
    const executeCommand = vi
      .fn<DeviceCommandApi['executeCommand']>()
      .mockImplementationOnce(async (_device, request) => {
        reply = connectionObserverReply(request)
        return pending.promise
      })
      .mockImplementation(async (_device, request) => connectionObserverReply(request))
    const monitor = new ChangeRequestMonitor({ executeCommand })
    monitor.syncConnectionObservations(null, devices)
    const first = {
      ...linkedChangeRequestTarget('local-device', 'https://github.com/org/repo/pull/1')!,
      taskId: 'first',
    }
    const second = { ...first, taskId: 'second' }
    const stopFirst = monitor.register(first)
    let stopSecond = () => {}
    try {
      const refresh = monitor.refresh()
      await vi.waitFor(() => expect(executeCommand).toHaveBeenCalledTimes(1))
      stopSecond = monitor.register(second)
      // Let the new target's scheduled refresh join the already running collection.
      await Promise.resolve()
      pending.resolve(reply!)
      await refresh
      await vi.waitFor(() => expect(monitor.getSnapshot(second)?.changeRequest?.number).toBe(1))
      expect(monitor.getSnapshot(first)?.changeRequest?.number).toBe(1)
    } finally {
      pending.resolve(reply!)
      stopFirst()
      stopSecond()
    }
  })

  it('starts only the upgraded route and never falls back to the old Git poll', async () => {
    const executeCommand = vi
      .fn<DeviceCommandApi['executeCommand']>()
      .mockImplementation(async (_device, request) => connectionObserverReply(request))
    const monitor = new ChangeRequestMonitor({ executeCommand })
    const target = linkedChangeRequestTarget('local-device', 'https://github.com/org/repo/pull/1')!
    monitor.syncConnectionObservations(null, [{ ...devices[0], device_id: 'other-device' }])
    const stop = monitor.register(target)
    try {
      await monitor.refresh()
      expect(executeCommand).not.toHaveBeenCalled()
      monitor.syncConnectionObservations(null, devices)
      await monitor.refresh()
      expect(executeCommand.mock.calls.map(([, request]) => request.command_key)).toEqual([
        'connection_observer_start',
      ])
      executeCommand.mockClear()
      monitor.syncConnectionObservations(null, [])
      await monitor.refresh({ shareInflight: false })
      expect(executeCommand).not.toHaveBeenCalled()
    } finally {
      stop()
    }
  })

  it.each([false, true])(
    'forces one shared UI collection for two tasks (native alias: %s)',
    async alias => {
      const executeCommand = vi
        .fn<DeviceCommandApi['executeCommand']>()
        .mockImplementation(async (_device, request) => connectionObserverReply(request))
      const monitor = new ChangeRequestMonitor({ executeCommand })
      monitor.syncConnectionObservations(null, devices)
      if (alias) {
        const identity = {
          deviceId: 'native-device',
          runtimeInstanceId: 'installation',
          provenance: 'local-ipc' as const,
        }
        monitor.syncConnectionObservations(null, [
          qualifyLocalRuntimeSource(
            {
              device_id: identity.deviceId,
              runtime_features: devices[0].runtime_features,
              device_type: 'local',
              runtime_instance_id: identity.runtimeInstanceId,
            } as DeviceInfo,
            identity
          ),
        ])
      }
      const target = linkedChangeRequestTarget(
        'local-device',
        'https://github.com/org/repo/pull/1'
      )!
      const own = { ...target, taskId: 'first-task' }
      const other = {
        ...target,
        taskId: 'second-task',
        deviceId: alias ? 'native-device' : target.deviceId,
      }
      const stops = [monitor.register(own), monitor.register(other)]
      try {
        await monitor.refresh()
        await monitor.refresh({ shareInflight: false })
        expect(executeCommand.mock.calls.map(([, request]) => request.command_key)).toEqual([
          'connection_observer_start',
          'connection_observer_refresh',
        ])
        expect(monitor.getSnapshot(own)?.target.taskId).toBe('first-task')
        expect(monitor.getSnapshot(other)?.target.taskId).toBe('second-task')
        expect(monitor.getSnapshot(other)?.resourceEvents).toBeUndefined()
      } finally {
        stops.forEach(stop => stop())
      }
    }
  )

  it.each(['delivered', 'needs_attention'])(
    'does not rearm %s when a manual refresh returns late',
    async status => {
      const response = deferred<DeviceCommandResponse>()
      const executeCommand = vi
        .fn<DeviceCommandApi['executeCommand']>()
        .mockImplementation(async (_device, request) =>
          request.command_key === 'connection_observation_refresh'
            ? response.promise
            : {
                success: true,
                stderr: '',
                stdout: { number: 1, url: 'https://github.com/org/repo/pull/1', state: 'OPEN' },
              }
        )
      const monitor = new ChangeRequestMonitor({ executeCommand })
      monitor.syncConnectionObservations(null, devices)
      const work = observationWork()
      const original = connectionEventSubscriptions(
        work.chats[0].tasks[0].runtimeHandle?.connectionEventSubscriptions
      )[0]
      monitor.syncConnectionObservations(work, devices)
      const target = {
        ...linkedChangeRequestTarget('local-device', 'https://github.com/org/repo/pull/1')!,
        taskId: 'task',
      }
      const stop = monitor.register(target)
      try {
        await monitor.refresh()
        const running = monitor.refresh({ shareInflight: false })
        await vi.waitFor(() => expect(executeCommand).toHaveBeenCalledTimes(1))
        const terminal = observationWork()
        connectionEventSubscriptions(
          terminal.chats[0].tasks[0].runtimeHandle?.connectionEventSubscriptions
        )[0].status = status
        monitor.syncConnectionObservations(terminal, devices)
        response.resolve({ success: true, stderr: '', stdout: { subscription: original } })
        await running
        await monitor.refresh({ shareInflight: false })
        expect(
          executeCommand.mock.calls.filter(
            ([, request]) => request.command_key === 'connection_observation_refresh'
          )
        ).toHaveLength(1)
      } finally {
        stop()
      }
    }
  )

  it('keeps newer shared facts when an older manual refresh returns', async () => {
    const response = deferred<DeviceCommandResponse>()
    const executeCommand = vi
      .fn<DeviceCommandApi['executeCommand']>()
      .mockReturnValue(response.promise)
    const monitor = new ChangeRequestMonitor({ executeCommand })
    monitor.syncConnectionObservations(null, devices)
    const work = observationWork()
    const original = structuredClone(
      connectionEventSubscriptions(
        work.chats[0].tasks[0].runtimeHandle?.connectionEventSubscriptions
      )[0]
    )
    monitor.syncConnectionObservations(work, devices)
    const target = {
      ...linkedChangeRequestTarget('local-device', 'https://github.com/org/repo/pull/1')!,
      taskId: 'task',
    }
    const stop = monitor.register(target)
    try {
      await monitor.refresh()
      const running = monitor.refresh({ shareInflight: false })
      const newer = observationWork()
      const subscription = connectionEventSubscriptions(
        newer.chats[0].tasks[0].runtimeHandle?.connectionEventSubscriptions
      )[0]
      subscription.last_collected_at! += 1000
      subscription.resource_states![0].data.title = 'Newest shared facts'
      subscription.resource_states![0].observedAt = '2026-11-15T00:00:01Z'
      monitor.syncConnectionObservations(newer, devices)
      response.resolve({ success: true, stderr: '', stdout: { subscription: original } })
      await running
      expect(monitor.getSnapshot(target)?.changeRequest?.title).toBe('Newest shared facts')
      expect(executeCommand).toHaveBeenCalledTimes(1)
    } finally {
      stop()
    }
  })

  it('projects a shared business snapshot including merge queue without another GitHub query', async () => {
    const executeCommand = vi.fn<DeviceCommandApi['executeCommand']>()
    const monitor = new ChangeRequestMonitor({ executeCommand })
    monitor.syncConnectionObservations(null, devices)
    const work = observationWork()
    const subscription = connectionEventSubscriptions(
      work.chats[0].tasks[0].runtimeHandle?.connectionEventSubscriptions
    )[0]
    const url = 'https://github.com/org/repo/pull/1'
    subscription.resource_states = [
      {
        kind: 'change_request',
        provider: 'github',
        topicId: url,
        observedAt: '2026-11-15T00:00:00Z',
        data: {
          number: 1,
          url,
          title: 'Observed PR',
          state: 'OPEN',
          headRefOid: 'revision',
          statusCheckRollup: { state: 'FAILURE' },
          mergeQueueEntry: { state: 'AWAITING_CHECKS' },
        },
      },
    ]
    monitor.syncConnectionObservations(work, devices)
    const target = { ...linkedChangeRequestTarget('local-device', url)!, taskId: 'task' }
    const stop = monitor.register(target)
    try {
      await monitor.refresh()
      expect(executeCommand).not.toHaveBeenCalled()
      expect(monitor.getSnapshot(target)).toMatchObject({
        changeRequest: {
          checks: 'failure',
          headSha: 'revision',
          mergeQueue: 'checking',
          title: 'Observed PR',
        },
        observation: { transport: 'connection' },
      })
      subscription.observed_events = 1
      subscription.resource_states[0].data.statusCheckRollup = { state: 'SUCCESS' }
      monitor.syncConnectionObservations(work, devices)
      await monitor.refresh()
      expect(monitor.getSnapshot(target)?.changeRequest?.checks).toBe('success')
      expect(executeCommand).not.toHaveBeenCalled()
      subscription.error_code = 'connector_auth_required'
      monitor.syncConnectionObservations(work, devices)
      expect(monitor.getSnapshot(target)).toMatchObject({
        stale: true,
        changeRequest: { checks: 'success' },
        observation: { state: 'auth_required' },
      })
    } finally {
      stop()
    }
  })
  function observationWork(
    observed = 0,
    error?: string,
    profile = 'account'
  ): RuntimeWorkListResponse {
    return {
      projects: [],
      chats: [
        {
          deviceId: 'local-device',
          tasks: [
            {
              taskId: 'task',
              runtimeHandle: {
                connectionEventSubscriptions: [
                  {
                    subscription_key: 'watch',
                    status: 'armed',
                    observation_id: `observation-${profile}`,
                    last_collected_at: Date.parse('2026-11-15T00:00:00Z'),
                    resource_states: [
                      {
                        kind: 'change_request',
                        provider: 'github',
                        topicId: 'https://github.com/org/repo/pull/1',
                        observedAt: '2026-11-15T00:00:00Z',
                        data: {
                          number: 1,
                          url: 'https://github.com/org/repo/pull/1',
                          state: 'OPEN',
                          title: 'Shared observation',
                          headRefName: 'fix/status',
                        },
                      },
                    ],
                    observed_events: observed,
                    resource_events: [
                      { key: 'a'.repeat(64), topicId: 'https://github.com/org/repo/pull/1' },
                    ],
                    error_code: error,
                    source: {
                      providerId: '@wegent/dsh-connection-git/github',
                      profile: JSON.stringify(['https://github.com', profile]),
                      kind: 'repository',
                      name: 'org/repo',
                      monitoredObjects: [{ entityKind: 'change_request', number: 1 }],
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    } as unknown as RuntimeWorkListResponse
  }

  it('uses an active PR observation for a workspace branch before any UI lookup', async () => {
    const executeCommand = vi.fn<DeviceCommandApi['executeCommand']>()
    const monitor = new ChangeRequestMonitor({ executeCommand })
    monitor.syncConnectionObservations(observationWork(), devices)
    const target = {
      deviceId: 'local-device',
      workspacePath: '/work/repo',
      remoteUrl: 'git@github.com:org/repo.git',
      taskId: 'task',
      branch: 'fix/status',
    }
    const stop = monitor.register(target)
    try {
      await monitor.refresh()
      expect(monitor.getSnapshot(target)?.changeRequest?.title).toBe('Shared observation')
      expect(executeCommand).not.toHaveBeenCalled()
    } finally {
      stop()
    }
  })

  it('keeps simultaneous task projections separate while sharing PR observation facts', async () => {
    const executeCommand = vi.fn<DeviceCommandApi['executeCommand']>()
    const monitor = new ChangeRequestMonitor({ executeCommand })
    monitor.syncConnectionObservations(null, devices)
    monitor.syncConnectionObservations(observationWork(), devices)
    const own = {
      ...linkedChangeRequestTarget('local-device', 'https://github.com/org/repo/pull/1')!,
      taskId: 'task',
    }
    const other = { ...own, taskId: 'other-task' }
    const stops = [monitor.register(own), monitor.register(other)]
    try {
      await monitor.refresh()
      expect(monitor.getSnapshot(own)?.target.taskId).toBe('task')
      expect(monitor.getSnapshot(own)?.resourceEvents).toHaveLength(1)
      expect(monitor.getSnapshot(other)?.target.taskId).toBe('other-task')
      expect(monitor.getSnapshot(other)?.resourceEvents).toBeUndefined()
      expect(monitor.getSnapshot(other)?.changeRequest).toEqual(
        monitor.getSnapshot(own)?.changeRequest
      )
      stops[1]()
      monitor.syncConnectionObservations(observationWork(1), devices)
      expect(monitor.getSnapshot(own)?.resourceEvents).toHaveLength(1)
      expect(executeCommand).not.toHaveBeenCalled()
    } finally {
      stops.forEach(stop => stop())
    }
  })

  it('shares observation health across tasks without granting another task event consumption', async () => {
    const executeCommand = vi.fn<DeviceCommandApi['executeCommand']>().mockResolvedValue({
      success: true,
      stdout: { number: 1, url: 'https://github.com/org/repo/pull/1', state: 'OPEN' },
    })
    const monitor = new ChangeRequestMonitor({ executeCommand })
    monitor.syncConnectionObservations(null, devices)
    const target = {
      ...linkedChangeRequestTarget('local-device', 'https://github.com/org/repo/pull/1')!,
      taskId: 'other-task',
    }
    const stop = monitor.register(target)
    try {
      await monitor.refresh()
      monitor.syncConnectionObservations(observationWork(), devices)
      expect(monitor.getSnapshot(target)?.observation?.transport).toBe('connection')
      expect(monitor.getSnapshot(target)?.resourceEvents).toBeUndefined()
      await monitor.refresh({ shareInflight: false })
      expect(monitor.getSnapshot(target)?.resourceEvents).toBeUndefined()
    } finally {
      stop()
    }
  })

  it('does not substitute an ambiguous account or another device for the requested observation', async () => {
    const executeCommand = vi.fn<DeviceCommandApi['executeCommand']>().mockResolvedValue({
      success: true,
      stdout: { number: 1, url: 'https://github.com/org/repo/pull/1', state: 'OPEN' },
    })
    const monitor = new ChangeRequestMonitor({ executeCommand })
    monitor.syncConnectionObservations(null, devices)
    const target = linkedChangeRequestTarget('local-device', 'https://github.com/org/repo/pull/1')!
    const stop = monitor.register(target)
    try {
      await monitor.refresh()
      const work = observationWork()
      const other = observationWork(0, undefined, 'another-account').chats[0].tasks[0]
      other.taskId = 'another-task'
      work.chats[0].tasks.push(other)
      monitor.syncConnectionObservations(work, devices)
      const before = executeCommand.mock.calls.length
      await monitor.refresh()
      expect(executeCommand.mock.calls.length).toBeGreaterThan(before)
      const remote = observationWork()
      remote.chats[0].deviceId = 'remote-device'
      monitor.syncConnectionObservations(remote, devices)
      const previous = executeCommand.mock.calls.length
      await monitor.refresh()
      expect(executeCommand.mock.calls.length).toBeGreaterThan(previous)
    } finally {
      stop()
    }
  })

  it('shares active observation with the status UI and keeps observing after model cancellation', async () => {
    const executeCommand = vi
      .fn<DeviceCommandApi['executeCommand']>()
      .mockImplementation(async (_device, request) =>
        request.command_key === 'connection_observation_refresh'
          ? {
              success: true,
              stderr: '',
              stdout: {
                subscription: {
                  ...connectionEventSubscriptions(
                    observationWork().chats[0].tasks[0].runtimeHandle?.connectionEventSubscriptions
                  )[0],
                  refresh_pending: true,
                },
              },
            }
          : request.command_key.startsWith('connection_observer_')
            ? connectionObserverReply(request)
            : {
                success: true,
                stdout: { number: 1, url: 'https://github.com/org/repo/pull/1', state: 'OPEN' },
                stderr: '',
              }
      )
    const monitor = new ChangeRequestMonitor({ executeCommand })
    monitor.syncConnectionObservations(null, devices)
    monitor.syncConnectionObservations(observationWork(), devices)
    const target = linkedChangeRequestTarget('local-device', 'https://github.com/org/repo/pull/1')!
    const stop = monitor.register(target)
    try {
      await monitor.refresh()
      const initial = executeCommand.mock.calls.length
      monitor.syncConnectionObservations(observationWork(), devices)
      await monitor.refresh()
      expect(executeCommand).toHaveBeenCalledTimes(initial)
      await monitor.refresh({ shareInflight: false })
      expect(executeCommand).toHaveBeenCalledTimes(initial + 1)
      expect(executeCommand).toHaveBeenLastCalledWith('local-device', {
        command_key: 'connection_observation_refresh',
        args: ['task', 'watch'],
      })
      expect(monitor.getSnapshot(target)?.observation?.state).toBe('refreshing')
      const manual = executeCommand.mock.calls.length
      monitor.syncConnectionObservations(observationWork(0, 'connector_auth_required'), devices)
      expect(monitor.getSnapshot(target)).toMatchObject({
        stale: true,
        changeRequest: { number: 1 },
        observation: { state: 'auth_required' },
      })
      monitor.syncConnectionObservations(observationWork(), devices)
      await vi.waitFor(() => expect(monitor.getSnapshot(target)?.stale).toBeFalsy())
      expect(executeCommand).toHaveBeenCalledTimes(manual)
      const recovered = executeCommand.mock.calls.length
      monitor.syncConnectionObservations(null, devices)
      await vi.waitFor(() => expect(executeCommand.mock.calls.length).toBeGreaterThan(recovered))
      expect(executeCommand.mock.calls.at(-1)![1].command_key).toBe('connection_observer_start')
      expect(
        executeCommand.mock.calls.some(([, request]) => request.command_key.startsWith('git_'))
      ).toBe(false)
    } finally {
      stop()
    }
  })

  it('keeps a new shared observation when an older UI observer request finishes', async () => {
    const first = deferred<DeviceCommandResponse>()
    const executeCommand = vi
      .fn<DeviceCommandApi['executeCommand']>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue({
        success: true,
        stdout: { number: 1, url: 'https://github.com/org/repo/pull/1', state: 'OPEN' },
      })
    const monitor = new ChangeRequestMonitor({ executeCommand })
    monitor.syncConnectionObservations(null, devices)
    const target = linkedChangeRequestTarget('local-device', 'https://github.com/org/repo/pull/1')!
    const stop = monitor.register(target)
    try {
      await vi.waitFor(() => expect(executeCommand).toHaveBeenCalledTimes(1))
      monitor.syncConnectionObservations(observationWork(1), devices)
      first.resolve({
        success: true,
        stdout: { number: 1, url: target.changeRequestUrl, state: 'OPEN' },
      })
      await monitor.refresh()
      expect(executeCommand.mock.calls.map(([, request]) => request.command_key)).toEqual([
        'connection_observer_start',
        'connection_observer_stop',
      ])
      expect(monitor.getSnapshot(target)?.changeRequest?.title).toBe('Shared observation')
      expect(monitor.getSnapshot(target)?.observation?.transport).toBe('connection')
    } finally {
      stop()
    }
  })

  it('keeps distinct PR links in one repository separate and marks failed refreshes stale', async () => {
    const executeCommand = vi
      .fn<DeviceCommandApi['executeCommand']>()
      .mockImplementation(async (_deviceId, request) => {
        return connectionObserverReply(request)
      })
    const monitor = new ChangeRequestMonitor({ executeCommand })
    monitor.syncConnectionObservations(null, devices)
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
    monitor.syncConnectionObservations(null, devices)
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
      .mockImplementationOnce(async (_device, request) => connectionObserverReply(request))
      .mockResolvedValueOnce({
        success: false,
        stdout: '',
        stderr: 'git_cli_missing',
      })
    const monitor = new ChangeRequestMonitor({ executeCommand })
    monitor.syncConnectionObservations(null, devices)
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
      error: 'git_cli_missing',
    })
    unregister()
  })
})
