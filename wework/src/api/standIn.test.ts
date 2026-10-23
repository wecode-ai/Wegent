import { describe, expect, it, vi } from 'vitest'
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
    get: vi.fn<StandInExecutorApi['get']>().mockResolvedValue(settings),
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
    await api.save('project', { ...current, enabled: true })
    expect(transport.save).toHaveBeenCalledExactlyOnceWith('project', 7, 'cloud', {
      ...settings,
      enabled: true,
      executionDeviceId: 'cloud-device',
    })
  })

  it('never contacts an offline old device when saving another device', async () => {
    const { api, transport } = fixture()
    transport.get.mockRejectedValue(new Error('old device offline'))
    await api.save('project', { ...settings, enabled: true, executionDeviceId: 'mac' })
    expect(transport.get).not.toHaveBeenCalled()
    expect(transport.save).toHaveBeenCalledOnce()
  })

  it('keeps local projects on the current device', async () => {
    const { transport } = fixture()
    const api = bindProjectStandInApi(transport, 7, 'local', async () => ({ deviceId: 'mac' }))
    await expect(api.get('project', 'cloud-device')).rejects.toThrow('Local projects')
    await expect(
      api.save('project', { ...settings, executionDeviceId: 'cloud-device' })
    ).rejects.toThrow('Local projects')
    expect(transport.save).not.toHaveBeenCalled()
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
    await api.save('project', 7, 'cloud', { ...settings, executionDeviceId: 'cloud-device' })
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
      expect.objectContaining({ id: 'review', tags: ['review'] })
    )
  })
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
