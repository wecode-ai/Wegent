// @vitest-environment node

import i18n from '@/i18n'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindProjectStandInApi, createStandInExecutorApi, type StandInExecutorApi } from './standIn'

const settings = { enabled: false, prompt: '', executionDeviceId: '', version: 0 }

it('shares only in-flight profile reads within one backend-scoped API instance', async () => {
  let release!: (value: unknown) => void
  const request = vi.fn().mockImplementation(
    () =>
      new Promise(resolve => {
        release = resolve
      })
  )
  const api = createStandInExecutorApi(request)
  const first = api.personalGet(7, 'mac')
  const second = api.personalGet(7, 'mac')
  expect(first).toBe(second)
  expect(request).toHaveBeenCalledTimes(1)
  release({ userId: 7, executionDeviceId: 'mac', version: 0, roles: [] })
  await first
  const next = api.personalGet(7, 'mac')
  expect(request).toHaveBeenCalledTimes(2)
  release({ userId: 7, executionDeviceId: 'mac', version: 1, roles: [] })
  await next
})

it('invalidates alias reads started during a write even when its response fails', async () => {
  let rejectSave!: (error: Error) => void
  const reads: Array<(value: unknown) => void> = []
  const request = vi.fn((method: string) =>
    method === 'runtime.stand_in.personal.save'
      ? new Promise((_resolve, reject) => {
          rejectSave = reject
        })
      : new Promise(resolve => reads.push(resolve))
  )
  const api = createStandInExecutorApi(request)
  const failure = api
    .personalSave(7, { userId: 7, executionDeviceId: 'mac', version: 0, roles: [] }, 'app-record-1')
    .catch(error => error)
  const stale = api.personalGet(7, 'mac')
  rejectSave(new Error('Response lost'))
  await failure
  const fresh = api.personalGet(7, 'mac')
  expect(fresh).not.toBe(stale)
  const value = { userId: 7, executionDeviceId: 'mac', version: 1, roles: [] }
  reads.forEach(resolve => resolve(value))
  await Promise.all([stale, fresh])
})

it('routes forgetting-rule reads and versioned deletion to the selected owner device', async () => {
  const request = vi.fn().mockResolvedValue({ items: [] })
  const api = createStandInExecutorApi(request)
  expect(await api.memoryRules(7, 'owner-device')).toEqual([])
  expect(request).toHaveBeenLastCalledWith(
    'runtime.stand_in.memory.rules.list',
    { userId: 7 },
    'owner-device'
  )
  await api.deleteMemoryRule(7, 'owner-device', 'rule-1', 3)
  expect(request).toHaveBeenLastCalledWith(
    'runtime.stand_in.memory.rules.delete',
    { userId: 7, id: 'rule-1', version: 3 },
    'owner-device'
  )
  await api.deleteMemoryRule(7, 'owner-device', 'legacy-1', 1, 'revision')
  expect(request).toHaveBeenLastCalledWith(
    'runtime.stand_in.memory.rules.delete',
    { userId: 7, id: 'legacy-1', version: 1, expectedUpdatedAt: 'revision' },
    'owner-device'
  )
})

it('keeps instance binding on its local owner while addressing lifecycle operations to the bound Executor', async () => {
  const request = vi
    .fn()
    .mockResolvedValue({ userId: 7, executionDeviceId: 'cloud', version: 1, roles: [] })
  const api = createStandInExecutorApi(request)
  await api.binding('mac', 'bind', 3, { userId: 7, deviceId: 'cloud' })
  expect(request).toHaveBeenLastCalledWith(
    'runtime.stand_in.binding',
    { operation: 'bind', version: 3, target: { userId: 7, deviceId: 'cloud' } },
    'mac'
  )
  await api.lifecycle(7, 'cloud', 'stop')
  expect(request).toHaveBeenLastCalledWith(
    'runtime.stand_in.personal.lifecycle',
    { userId: 7, operation: 'stop' },
    'cloud'
  )
})

it('treats the cloud transport task_not_found as an empty first-conversation lookup', async () => {
  const request = vi
    .fn()
    .mockRejectedValue(
      Object.assign(new Error('Task not found on the owning Runtime'), { code: 'task_not_found' })
    )
  expect(await createStandInExecutorApi(request).readTask('cloud', 'new-conversation')).toEqual({
    success: false,
    code: 'task_not_found',
  })
  expect(request).toHaveBeenCalledWith('runtime.tasks.get', { taskId: 'new-conversation' }, 'cloud')
})

it.each(['permission_denied', 'task_archived', 'cloud_unavailable'])(
  'preserves %s errors while looking up a conversation',
  async code => {
    const error = Object.assign(new Error(code), { code })
    const api = createStandInExecutorApi(vi.fn().mockRejectedValue(error))
    await expect(api.readTask('cloud', 'conversation')).rejects.toMatchObject({
      code,
      cause: error,
    })
  }
)

