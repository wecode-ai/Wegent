// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import { linkedChangeRequestTarget } from '@/api/changeRequests'
import { outputAsRecord, type DeviceCommandApi } from '@/api/environment'
import type { DeviceCommandResponse } from '@/types/api'
import { connectionObserverReply } from '@/test/connection-observer'
import { ChangeRequestUiObserver } from './changeRequestUiObserver'
import { DshExecutorTransportError } from '@/api/dsh/executorTransport'

const target = linkedChangeRequestTarget('device', 'https://github.com/org/repo/pull/1')!

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return { promise, resolve }
}

describe('visible PR observation leases', () => {
  it.each([
    ['connector_auth_required', 'unauthenticated', 'auth_required'],
    ['git_cli_missing', 'unavailable', 'error'],
    ['git_account_changed', 'unauthenticated', 'auth_required'],
  ])('preserves the structured Native %s diagnosis', async (code, lookupState, state) => {
    const executeCommand = vi
      .fn<DeviceCommandApi['executeCommand']>()
      .mockRejectedValue(new DshExecutorTransportError(code, 'The runtime operation failed'))
    const observer = new ChangeRequestUiObserver({ executeCommand })
    observer.synchronize([target])
    expect(await observer.read(target, false)).toMatchObject({
      error: code,
      lookupState,
      observation: { state, error: code },
    })
    observer.synchronize([])
  })

  it.each([
    ['https://github.com/org/pull/pull/1', 'org/pull', 'github'],
    [
      'https://gitlab.example/group/subgroup/repo/-/merge_requests/3',
      'group/subgroup/repo',
      'gitlab',
    ],
  ])('observes the exact repository and instance for %s', async (url, repository, platform) => {
    const executeCommand = vi
      .fn<DeviceCommandApi['executeCommand']>()
      .mockImplementation(async (_device, request) => connectionObserverReply(request))
    const observer = new ChangeRequestUiObserver({ executeCommand })
    const exact = linkedChangeRequestTarget('device', url)!
    observer.synchronize([exact])
    const result = await observer.read(exact, false)
    expect(result?.changeRequest?.url).toBe(url)
    const input = JSON.parse(executeCommand.mock.calls[0][1].args![0])
    expect(input.discovery.providerId).toBe(`@wegent/dsh-connection-git/${platform}`)
    expect(JSON.parse(input.discovery.query).repository).toBe(repository)
    observer.synchronize([])
  })

  it('shares one activation between tasks and routes manual refresh through that lease', async () => {
    const first = deferred<DeviceCommandResponse>()
    const executeCommand = vi
      .fn<DeviceCommandApi['executeCommand']>()
      .mockReturnValueOnce(first.promise)
      .mockImplementation(async (_device, request) => connectionObserverReply(request))
    const observer = new ChangeRequestUiObserver({ executeCommand })
    const other = { ...target, taskId: 'another-task' }
    observer.synchronize([target, other])
    const reads = [observer.read(target, false), observer.read(other, false)]
    expect(executeCommand).toHaveBeenCalledTimes(1)
    first.resolve(connectionObserverReply(executeCommand.mock.calls[0][1]))
    const results = await Promise.all(reads)
    expect(results.map(result => result?.target.taskId)).toEqual([target.taskId, 'another-task'])
    expect(results.every(result => result?.changeRequest?.number === 1)).toBe(true)
    await observer.read(target, false)
    await observer.read(target, true)
    expect(executeCommand.mock.calls.map(([, request]) => request.command_key)).toEqual([
      'connection_observer_start',
      'connection_observer_renew',
      'connection_observer_refresh',
    ])
    const addresses = executeCommand.mock.calls.map(([, request]) => JSON.parse(request.args![0]))
    expect(new Set(addresses.map(value => value.generation)).size).toBe(1)
    expect(addresses[0].discovery).toEqual({
      providerId: '@wegent/dsh-connection-git/github',
      kind: 'repository',
      query: JSON.stringify({
        instance: 'https://github.com',
        repository: 'org/repo',
        monitoredObjects: [{ entityKind: 'change_request', number: 1 }],
      }),
    })
    observer.synchronize([other])
    expect(executeCommand).toHaveBeenCalledTimes(3)
    observer.synchronize([])
    expect(executeCommand.mock.calls.at(-1)![1].command_key).toBe('connection_observer_stop')
    expect(results.every(result => !result?.resourceEvents)).toBe(true)
  })

  it('does not publish a late start after all views close and reopening gets a fresh generation', async () => {
    const first = deferred<DeviceCommandResponse>()
    const executeCommand = vi
      .fn<DeviceCommandApi['executeCommand']>()
      .mockReturnValueOnce(first.promise)
      .mockImplementation(async (_device, request) => connectionObserverReply(request))
    const observer = new ChangeRequestUiObserver({ executeCommand })
    observer.synchronize([target])
    const reads = [
      observer.read(target, false),
      observer.read({ ...target, taskId: 'other' }, false),
    ]
    const original = executeCommand.mock.calls[0][1]
    observer.synchronize([])
    expect(executeCommand.mock.calls[1][1].command_key).toBe('connection_observer_stop')
    observer.synchronize([target])
    const reopened = await observer.read(target, false)
    first.resolve(connectionObserverReply(original))
    expect(await Promise.all(reads)).toEqual([null, null])
    expect(reopened?.changeRequest?.number).toBe(1)
    const fresh = executeCommand.mock.calls[2][1]
    expect(JSON.parse(fresh.args![0]).generation).not.toBe(JSON.parse(original.args![0]).generation)
    observer.synchronize([])
  })

  it('keeps an uncertain start idempotent and replaces only an expired generation', async () => {
    const executeCommand = vi
      .fn<DeviceCommandApi['executeCommand']>()
      .mockRejectedValueOnce(new Error('connection_lost'))
      .mockImplementation(async (_device, request) => connectionObserverReply(request))
    const observer = new ChangeRequestUiObserver({ executeCommand })
    observer.synchronize([target])
    expect((await observer.read(target, false))?.observation?.state).toBe('error')
    await observer.read(target, false)
    expect(executeCommand.mock.calls[0][1]).toEqual(executeCommand.mock.calls[1][1])
    executeCommand.mockRejectedValueOnce(new Error('observation_observer_lease_lost'))
    await observer.read(target, false)
    await observer.read(target, false)
    expect(executeCommand.mock.calls[3][1].command_key).toBe('connection_observer_start')
    expect(JSON.parse(executeCommand.mock.calls[3][1].args![0]).generation).not.toBe(
      JSON.parse(executeCommand.mock.calls[0][1].args![0]).generation
    )
    observer.synchronize([])
  })

  it.each(['consumer', 'generation', 'source', 'observation', 'account'])(
    'rejects a response for another %s',
    async mismatch => {
      const executeCommand = vi
        .fn<DeviceCommandApi['executeCommand']>()
        .mockImplementation(async (_device, request) => {
          const reply = connectionObserverReply(request)
          const output = outputAsRecord(reply.stdout)!
          const observed = outputAsRecord(output.observer)!
          const source = outputAsRecord(observed.source)!
          const observation = outputAsRecord(output.observation)!
          if (mismatch === 'consumer') observed.consumerKey = 'another-consumer'
          if (mismatch === 'generation') observed.generation = 'another-generation'
          if (mismatch === 'source') source.name = 'another/repository'
          if (mismatch === 'observation') observation.id = 'another-observation'
          if (mismatch === 'account')
            source.profile = JSON.stringify(['https://other.example', 'account'])
          return reply
        })
      const observer = new ChangeRequestUiObserver({ executeCommand })
      observer.synchronize([target])
      expect(await observer.read(target, false)).toMatchObject({
        changeRequest: null,
        error: 'connection_observation_invalid_response',
      })
      observer.synchronize([])
    }
  )
})
