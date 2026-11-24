import i18n from '@/i18n'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import type { RuntimeProfile } from '@/api/runtimeProfiles'
import { RuntimeSettingsPage } from './RuntimeSettingsPage'

function profile(id = 'one'): RuntimeProfile {
  return {
    id,
    name: `Runtime ${id}`,
    executionEnvironment: 'local',
    executionDeviceId: 'device',
    model: 'model',
    modelType: 'runtime',
    modelOptions: {},
    workspacePolicy: 'project',
    status: 'active',
    version: 1,
    createdAt: '',
    updatedAt: '',
  }
}
function source() {
  return {
    runtimeProfileApi: {
      list: vi.fn().mockResolvedValue([profile()]),
      create: vi.fn().mockResolvedValue(profile()),
      delete: vi.fn().mockResolvedValue(undefined),
      getProjectDefault: vi.fn().mockResolvedValue({ runtimeProfileId: 'one' }),
      setProjectDefault: vi.fn().mockResolvedValue({ runtimeProfileId: 'one' }),
    },
    deliveryApi: {
      listCloudProjects: vi
        .fn()
        .mockResolvedValue({ items: [{ id: 'p', name: 'Project', task_provider: 'local' }] }),
    },
    deviceApi: {
      listDevices: vi
        .fn()
        .mockResolvedValue([{ device_id: 'device', name: 'Device', device_type: 'local' }]),
    },
    modelApi: {
      listModels: vi.fn().mockResolvedValue({ data: [{ name: 'model', type: 'runtime' }] }),
    },
  }
}
function page(api: ReturnType<typeof source>) {
  return <RuntimeSettingsPage {...(api as unknown as Parameters<typeof RuntimeSettingsPage>[0])} />
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}
async function openCreate() {
  await screen.findByTestId('runtime-profile-one')
  fireEvent.click(screen.getByTestId('runtime-profile-create'))
  fireEvent.change(screen.getByTestId('runtime-profile-name'), { target: { value: 'Draft' } })
  await waitFor(() => expect(screen.getByTestId('runtime-profile-save')).toBeEnabled())
}

test('does not report an empty catalog while loading', async () => {
  const api = source()
  const pending = deferred<RuntimeProfile[]>()
  api.runtimeProfileApi.list.mockReturnValueOnce(pending.promise)
  render(page(api))
  expect(screen.queryByText('还没有 Runtime。')).not.toBeInTheDocument()
  expect(screen.getByRole('status')).toBeInTheDocument()
  await act(async () => pending.resolve([]))
  expect(await screen.findByText('还没有 Runtime。')).toBeInTheDocument()
})

test('shows read errors without claiming an empty catalog and recovers on retry', async () => {
  const api = source()
  api.runtimeProfileApi.list.mockRejectedValueOnce(new Error('Read unavailable'))
  render(page(api))
  expect(await screen.findByText('Read unavailable')).toBeInTheDocument()
  expect(screen.queryByText('还没有 Runtime。')).not.toBeInTheDocument()
  fireEvent.click(screen.getByTestId('runtime-settings-retry'))
  expect(await screen.findByTestId('runtime-profile-one')).toBeInTheDocument()
  expect(screen.queryByTestId('runtime-settings-retry')).not.toBeInTheDocument()
  expect(api.runtimeProfileApi.list).toHaveBeenCalledTimes(2)
})

test('does not fetch dependent defaults or publish data from a detached source', async () => {
  const old = source(),
    current = source()
  const pending = deferred<RuntimeProfile[]>()
  old.runtimeProfileApi.list.mockReturnValue(pending.promise)
  const projects = deferred<{ items: Array<{ id: string; name: string; task_provider: string }> }>()
  old.deliveryApi.listCloudProjects.mockReturnValue(projects.promise)
  const { rerender } = render(page(old))
  await waitFor(() => expect(old.runtimeProfileApi.list).toHaveBeenCalledTimes(1))
  current.runtimeProfileApi.list.mockResolvedValue([profile('current')])
  rerender(page(current))
  await screen.findByTestId('runtime-profile-current')
  await act(async () => {
    pending.resolve([profile('old')])
    projects.resolve({ items: [{ id: 'old', name: 'Old', task_provider: 'local' }] })
  })
  expect(screen.queryByTestId('runtime-profile-old')).not.toBeInTheDocument()
  expect(old.runtimeProfileApi.getProjectDefault).not.toHaveBeenCalled()
})