it.each(['America/New_York', 'Europe/London'])(
  'routes onboarding with the client timezone %s to the selected Executor',
  async timezone => {
    const options = Intl.DateTimeFormat().resolvedOptions()
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
      ...options,
      timeZone: timezone,
    })
    const request = vi.fn().mockResolvedValue({ state: { version: 1, completed: true } })
    const api = createStandInExecutorApi(request)
    await api.onboarding(7, 'selected-device', 'zh-CN')
    expect(request).toHaveBeenLastCalledWith(
      'runtime.stand_in.onboarding.get',
      { userId: 7, language: 'zh-CN', timezone },
      'selected-device'
    )
    await api.completeOnboarding(7, 'selected-device', false, '10:30', 'zh-CN')
    expect(request).toHaveBeenLastCalledWith(
      'runtime.stand_in.onboarding.complete',
      { userId: 7, weeklyReview: false, time: '10:30', language: 'zh-CN', timezone },
      'selected-device'
    )
  }
)

it('addresses project binding reads and explicit generation updates to the selected Executor', async () => {
  const state = { binding: null, canEnable: true, canStop: false }
  const request = vi.fn().mockResolvedValue(state)
  const api = createStandInExecutorApi(request)
  const target = { projectId: 'project', projectStore: 'cloud' as const, groupId: 'group' }
  expect(await api.projectCoordination(7, 'selected-device', target)).toBe(state)
  expect(request).toHaveBeenLastCalledWith(
    'runtime.project_coordinator.binding.get',
    { userId: 7, ...target },
    'selected-device'
  )
  const update = { enabled: true, expectedGeneration: 'current-generation', takeover: true }
  expect(await api.projectCoordination(7, 'selected-device', target, update)).toBe(state)
  expect(request).toHaveBeenLastCalledWith(
    'runtime.project_coordinator.binding.save',
    { userId: 7, ...target, binding: update },
    'selected-device'
  )
})

it('addresses project processing status and explicit checks to the chosen binding host', async () => {
  const request = vi.fn().mockResolvedValue({ running: false, questions: {} })
  const api = createStandInExecutorApi(request)
  const target = { projectId: 'project', projectStore: 'cloud' as const, groupId: 'group' }
  await api.projectProcessing(7, 'selected-device', target)
  expect(request).toHaveBeenLastCalledWith(
    'runtime.project_coordinator.processing.get',
    { userId: 7, ...target },
    'selected-device'
  )
  await api.projectProcessing(7, 'selected-device', target, true)
  expect(request).toHaveBeenLastCalledWith(
    'runtime.project_coordinator.processing.check',
    { userId: 7, ...target },
    'selected-device'
  )
})

function fixture() {
  const transport = {
    notifyAssignment: vi.fn<StandInExecutorApi['notifyAssignment']>(),
    personalGet: vi.fn<StandInExecutorApi['personalGet']>(),
    personalSave: vi.fn<StandInExecutorApi['personalSave']>(),
    readTask: vi.fn<StandInExecutorApi['readTask']>(),
    catalog: vi.fn<StandInExecutorApi['catalog']>().mockResolvedValue({ models: [] }),
    run: vi.fn<StandInExecutorApi['run']>().mockResolvedValue({ deviceId: 'mac', taskId: 'task' }),
    list: vi.fn<StandInExecutorApi['list']>().mockResolvedValue([]),
    get: vi
      .fn<StandInExecutorApi['get']>()
      .mockImplementation(async (_project, _user, _store, deviceId) => ({
        ...settings,
        executionDeviceId: deviceId,
      })),
    save: vi.fn<StandInExecutorApi['save']>().mockResolvedValue(settings),
  }
  const api = bindProjectStandInApi(transport, 7, 'cloud', async () => ({ deviceId: 'mac' }))
  return { api, transport }
}

describe('device-local Stand-in settings', () => {
  it('never contacts an offline old device when saving another device', async () => {
    const { api, transport } = fixture()
    transport.get.mockRejectedValue(new Error('old device offline'))
    await api.save('project', { ...settings, enabled: true, executionDeviceId: 'mac' })
    expect(transport.get).not.toHaveBeenCalled()
    expect(transport.save).toHaveBeenCalledOnce()
  })

  it('addresses RPCs to the selected Executor', async () => {
    const request = vi.fn().mockResolvedValue({})
    const api = createStandInExecutorApi(request)
    await api.get('project', 7, 'cloud', 'cloud-device')
    expect(request).toHaveBeenLastCalledWith(
      'runtime.stand_in.get',
      { projectId: 'project', userId: 7, projectStore: 'cloud', standInId: 'default' },
      'cloud-device'
    )
    await api.save('project', 7, 'cloud', settings, 'cloud-device')
    expect(request).toHaveBeenLastCalledWith(
      'runtime.stand_in.save',
      expect.objectContaining({ projectStore: 'cloud' }),
      'cloud-device'
    )
    await api.notifyAssignment('project', 'issue', 'assignment', 7, 'mac')
    expect(request).toHaveBeenLastCalledWith(
      'runtime.stand_in.assignment',
      { projectId: 'project', itemId: 'issue', assignmentId: 'assignment', recipientUserId: 7 },
      'mac'
    )
  })
})

