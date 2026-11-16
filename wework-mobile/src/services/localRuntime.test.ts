import { describe, expect, it, vi } from 'vitest'
import {
  LocalRuntime,
  type LocalRuntimeEvent,
  type LocalRuntimeStatus,
  type NativeLocalRuntime,
} from './localRuntime'
import { LocalRuntimeApi } from './localRuntimeApi'
import { RuntimeApi } from './runtimeApi'
import { LocalCodexLogin } from './localCodexLogin'
import { setDiagnosticRecording } from './mobileDiagnostics'

const scope = 'a'.repeat(64)
const deviceId = `mobile-local:phone:${scope}`
const config = {
  backendUrl: 'https://wegent.test',
  apiBaseUrl: 'https://wegent.test/api',
  accessToken: 'old',
  socketBaseUrl: 'https://wegent.test',
  socketPath: '/socket.io',
}

function fixture(initial: Partial<LocalRuntimeStatus> = {}) {
  let status: LocalRuntimeStatus = {
    supported: true,
    state: 'running',
    accountScope: scope,
    deviceId,
    generation: 1,
    background: 'notRequested',
    ...initial,
  }
  const listeners = new Map<string, (value: never) => void>()
  const native = {
    getStatusAsync: vi.fn(async () => status),
    startAsync: vi.fn(async () => {
      status = {
        ...status,
        state: 'running',
        accountScope: scope,
        deviceId,
        generation: status.generation + 1,
      }
      return status
    }),
    stopAsync: vi.fn(async () => {
      status = { ...status, state: 'stopped' }
    }),
    requestAsync: vi.fn<NativeLocalRuntime['requestAsync']>(async () => ({
      type: 'response',
      id: 'native-1',
      ok: true,
      result: { accepted: true },
    })),
    importFileAsync: vi.fn(async () => ({ path: '/root/attachments/1/note.txt', size: 12 })),
    getEventsAsync: vi.fn<NativeLocalRuntime['getEventsAsync']>(async () => ({
      events: [],
      latestSequence: 0,
    })),
    addListener: vi.fn((name: string, listener: (value: never) => void) => {
      listeners.set(name, listener)
      return { remove: () => listeners.delete(name) }
    }),
  }
  const runtime = new LocalRuntime(native as unknown as NativeLocalRuntime, scope)
  return {
    native,
    runtime,
    emit: (name: string, value: unknown) => listeners.get(name)?.(value as never),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function journalEvent(sequence: number, generation = 1): LocalRuntimeEvent {
  return {
    sequence,
    generation,
    event: { event: 'runtime.tasks.changed', payload: { sequence } },
  }
}

type JournalPage = Awaited<ReturnType<NativeLocalRuntime['getEventsAsync']>>

describe('phone-local runtime ownership and lifecycle', () => {
  it('keeps a missing native runtime isolated and rejects local operations explicitly', async () => {
    const runtime = new LocalRuntime(null, scope)
    await runtime.initialize()
    expect(runtime.status.supported).toBe(false)
    expect(runtime.device()).toBeNull()
    await expect(runtime.start()).rejects.toThrow('不支持')
  })

  it('drains the previous account before mounting a new one and coalesces starts', async () => {
    const { native, runtime } = fixture({ accountScope: 'b'.repeat(64) })
    await runtime.initialize()
    expect(runtime.device()).toBeNull()
    await Promise.all([runtime.start(), runtime.start()])
    expect(native.stopAsync).toHaveBeenCalledExactlyOnceWith({ accountScope: 'b'.repeat(64) })
    expect(native.startAsync).toHaveBeenCalledOnce()
    expect(native.stopAsync.mock.invocationCallOrder[0]).toBeLessThan(
      native.startAsync.mock.invocationCallOrder[0]!
    )
    expect(runtime.device()?.device_type).toBe('local')
    await runtime.request('runtime.tasks.list')
    expect(native.requestAsync).toHaveBeenLastCalledWith(
      expect.objectContaining({ accountScope: scope })
    )
  })

  it('never switches filesystems when old guest processes cannot be stopped', async () => {
    const { runtime, native } = fixture({ accountScope: 'previous' })
    native.stopAsync.mockRejectedValue(new Error('guest threads still alive'))
    await expect(runtime.start()).rejects.toThrow('guest threads still alive')
    expect(native.startAsync).not.toHaveBeenCalled()
  })

  it('waits for native stop completion before starting the same phone environment', async () => {
    const { runtime, native, emit } = fixture({ state: 'stopping' })
    await runtime.initialize()
    const starting = runtime.start()
    await vi.waitFor(() => expect(native.getStatusAsync).toHaveBeenCalledTimes(3))
    expect(native.startAsync).not.toHaveBeenCalled()
    const stopped = { ...runtime.status, state: 'stopped' as const }
    native.getStatusAsync.mockResolvedValueOnce(stopped)
    emit('onRuntimeStatus', stopped)
    await starting
    expect(native.startAsync).toHaveBeenCalledOnce()
    expect(runtime.status.state).toBe('running')
  })

  it('does not restart an explicitly stopped environment on foreground', async () => {
    const { runtime, native } = fixture()
    await runtime.start()
    await runtime.stop()
    await runtime.resume()
    expect(native.startAsync).toHaveBeenCalledOnce()
    expect(runtime.status.state).toBe('stopped')
  })

  it('cancels a waiting start when the old phone profile is disposed', async () => {
    const { runtime, native } = fixture({ state: 'stopping' })
    const starting = runtime.start()
    const cancelled = expect(starting).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(native.getStatusAsync).toHaveBeenCalledTimes(2))
    runtime.dispose()
    await cancelled
    expect(native.startAsync).not.toHaveBeenCalled()
  })

  it('surfaces failed native shutdown rather than mounting another guest', async () => {
    const { runtime, native, emit } = fixture({ state: 'stopping' })
    const starting = runtime.start()
    const rejected = expect(starting).rejects.toThrow('guest threads still alive')
    await vi.waitFor(() => expect(native.getStatusAsync).toHaveBeenCalledTimes(2))
    const failed = {
      ...runtime.status,
      state: 'failed' as const,
      error: 'guest threads still alive',
    }
    native.getStatusAsync.mockResolvedValue(failed)
    emit('onRuntimeStatus', failed)
    await rejected
    expect(native.startAsync).not.toHaveBeenCalled()
  })

  it('deduplicates journal events, rejects obsolete generations, and recovers gaps', async () => {
    const { runtime, emit } = fixture()
    await runtime.initialize()
    const event = vi.fn()
    const recovery = vi.fn()
    runtime.onEvent(event)
    runtime.onRecovery(recovery)
    const envelope = {
      sequence: 1,
      generation: 1,
      event: { event: 'response.created', payload: { taskId: 'task' } },
    }
    emit('onRuntimeEvent', envelope)
    emit('onRuntimeEvent', envelope)
    emit('onRuntimeEvent', { ...envelope, sequence: 2, generation: 0 })
    emit('onRuntimeEvent', { ...envelope, sequence: 3 })
    expect(event).toHaveBeenCalledTimes(2)
    expect(event.mock.calls[0]![0].payload.deviceId).toBe(deviceId)
    expect(recovery).toHaveBeenCalledOnce()
    emit('onRuntimeStatus', { ...runtime.status, accountScope: 'another' })
    await expect(runtime.request('runtime.tasks.list')).rejects.toThrow('启动')
  })

  it('submits work and its lease ownership in one native request and preserves native failures', async () => {
    const { runtime, native } = fixture()
    await runtime.initialize()
    const timeout = new Error('timeout')
    native.requestAsync.mockRejectedValueOnce(timeout)
    await expect(
      runtime.requestUserWork('task', 'Work', 'runtime.tasks.send', { taskId: 'task' })
    ).rejects.toBe(timeout)
    expect(native.requestAsync).toHaveBeenCalledExactlyOnceWith({
      accountScope: scope,
      method: 'runtime.tasks.send',
      params: { taskId: 'task' },
      timeoutMs: 75_000,
      userWork: { taskId: 'task', title: 'Work' },
    })
  })

  it.each([true, false])(
    'unwraps accepted=%s without another JS lifecycle call',
    async accepted => {
      const { runtime, native } = fixture()
      await runtime.initialize()
      native.requestAsync.mockResolvedValueOnce({
        type: 'response',
        ok: true,
        id: 'work',
        result: { accepted },
      })
      await expect(
        runtime.requestUserWork('task', 'Work', 'runtime.tasks.send', { taskId: 'task' })
      ).resolves.toEqual({ accepted })
      expect(native.requestAsync).toHaveBeenCalledOnce()
    }
  )

  it('retains executor failure metadata for atomic user work', async () => {
    const { runtime, native } = fixture()
    await runtime.initialize()
    const error = { message: 'busy', code: 'runtime_busy', retryable: true }
    native.requestAsync.mockResolvedValueOnce({ type: 'response', ok: false, id: 'work', error })
    await expect(
      runtime.requestUserWork('task', 'Work', 'runtime.tasks.send', { taskId: 'task' })
    ).rejects.toMatchObject(error)
    expect(native.requestAsync).toHaveBeenCalledOnce()
  })

  it.each([{ state: 'stopped' as const }, { accountScope: 'other-account' }])(
    'rejects user work before native dispatch when the owned runtime is unavailable: %j',
    async status => {
      const { runtime, native } = fixture(status)
      await runtime.initialize()
      await expect(
        runtime.requestUserWork('task', 'Work', 'runtime.tasks.send', { taskId: 'task' })
      ).rejects.toThrow('启动')
      expect(native.requestAsync).not.toHaveBeenCalled()
    }
  )

  it.each([{ generation: 2 }, { accountScope: 'other-account' }])(
    'rejects obsolete user-work results after native ownership changes: %j',
    async status => {
      const { runtime, native, emit } = fixture()
      await runtime.initialize()
      const response = deferred<unknown>()
      native.requestAsync.mockReturnValueOnce(response.promise)
      const request = runtime.requestUserWork('task', 'Work', 'runtime.tasks.send', {
        taskId: 'task',
      })
      emit('onRuntimeStatus', { ...runtime.status, ...status })
      response.resolve({ type: 'response', ok: true, id: 'work', result: { accepted: true } })
      await expect(request).rejects.toThrow('执行环境已变化')
    }
  )

  it('merges live events with journal login completion and coalesces concurrent recovery', async () => {
    const { runtime, native, emit } = fixture()
    await runtime.initialize()
    const login = new LocalCodexLogin({
      onEvent: listener => runtime.onEvent(listener),
      request: vi.fn().mockResolvedValue({
        type: 'chatgptDeviceCode',
        loginId: 'login-1',
        userCode: 'CODE',
        verificationUrl: 'https://auth.openai.com/codex/device',
        processGeneration: 4,
      }),
    })
    await login.start()
    const page = deferred<JournalPage>()
    native.getEventsAsync.mockReturnValue(page.promise)
    const first = runtime.recover()
    const second = runtime.recover()
    expect(second).toBe(first)
    await vi.waitFor(() => expect(native.getEventsAsync).toHaveBeenCalledOnce())
    emit('onRuntimeEvent', journalEvent(2))
    page.resolve({
      events: [
        {
          sequence: 1,
          generation: 1,
          event: {
            event: 'runtime.codex.auth.login.completed',
            payload: { loginId: 'login-1', success: true, processGeneration: 4 },
          },
        },
      ],
      latestSequence: 1,
    })
    await Promise.all([first, second])
    expect(login.snapshot).toEqual({ login: null, error: null, completed: 1 })
    expect(native.getEventsAsync).toHaveBeenCalledOnce()
  })

  it('keeps the replay watermark on failure and retries the missing prefix before buffered live events', async () => {
    const { runtime, native, emit } = fixture()
    await runtime.initialize()
    const delivered: number[] = []
    runtime.onEvent(event => delivered.push((event.payload as { sequence: number }).sequence))
    const failure = deferred<JournalPage>()
    native.getEventsAsync
      .mockResolvedValueOnce({ events: [journalEvent(1)], latestSequence: 2, hasMore: true })
      .mockReturnValueOnce(failure.promise)
    const recovering = runtime.recover()
    const rejected = expect(recovering).rejects.toThrow('journal unavailable')
    await vi.waitFor(() => expect(native.getEventsAsync).toHaveBeenCalledTimes(2))
    emit('onRuntimeEvent', journalEvent(3))
    failure.reject(new Error('journal unavailable'))
    await rejected
    emit('onRuntimeEvent', journalEvent(4))
    expect(delivered).toEqual([])
    native.getEventsAsync.mockResolvedValueOnce({
      events: [journalEvent(1), journalEvent(2), journalEvent(3)],
      latestSequence: 3,
    })
    await runtime.recover()
    expect(native.getEventsAsync.mock.calls.map(([input]) => input.afterSequence)).toEqual([
      0, 1, 0,
    ])
    expect(delivered).toEqual([1, 2, 3, 4])
  })

  it('discards an obsolete recovery buffer when the native generation changes', async () => {
    const { runtime, native, emit } = fixture()
    await runtime.initialize()
    const delivered: number[] = []
    runtime.onEvent(event => delivered.push((event.payload as { sequence: number }).sequence))
    const obsolete = deferred<JournalPage>()
    native.getEventsAsync.mockReturnValueOnce(obsolete.promise)
    const recovering = runtime.recover()
    const rejected = expect(recovering).rejects.toThrow('执行环境已变化')
    await vi.waitFor(() => expect(native.getEventsAsync).toHaveBeenCalledOnce())
    emit('onRuntimeEvent', journalEvent(2))
    const status = { ...runtime.status, generation: 2 }
    native.getStatusAsync.mockResolvedValue(status)
    emit('onRuntimeStatus', status)
    emit('onRuntimeEvent', journalEvent(10, 2))
    obsolete.resolve({ events: [journalEvent(1)], latestSequence: 1 })
    await rejected
    expect(delivered).toEqual([])
    native.getEventsAsync.mockResolvedValueOnce({ events: [journalEvent(9, 2)], latestSequence: 9 })
    await runtime.recover()
    expect(delivered).toEqual([9, 10])
  })

  it.each([false, true])(
    'reports recovery transport state only with opt-in (%s) and no private data',
    async enabled => {
      const { runtime, native, emit } = fixture()
      await runtime.initialize()
      const info = vi.spyOn(console, 'info').mockImplementation(() => {})
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
      setDiagnosticRecording(enabled)
      try {
        const page = deferred<JournalPage>()
        native.getEventsAsync.mockReturnValueOnce(page.promise)
        const cause = new Error('sensitive-auth-detail')
        const recovering = expect(runtime.recover()).rejects.toBe(cause)
        await vi.waitFor(() => expect(native.getEventsAsync).toHaveBeenCalledOnce())
        emit('onRuntimeEvent', {
          ...journalEvent(1),
          event: { event: 'response.output_text.delta', payload: { content: 'private-message' } },
        })
        page.reject(cause)
        await recovering
        if (enabled)
          expect(info).toHaveBeenCalledWith('[LocalRuntime] Recovery failed', {
            state: 'running',
            generation: 1,
            sequence: 0,
            bufferedEvents: 1,
            buffering: true,
            eventListeners: 0,
          })
        else expect(info).not.toHaveBeenCalled()
        expect(warning).not.toHaveBeenCalled()
        const diagnostic = JSON.stringify([...info.mock.calls, ...warning.mock.calls])
        expect(diagnostic).not.toContain('sensitive-auth-detail')
        expect(diagnostic).not.toContain('private-message')
      } finally {
        setDiagnosticRecording(false)
        info.mockRestore()
        warning.mockRestore()
      }
    }
  )

  it('drains recovery state after stop/start without requiring an App foreground transition', async () => {
    const { runtime, native, emit } = fixture()
    await runtime.initialize()
    const delivered: number[] = []
    runtime.onEvent(event => delivered.push((event.payload as { sequence: number }).sequence))
    native.getEventsAsync.mockRejectedValueOnce(new Error('journal unavailable'))
    await expect(runtime.recover()).rejects.toThrow('journal unavailable')
    emit('onRuntimeEvent', journalEvent(2))
    await runtime.stop()
    native.getEventsAsync.mockResolvedValueOnce({ events: [journalEvent(9, 2)], latestSequence: 9 })
    await runtime.start()
    emit('onRuntimeEvent', journalEvent(10, 2))
    expect(runtime.status.state).toBe('running')
    expect(delivered).toEqual([9, 10])
  })
})

describe('phone-local PC protocol adapter', () => {
  async function setup() {
    const fixtureValue = fixture()
    await fixtureValue.runtime.initialize()
    let token = 'initial'
    const local = new LocalRuntimeApi(fixtureValue.runtime, config, () => token, {
      id: 7,
      user_name: 'tester',
    })
    const api = new RuntimeApi(config, undefined, () => token, undefined, local)
    return {
      ...fixtureValue,
      local,
      api,
      setToken: (value: string) => {
        token = value
      },
    }
  }
  const create = {
    schemaVersion: 2 as const,
    deviceId,
    taskId: 'task',
    runtime: 'codex' as const,
    workspacePath: '/root/project',
    message: 'write a file',
    title: 'Write',
    clientUserMessageId: 'user-1',
    modelId: 'account-model',
    modelType: 'runtime' as const,
    modelOptions: {
      runnerModelProvider: 'openai',
      permissionMode: 'full-access',
      reasoning: 'high',
    },
  }

  it('rejects a cloud model submission if Backend identity changes while model synchronization is pending', async () => {
    const { runtime, native } = await setup()
    const gate = deferred<void>()
    const local = new LocalRuntimeApi(
      runtime,
      config,
      () => 'account-a',
      { id: 0, user_name: 'local' },
      { sync: () => gate.promise }
    )
    local.updateBackend(config, 1)
    const pending = local.createConversation({
      ...create,
      modelType: 'public',
      modelId: 'cloud-model',
    })
    const rejected = expect(pending).rejects.toThrow('账号已变化')
    local.updateBackend({ ...config, accessToken: 'account-b' }, 2)
    gate.resolve()
    await rejected
    expect(native.requestAsync).not.toHaveBeenCalled()
  })

  it('keeps local model submissions independent of Backend logout and the cloud identity', async () => {
    const { runtime, native } = await setup()
    const gate = deferred<void>()
    const local = new LocalRuntimeApi(
      runtime,
      config,
      () => 'account-a',
      { id: 0, user_name: 'local', email: 'local@wework.local' },
      { sync: () => gate.promise }
    )
    const pending = local.createConversation(create)
    local.updateBackend(null)
    gate.resolve()
    await pending
    const payload = native.requestAsync.mock.calls[0][0].params as Record<string, any>
    expect(JSON.stringify(payload)).not.toContain('account-a')
    expect(payload.executionRequest.user).toMatchObject({ id: 0, user_name: 'local' })
  })

  it('uses trusted local IPC for both model sources, preserves permissions, and refreshes the gateway credential', async () => {
    const { api, native, setToken } = await setup()
    await api.createConversation(create)
    const first = native.requestAsync.mock.calls[0]![0] as {
      method: string
      params: Record<string, any>
      userWork: { taskId: string; title: string }
    }
    expect(first.method).toBe('runtime.tasks.create')
    expect(first.userWork).toEqual({ taskId: 'task', title: 'Write' })
    expect(first.params.executionRequest.model_config).toMatchObject({
      model_id: 'account-model',
      model_provider: 'openai',
    })
    expect(first.params.executionRequest.runtime_permission_profile).toEqual(':danger-full-access')
    setToken('refreshed')
    await api.sendMessage(
      { deviceId, taskId: 'task', workspacePath: '/root/project' },
      'continue',
      'user-2',
      {
        modelName: 'company-model',
        modelType: 'public',
        options: {
          weworkCloudModelNamespace: 'default',
          weworkCloudModelResourceUserId: '0',
          permissionMode: 'full-access',
        },
      }
    )
    const send = native.requestAsync.mock.calls.at(-1)![0] as {
      params: Record<string, any>
      userWork: { taskId: string; title: string }
    }
    expect(send.userWork).toEqual({ taskId: 'task', title: 'Wework 正在执行' })
    expect(send.params.executionRequest.model_config).toMatchObject({
      api_key: 'refreshed',
      wework_model_kind: 'cloud',
      model_id: 'company-model',
    })
    expect(send.params.executionRequest.new_session).toBe(false)
    expect(send.params.executionRequest.client_user_message_id).toBe('user-2')
  })

  it.each(['read-only', 'workspace-write'])(
    'rejects unsupported %s instead of elevating it',
    async permissionMode => {
      const { api, native } = await setup()
      await expect(
        api.createConversation({
          ...create,
          modelOptions: { ...create.modelOptions, permissionMode },
        })
      ).rejects.toThrow('不支持')
      expect(native.requestAsync).not.toHaveBeenCalled()
    }
  )

  it('imports attachments into the guest filesystem and refuses cross-device attachment IDs', async () => {
    const { api, native } = await setup()
    const attachment = await api.uploadAttachment(
      { uri: 'file:///phone/note.txt', name: 'note.txt', mimeType: 'text/plain' },
      deviceId
    )
    expect(native.importFileAsync).toHaveBeenCalledWith({
      accountScope: scope,
      uri: 'file:///phone/note.txt',
      name: 'note.txt',
    })
    await api.createConversation({ ...create, attachmentIds: [attachment.id] })
    const params = (native.requestAsync.mock.calls.at(-1)![0] as { params: Record<string, any> })
      .params
    expect(params.executionRequest.attachments[0].local_path).toBe('/root/attachments/1/note.txt')
    expect(params.executionRequest.attachments[0].local_path).not.toContain('file://')
    expect(params).not.toHaveProperty('attachmentIds')
    expect(() =>
      api.createConversation({ ...create, deviceId: 'remote', attachmentIds: [attachment.id] })
    ).toThrow('其他设备')
  })

  it('sends structured answers with atomic work ownership and unchanged PC payloads', async () => {
    const { api, native } = await setup()
    const address = { deviceId, taskId: 'task' }
    const response = {
      requestId: 0,
      itemId: 'item',
      interactionScope: 'turn',
      answers: { choice: { answers: ['One'] } },
    }
    await api.respondToUserInput(address, response)
    expect(native.requestAsync).toHaveBeenCalledExactlyOnceWith({
      accountScope: scope,
      method: 'runtime.tasks.send',
      params: { address, taskId: 'task', message: 'One', requestUserInputResponse: response },
      timeoutMs: 75_000,
      userWork: { taskId: 'task', title: 'Wework 正在执行' },
    })
  })

  it('dispatches goal continuation atomically and never sends local IDs to Backend', async () => {
    const { api, native } = await setup()
    await api.setGoal({ deviceId, taskId: 'task' }, 'finish')
    expect(native.requestAsync).toHaveBeenCalledExactlyOnceWith({
      accountScope: scope,
      method: 'runtime.tasks.goal.set',
      params: { address: { deviceId, taskId: 'task' }, objective: 'finish', status: 'active' },
      timeoutMs: 75_000,
      userWork: { taskId: 'task', title: 'finish' },
    })
    const fetch = vi.spyOn(globalThis, 'fetch')
    await expect(new RuntimeApi(config).cancelTask({ deviceId, taskId: 'task' })).rejects.toThrow(
      '尚未就绪'
    )
    expect(fetch).not.toHaveBeenCalled()
    fetch.mockRestore()
  })
})