test('retains drafts across ordinary renders and language changes without another read', async () => {
  const api = source()
  const { rerender } = render(page(api))
  await openCreate()
  rerender(page(api))
  const previousLanguage = i18n.language
  try {
    await act(async () => {
      await i18n.changeLanguage(previousLanguage.startsWith('en') ? 'zh-CN' : 'en')
    })
    expect(screen.getByTestId('runtime-profile-name')).toHaveValue('Draft')
    expect(api.runtimeProfileApi.list).toHaveBeenCalledTimes(1)
    expect(api.runtimeProfileApi.getProjectDefault).toHaveBeenCalledTimes(1)
  } finally {
    await act(async () => {
      await i18n.changeLanguage(previousLanguage)
    })
  }
})

test('an accepted create finishes on its original source without closing a new source draft', async () => {
  const old = source(),
    current = source()
  const pending = deferred<RuntimeProfile>()
  old.runtimeProfileApi.create.mockReturnValue(pending.promise)
  const { rerender } = render(page(old))
  await openCreate()
  fireEvent.click(screen.getByTestId('runtime-profile-save'))
  expect(old.runtimeProfileApi.create).toHaveBeenCalledTimes(1)
  rerender(page(current))
  expect(screen.queryByTestId('runtime-profile-create-dialog')).not.toBeInTheDocument()
  await openCreate()
  await act(async () => pending.resolve(profile('created')))
  expect(screen.getByTestId('runtime-profile-name')).toHaveValue('Draft')
  expect(old.runtimeProfileApi.list).toHaveBeenCalledTimes(1)
  expect(current.runtimeProfileApi.create).not.toHaveBeenCalled()
})

test('keeps successful create separate from a subsequent refresh failure', async () => {
  const api = source()
  api.runtimeProfileApi.list
    .mockResolvedValueOnce([profile()])
    .mockRejectedValueOnce(new Error('Refresh failed'))
  render(page(api))
  await openCreate()
  fireEvent.click(screen.getByTestId('runtime-profile-save'))
  expect(await screen.findByText('Refresh failed')).toBeInTheDocument()
  expect(screen.queryByTestId('runtime-profile-create-dialog')).not.toBeInTheDocument()
  expect(api.runtimeProfileApi.create).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByTestId('runtime-settings-retry'))
  await waitFor(() => expect(screen.queryByText('Refresh failed')).not.toBeInTheDocument())
  expect(api.runtimeProfileApi.create).toHaveBeenCalledTimes(1)
})

test('uses the authoritative project default receipt without reloading other catalogs', async () => {
  const api = source()
  api.runtimeProfileApi.list.mockResolvedValue([profile(), profile('two')])
  api.runtimeProfileApi.getProjectDefault.mockResolvedValue({ runtimeProfileId: 'two' })
  api.runtimeProfileApi.setProjectDefault.mockResolvedValue({ runtimeProfileId: 'two' })
  render(page(api))
  await screen.findByTestId('runtime-profile-one')
  fireEvent.click(screen.getByTestId('runtime-project-default-p'))
  fireEvent.click(await screen.findByTestId('runtime-project-default-p-option-one'))
  await waitFor(() =>
    expect(api.runtimeProfileApi.setProjectDefault).toHaveBeenCalledWith('p', 'one')
  )
  await waitFor(() =>
    expect(screen.getByTestId('runtime-project-default-p')).toHaveTextContent('Runtime two')
  )
  expect(api.runtimeProfileApi.list).toHaveBeenCalledTimes(1)
  expect(api.deviceApi.listDevices).toHaveBeenCalledTimes(1)
})

test('does not request auxiliary catalogs when Runtime profiles are unavailable', () => {
  const api = source()
  render(
    <RuntimeSettingsPage
      {...(api as unknown as Parameters<typeof RuntimeSettingsPage>[0])}
      runtimeProfileApi={undefined}
    />
  )
  expect(api.runtimeProfileApi.list).not.toHaveBeenCalled()
  expect(api.deliveryApi.listCloudProjects).not.toHaveBeenCalled()
  expect(api.deviceApi.listDevices).not.toHaveBeenCalled()
  expect(api.modelApi.listModels).not.toHaveBeenCalled()
})