it('preserves Executor responses and uses explicit project save targets', async () => {
  const { api, transport } = fixture()
  transport.get.mockResolvedValue(settings)
  expect(await api.get('project', 'selected-device')).toBe(settings)
  await api.save('project', { ...settings, executionDeviceId: 'old-device' }, 'selected-device')
  expect(transport.save).toHaveBeenCalledWith(
    'project',
    7,
    'cloud',
    { ...settings, executionDeviceId: 'old-device' },
    'selected-device'
  )
})

it('reads list items from the object envelope required by remote Runtime RPC', async () => {
  const request = vi.fn().mockResolvedValue({ items: [{ ...settings, id: 'default' }] })
  const transport = createStandInExecutorApi(request)
  await expect(transport.list(7, 'mac', true)).resolves.toEqual([{ ...settings, id: 'default' }])
  expect(request).toHaveBeenCalledWith(
    'runtime.stand_in.list',
    { userId: 7, includeDisabled: true },
    'mac'
  )
})

it('routes telemetry policy, replay and ACK to the explicitly selected Executor', async () => {
  const request = vi.fn().mockResolvedValue({ items: [] })
  const api = createStandInExecutorApi(request)
  await api.configureTelemetry(7, 'remote', true, 1234)
  expect(request).toHaveBeenLastCalledWith(
    'runtime.stand_in.telemetry.configure',
    { userId: 7, enabled: true, enabledSince: 1234 },
    'remote'
  )
  await api.telemetryFacts(7, 'remote')
  expect(request).toHaveBeenLastCalledWith(
    'runtime.stand_in.telemetry.list',
    { userId: 7 },
    'remote'
  )
  await api.acknowledgeTelemetry(7, 'remote', ['event-id'])
  expect(request).toHaveBeenLastCalledWith(
    'runtime.stand_in.telemetry.ack',
    { userId: 7, ids: ['event-id'] },
    'remote'
  )
})

afterEach(() => vi.restoreAllMocks())

describe('stand-in RPC failures', () => {
  it('keeps error identity and cause while localizing the message for shared project UI', async () => {
    const error = {
      code: 'assignment_already_handled',
      message: 'This assignment has already been handled or is no longer active',
    }
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const api = createStandInExecutorApi(vi.fn().mockRejectedValue(error))
    await expect(api.run('project', 'issue', 7, 'cloud', 'mac', 'review')).rejects.toMatchObject({
      code: error.code,
      cause: error,
      message: i18n.t('common:standIn.errors.assignment_already_handled'),
    })
    expect(log).toHaveBeenCalledWith(
      '[Stand-in] Executor request failed',
      expect.objectContaining({
        method: 'runtime.stand_in.run',
        deviceId: 'mac',
        projectId: 'project',
        issueId: 'issue',
        userId: 7,
        roleId: 'review',
        code: error.code,
      })
    )
  })

  it('excludes conversation content from request diagnostics', async () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const api = createStandInExecutorApi(vi.fn().mockRejectedValue({ code: 'cloud_unavailable' }))
    await expect(api.conversation(7, 'mac', 'private conversation')).rejects.toBeInstanceOf(Error)
    expect(JSON.stringify(log.mock.calls)).not.toContain('private conversation')
  })
})

it('preserves connection authorization metadata and retry policy', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const error = {
    code: 'connector_auth_required',
    message: 'Authorize the account',
    retryable: true,
    details: { pluginKey: 'example-plugin', connectorSlug: 'work-account' },
  }
  const api = createStandInExecutorApi(vi.fn().mockRejectedValue(error))
  await expect(api.connectionProviders('mac')).rejects.toMatchObject({
    code: error.code,
    retryable: true,
    details: error.details,
    cause: error,
    message: i18n.t('common:standIn.errors.connector_auth_required'),
  })
  expect(error.message).toBe('Authorize the account')
})

it('routes declared default-market dependencies through the platform installer instead of Codex plugin/list', async () => {
  const dependency = {
    alias: 'dingtalk',
    status: 'missing',
    version: '*',
    source: { marketplaceId: 'wework', pluginId: 'dingtalk@wework' },
  }
  const request = vi.fn().mockResolvedValue({
    items: [{ id: 'connection/dingtalk', dependencies: [dependency] }],
  })
  const listMarketplacePlugins = vi.fn(async () => ({
    items: [
      {
        id: 42,
        name: 'dingtalk',
        sourceProvider: 'wegent',
        visibility: 'public',
        installed: false,
        enabled: false,
      },
    ],
  }))
  const installMarketplacePlugin = vi.fn(async () => {
    dependency.status = 'ready'
    return {}
  })
  const api = createStandInExecutorApi(
    request as never,
    { listMarketplacePlugins, installMarketplacePlugin } as never
  )
  await api.installConnectionDependencies('selected-device', 'connection/dingtalk', ['dingtalk'])
  expect(installMarketplacePlugin).toHaveBeenCalledWith(42, 'selected-device')
  expect(request.mock.calls.every(call => call[0] === 'runtime.connections.catalog')).toBe(true)
})
