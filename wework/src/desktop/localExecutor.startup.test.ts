import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  DshExecutorTransportError,
  describeDshExecutor,
  requestDshExecutor,
  subscribeDshExecutorEvents,
} from '@/api/dsh/executorTransport'
import { createLocalAppServices } from '@/api/local/localServices'
import { getLocalCodexOfficialModels } from '@/api/local/codexOfficialModels'
import { saveLocalProxyUrl } from '@/features/model-settings/localProxySettings'
import {
  ensureLocalExecutorAvailable,
  ensureLocalExecutorStarted,
  ensureBundledPluginInstalled,
  getInitializedBundledPluginMarketplace,
  getKnownLocalExecutorDeviceId,
  requestLocalExecutor,
  resetLocalExecutorStateForTests,
} from './localExecutor'
import { deferred, mockStartup } from './localExecutor.test-fixtures'

vi.mock('@/api/dsh/executorTransport', async importOriginal => ({
  ...(await importOriginal<typeof import('@/api/dsh/executorTransport')>()),
  describeDshExecutor: vi.fn(),
  requestDshExecutor: vi.fn(),
  subscribeDshExecutorEvents: vi.fn(),
}))

const requestMock = vi.mocked(requestDshExecutor)
const conversationMethods = [
  'runtime.tasks.transcript',
  'runtime.tasks.transcript.search',
  'runtime.tasks.goal.get',
  'runtime.tasks.goal.set',
  'runtime.tasks.goal.clear',
] as const