test('loads models only in the create dialog and keeps the Runtime list usable during model failure', async () => {
  const api = source()
  const pending = deferred<{ data: Array<{ name: string; type: string }> }>()
  api.modelApi.listModels.mockReturnValueOnce(pending.promise)
  render(page(api))
  await screen.findByTestId('runtime-profile-one')
  expect(api.modelApi.listModels).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('runtime-profile-create'))
  fireEvent.change(screen.getByTestId('runtime-profile-name'), { target: { value: 'Draft' } })
  await waitFor(() => expect(api.modelApi.listModels).toHaveBeenCalledTimes(1))
  expect(screen.getByTestId('runtime-profile-name')).toBeEnabled()
  expect(screen.getByTestId('runtime-profile-save')).toBeDisabled()
  await act(async () => pending.resolve({ data: [{ name: 'model', type: 'runtime' }] }))
  expect(screen.getByTestId('runtime-profile-save')).toBeEnabled()
  expect(api.runtimeProfileApi.list).toHaveBeenCalledTimes(1)
})

test('recovers a failed model catalog without rereading profiles or discarding the create draft', async () => {
  const api = source()
  api.modelApi.listModels.mockRejectedValueOnce(new Error('Model catalog unavailable'))
  render(page(api))
  await screen.findByTestId('runtime-profile-one')
  fireEvent.click(screen.getByTestId('runtime-profile-create'))
  fireEvent.change(screen.getByTestId('runtime-profile-name'), { target: { value: 'Draft' } })
  expect(await screen.findByText('Model catalog unavailable')).toBeInTheDocument()
  expect(screen.getByTestId('runtime-profile-model')).toBeInTheDocument()
  expect(screen.getByTestId('runtime-profile-one')).toBeInTheDocument()
  fireEvent.click(screen.getByTestId('runtime-settings-models-retry'))
  await waitFor(() => expect(screen.getByTestId('runtime-profile-save')).toBeEnabled())
  expect(screen.getByTestId('runtime-profile-name')).toHaveValue('Draft')
  expect(api.runtimeProfileApi.list).toHaveBeenCalledTimes(1)
  expect(api.modelApi.listModels).toHaveBeenCalledTimes(2)
})

test('isolates project-default failures from profiles and retries only project data', async () => {
  const api = source()
  api.runtimeProfileApi.getProjectDefault.mockRejectedValueOnce(new Error('Defaults unavailable'))
  render(page(api))
  expect(await screen.findByTestId('runtime-profile-one')).toBeInTheDocument()
  expect(await screen.findByText('Defaults unavailable')).toBeInTheDocument()
  fireEvent.click(screen.getByTestId('runtime-settings-projects-retry'))
  expect(await screen.findByTestId('runtime-project-default-p')).toHaveTextContent('Runtime one')
  expect(api.runtimeProfileApi.list).toHaveBeenCalledTimes(1)
  expect(api.deviceApi.listDevices).toHaveBeenCalledTimes(1)
  expect(api.runtimeProfileApi.getProjectDefault).toHaveBeenCalledTimes(2)
})

test('lets devices load independently and initializes an untouched device selection when ready', async () => {
  const api = source()
  const pending = deferred<Array<{ device_id: string; device_type: string; name: string }>>()
  api.deviceApi.listDevices.mockReturnValue(pending.promise)
  render(page(api))
  await screen.findByTestId('runtime-profile-one')
  fireEvent.click(screen.getByTestId('runtime-profile-create'))
  fireEvent.change(screen.getByTestId('runtime-profile-name'), { target: { value: 'Draft' } })
  await waitFor(() => expect(api.modelApi.listModels).toHaveBeenCalledTimes(1))
  expect(screen.getByTestId('runtime-profile-save')).toBeDisabled()
  await act(async () =>
    pending.resolve([{ device_id: 'device', device_type: 'local', name: 'Device' }])
  )
  await waitFor(() => expect(screen.getByTestId('runtime-profile-save')).toBeEnabled())
  expect(screen.getByTestId('runtime-profile-device')).toHaveTextContent('Device')
  expect(api.runtimeProfileApi.list).toHaveBeenCalledTimes(1)
})

test('initializes a cloud device with an eligible model after the lazy catalog loads', async () => {
  const api = source()
  api.deviceApi.listDevices.mockResolvedValue([
    { device_id: 'cloud', device_type: 'cloud', name: 'Cloud' },
  ])
  api.modelApi.listModels.mockResolvedValue({
    data: [
      { name: 'local-runtime', type: 'runtime' },
      { name: 'cloud-model', type: 'public' },
    ],
  })
  render(page(api))
  await openCreate()
  expect(screen.getByTestId('runtime-profile-model')).toHaveTextContent('cloud-model')
  fireEvent.click(screen.getByTestId('runtime-profile-save'))
  await waitFor(() =>
    expect(api.runtimeProfileApi.create).toHaveBeenCalledWith({
      name: 'Draft',
      executionEnvironment: 'cloud',
      executionDeviceId: 'cloud',
      model: 'cloud-model',
    })
  )
})
