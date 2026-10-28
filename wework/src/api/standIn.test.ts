import { afterEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { bindProjectStandInApi, createStandInExecutorApi, type StandInExecutorApi } from './standIn'

const settings = { enabled: false, prompt: '', executionDeviceId: '', version: 0 }
function fixture() {
  const transport = {
    notifyAssignment: vi.fn<StandInExecutorApi['notifyAssignment']>(),
    personalAgents: vi.fn<StandInExecutorApi['personalAgents']>(),
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
  it('defaults to the current Executor without device discovery or a shared binding', async () => {
    const { api, transport } = fixture()
    expect(await api.get('project')).toMatchObject({ executionDeviceId: 'mac' })
    expect(transport.get).toHaveBeenCalledWith('project', 7, 'cloud', 'mac', 'default')
    expect(transport.save).not.toHaveBeenCalled()
  })

  it('reads cloud device settings independently and saves only to that Executor', async () => {
    const { api, transport } = fixture()
    const current = await api.get('project', 'cloud-device')
    expect(transport.get).toHaveBeenCalledWith('project', 7, 'cloud', 'cloud-device', 'default')
    await api.save('project', { ...current, enabled: true }, 'cloud-device')
    expect(transport.save).toHaveBeenCalledExactlyOnceWith(
      'project',
      7,
      'cloud',
      {
        ...settings,
        enabled: true,
        executionDeviceId: 'cloud-device',
      },
      'cloud-device'
    )
  })

  it('never contacts an offline old device when saving another device', async () => {
    const { api, transport } = fixture()
    transport.get.mockRejectedValue(new Error('old device offline'))
    await api.save('project', { ...settings, enabled: true, executionDeviceId: 'mac' })
    expect(transport.get).not.toHaveBeenCalled()
    expect(transport.save).toHaveBeenCalledOnce()
  })

  it('lets the selected Executor validate local project access', async () => {
    const { transport } = fixture()
    const api = bindProjectStandInApi(transport, 7, 'local', async () => ({ deviceId: 'mac' }))
    transport.get.mockRejectedValue(new Error('Project not found'))
    transport.save.mockRejectedValue(new Error('Project not found'))
    await expect(api.get('project', 'cloud-device')).rejects.toThrow('Project not found')
    await expect(api.save('project', settings, 'cloud-device')).rejects.toThrow('Project not found')
    expect(transport.get).toHaveBeenCalledWith('project', 7, 'local', 'cloud-device', 'default')
    expect(transport.save).toHaveBeenCalledWith('project', 7, 'local', settings, 'cloud-device')
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

  it('addresses an independent named Stand-in in the same project', async () => {
    const { api, transport } = fixture()
    await api.get('project', 'mac', 'review')
    expect(transport.get).toHaveBeenCalledWith('project', 7, 'cloud', 'mac', 'review')
    await api.save('project', {
      ...settings,
      id: 'review',
      tags: ['review'],
      executionDeviceId: 'mac',
    })
    expect(transport.save).toHaveBeenCalledWith(
      'project',
      7,
      'cloud',
      expect.objectContaining({ id: 'review', tags: ['review'] }),
      'mac'
    )
  })
})

it('routes personal saves to the selected Executor independently of stored device fields', async () => {
  const saved = {
    userId: 7,
    executionDeviceId: 'current-device',
    version: 1,
    roles: [],
  }
  const request = vi.fn().mockResolvedValue(saved)
  const api = createStandInExecutorApi(request)
  const stale = { ...saved, executionDeviceId: 'old-device' }
  await expect(api.personalSave(7, stale, 'current-device')).resolves.toBe(saved)
  expect(request).toHaveBeenCalledExactlyOnceWith(
    'runtime.stand_in.personal.save',
    { userId: 7, settings: stale },
    'current-device'
  )
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

it('explicitly runs a saved disabled stand-in through its selected device', async () => {
  const request = vi.fn().mockResolvedValue({ deviceId: 'cloud-device', taskId: 'stand-in-human' })
  const transport = createStandInExecutorApi(request)
  const api = bindProjectStandInApi(transport, 7, 'cloud', async () => ({ deviceId: 'mac' }))
  await expect(api.run!('project', 'issue', 'cloud-device', 'default')).resolves.toEqual({
    deviceId: 'cloud-device',
    taskId: 'stand-in-human',
  })
  expect(request).toHaveBeenCalledExactlyOnceWith(
    'runtime.stand_in.run',
    {
      projectId: 'project',
      issueId: 'issue',
      userId: 7,
      projectStore: 'cloud',
      standInId: 'default',
    },
    'cloud-device'
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