describe('local Codex startup admission', () => {
  beforeEach(() => {
    localStorage.clear()
    delete window.weworkElectronNetwork
    resetLocalExecutorStateForTests()
    vi.mocked(describeDshExecutor).mockReset()
    requestMock.mockReset()
    vi.mocked(subscribeDshExecutorEvents).mockReturnValue(() => undefined)
    mockStartup()
  })

  test('negotiates bounded transcript transport while accepting an older executor response', async () => {
    await ensureBundledPluginInstalled('smart-app-builder')
    const transcript = { messages: [], turns: [], fullContent: false }
    requestMock.mockClear()
    requestMock.mockResolvedValue(transcript)
    expect(await requestLocalExecutor('runtime.tasks.transcript', { taskId: 'task-1' })).toBe(
      transcript
    )
    expect(requestMock).toHaveBeenCalledExactlyOnceWith('runtime.tasks.transcript', {
      taskId: 'task-1',
      transcriptProtocolVersion: 2,
    })
  })

  test('reports executor availability without starting Codex or copying plugins', async () => {
    await expect(ensureLocalExecutorAvailable()).resolves.toEqual({
      running: true,
      ready: true,
      deviceId: 'electron-device',
      runtimeInstanceId: 'electron-runtime',
      version: '1.8.6',
    })
    expect(describeDshExecutor).toHaveBeenCalledOnce()
    expect(requestMock).not.toHaveBeenCalled()
    expect(getInitializedBundledPluginMarketplace()).toBeNull()
    expect(getKnownLocalExecutorDeviceId()).toBe('electron-device')
  })

  test('forwards read cancellation through bounded transcript transport', async () => {
    const controller = new AbortController()
    requestMock.mockResolvedValue({ messages: [], turns: [], fullContent: false })
    await requestLocalExecutor('runtime.tasks.transcript', { taskId: 'task-1' }, undefined, {
      signal: controller.signal,
    })
    expect(requestMock).toHaveBeenCalledWith(
      'runtime.tasks.transcript',
      { taskId: 'task-1', transcriptProtocolVersion: 2 },
      { signal: controller.signal }
    )
  })

  test.each(['request_timeout', 'request_cancelled', 'runtime_read_busy'])(
    'keeps runtime readiness after an operation fails with %s',
    async code => {
      await ensureLocalExecutorStarted()
      await ensureBundledPluginInstalled('smart-app-builder')
      requestMock.mockRejectedValueOnce(new DshExecutorTransportError(code, code, true))
      await expect(
        requestLocalExecutor('runtime.tasks.transcript', { taskId: 'task-1' })
      ).rejects.toThrow(code)
      await ensureLocalExecutorStarted()
      expect(describeDshExecutor).toHaveBeenCalledOnce()
      expect(
        requestMock.mock.calls.filter(([method]) => method === 'runtime.codex.ensure_started')
      ).toHaveLength(1)
    }
  )

  test('keeps runtime readiness after a native transcript abort', async () => {
    await ensureLocalExecutorStarted()
    await ensureBundledPluginInstalled('smart-app-builder')
    const controller = new AbortController()
    controller.abort()
    const error = new DOMException('The operation was aborted', 'AbortError')
    requestMock.mockRejectedValueOnce(error)

    await expect(
      requestLocalExecutor('runtime.tasks.transcript', { taskId: 'task-1' }, undefined, {
        signal: controller.signal,
      })
    ).rejects.toBe(error)
    await ensureLocalExecutorStarted()

    expect(describeDshExecutor).toHaveBeenCalledOnce()
    expect(
      requestMock.mock.calls.filter(([method]) => method === 'runtime.codex.ensure_started')
    ).toHaveLength(1)
  })

  test('retains actual transport failures when a transcript signal is also aborted', async () => {
    await ensureLocalExecutorStarted()
    await ensureBundledPluginInstalled('smart-app-builder')
    const controller = new AbortController()
    controller.abort()
    requestMock.mockRejectedValueOnce(new Error('IPC disconnected'))

    await expect(
      requestLocalExecutor('runtime.tasks.transcript', { taskId: 'task-1' }, undefined, {
        signal: controller.signal,
      })
    ).rejects.toThrow('IPC disconnected')
    mockStartup()
    await ensureLocalExecutorStarted()

    expect(describeDshExecutor).toHaveBeenCalledTimes(2)
  })

  test('history, search and goals share proxy configuration with Codex catalog startup', async () => {
    const proxy = deferred<string | null>()
    const configuration = deferred<unknown>()
    const startup = deferred<unknown>()
    window.weworkElectronNetwork = { resolveProxy: vi.fn(() => proxy.promise) }
    const defaultRequest = requestMock.getMockImplementation()!
    requestMock.mockImplementation(async (...args) => {
      if (args[0] === 'runtime.codex.runtime_config.update') return configuration.promise
      if (args[0] === 'runtime.codex.ensure_started') return startup.promise
      return defaultRequest(...args)
    })

    const requests = conversationMethods.map(method =>
      requestLocalExecutor(method, { taskId: 'task-1' })
    )
    const catalogStartup = getLocalCodexOfficialModels()
    await vi.waitFor(() =>
      expect(window.weworkElectronNetwork!.resolveProxy).toHaveBeenCalledOnce()
    )
    expect(requestMock).not.toHaveBeenCalled()

    proxy.resolve('http://127.0.0.1:7890')
    await vi.waitFor(() =>
      expect(requestMock).toHaveBeenCalledExactlyOnceWith('runtime.codex.runtime_config.update', {
        proxyUrl: 'http://127.0.0.1:7890',
      })
    )
    configuration.resolve({ updated: true })
    await Promise.all(requests)
    for (const method of conversationMethods) {
      expect(requestMock.mock.calls.filter(([called]) => called === method)).toHaveLength(1)
    }
    expect(
      requestMock.mock.calls.filter(([method]) => method === 'runtime.codex.ensure_started')
    ).toHaveLength(1)
    expect(requestMock.mock.calls.some(([method]) => method === 'runtime.codex.models.list')).toBe(
      false
    )
    startup.resolve({ ready: true, started: true, initializeElapsedMs: 0 })
    await catalogStartup
    expect(
      requestMock.mock.calls.filter(([method]) => method === 'runtime.codex.models.list')
    ).toHaveLength(1)
  })

  test.each(['codex', 'claude_code'] as const)(
    'the local service %s history entry configures the proxy before its runtime starts',
    async runtime => {
      saveLocalProxyUrl('http://127.0.0.1:7890')
      const services = createLocalAppServices({ subscribe: () => () => undefined })
      await services.runtimeWorkApi!.getRuntimeTranscript({
        deviceId: 'electron-device',
        taskId: 'task-1',
        runtime,
      })
      const startupMethods = [
        'runtime.codex.runtime_config.update',
        'runtime.codex.ensure_started',
        'runtime.tasks.transcript',
      ]
      expect(requestMock.mock.calls.filter(([method]) => startupMethods.includes(method))).toEqual([
        ['runtime.codex.runtime_config.update', { proxyUrl: 'http://127.0.0.1:7890' }],
        ...(runtime === 'codex' ? [['runtime.codex.ensure_started']] : []),
        [
          'runtime.tasks.transcript',
          { deviceId: 'electron-device', taskId: 'task-1', runtime, transcriptProtocolVersion: 2 },
        ],
      ])
    }
  )

  test('failed proxy configuration rejects all waiting reads without dispatch or retry', async () => {
    const configuration = deferred<unknown>()
    const defaultRequest = requestMock.getMockImplementation()!
    requestMock.mockImplementation(async (...args) => {
      if (args[0] === 'runtime.codex.runtime_config.update') return configuration.promise
      return defaultRequest(...args)
    })
    const readers = conversationMethods.map(method =>
      requestLocalExecutor(method, { taskId: 'task-1' })
    )
    const results = Promise.allSettled([...readers, ensureLocalExecutorStarted()])
    await vi.waitFor(() => expect(requestMock).toHaveBeenCalledOnce())
    const error = new Error('proxy configuration failed')
    configuration.reject(error)
    expect(await results).toEqual(
      Array.from({ length: readers.length + 1 }, () => ({ status: 'rejected', reason: error }))
    )
    expect(requestMock).toHaveBeenCalledExactlyOnceWith('runtime.codex.runtime_config.update', {
      proxyUrl: null,
    })
  })

  test('Codex startup failure does not block histories and goals from other runtimes', async () => {
    const startup = deferred<unknown>()
    const defaultRequest = requestMock.getMockImplementation()!
    requestMock.mockImplementation(async (...args) => {
      if (args[0] === 'runtime.codex.ensure_started') return startup.promise
      return defaultRequest(...args)
    })
    const catalogStartup = ensureLocalExecutorStarted()
    const failure = expect(catalogStartup).rejects.toThrow('Codex startup failed')
    await vi.waitFor(() =>
      expect(
        requestMock.mock.calls.some(([method]) => method === 'runtime.codex.ensure_started')
      ).toBe(true)
    )
    startup.reject(new Error('Codex startup failed'))
    await failure
    for (const method of conversationMethods) {
      await requestLocalExecutor(method, { taskId: 'claude-task' })
    }
    expect(
      requestMock.mock.calls.filter(([method]) => method === 'runtime.codex.ensure_started')
    ).toHaveLength(1)
    expect(
      requestMock.mock.calls.filter(([method]) => method === 'runtime.codex.runtime_config.update')
    ).toHaveLength(1)
    for (const method of conversationMethods) {
      expect(requestMock.mock.calls.filter(([called]) => called === method)).toHaveLength(1)
    }
    expect(getInitializedBundledPluginMarketplace()).toBeNull()
  })

  test('runtime replacement invalidates proxy configuration before the next history read', async () => {
    await requestLocalExecutor('runtime.tasks.transcript', { taskId: 'task-1' })
    const description = await vi.mocked(describeDshExecutor)()
    vi.mocked(describeDshExecutor).mockResolvedValue({
      ...description,
      runtime_instance_id: 'replacement-runtime',
    })
    await ensureLocalExecutorAvailable({ refresh: true })
    requestMock.mockClear()
    await requestLocalExecutor('runtime.tasks.transcript', { taskId: 'task-1' })
    expect(requestMock.mock.calls.map(([method]) => method)).toEqual([
      'runtime.codex.runtime_config.update',
      'runtime.tasks.transcript',
    ])
  })

  test('identity revocation during proxy configuration cannot admit a stale history read', async () => {
    const configuration = deferred<unknown>()
    const defaultRequest = requestMock.getMockImplementation()!
    requestMock.mockImplementation(async (...args) => {
      if (args[0] === 'runtime.codex.runtime_config.update') return configuration.promise
      return defaultRequest(...args)
    })
    const rejected = expect(
      requestLocalExecutor('runtime.tasks.transcript', { taskId: 'task-1' })
    ).rejects.toMatchObject({ code: 'protocol_mismatch' })
    await vi.waitFor(() => expect(requestMock).toHaveBeenCalledOnce())
    requestMock.mockRejectedValueOnce(
      new DshExecutorTransportError('protocol_mismatch', 'Invalid Runtime identity')
    )
    await expect(requestLocalExecutor('runtime.tasks.list')).rejects.toThrow(
      'Invalid Runtime identity'
    )
    configuration.resolve({ updated: true })
    await rejected
    expect(requestMock.mock.calls.some(([method]) => method === 'runtime.tasks.transcript')).toBe(
      false
    )
    expect(getKnownLocalExecutorDeviceId()).toBeNull()
  })

  test('metadata and connection discovery do not wait for or initiate Codex startup', async () => {
    const proxy = deferred<string | null>()
    window.weworkElectronNetwork = { resolveProxy: vi.fn(() => proxy.promise) }
    const startup = ensureLocalExecutorStarted()
    await vi.waitFor(() =>
      expect(window.weworkElectronNetwork!.resolveProxy).toHaveBeenCalledOnce()
    )
    for (const method of ['runtime.tasks.list', 'runtime.connections.list']) {
      await requestLocalExecutor(method)
    }
    expect(requestMock.mock.calls.map(([method]) => method)).toEqual([
      'runtime.tasks.list',
      'runtime.connections.list',
    ])
    proxy.resolve(null)
    await startup
  })
})
