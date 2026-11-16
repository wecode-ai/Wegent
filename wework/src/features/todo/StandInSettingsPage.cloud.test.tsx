import '@/i18n'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { SharedWorkspaceApi } from '@wegent/collaboration'
import type { DeviceInfo } from '@/types/api'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import {
  CloudConnectionContext,
  type CloudConnectionContextValue,
} from '@/features/cloud-connection/CloudConnectionContext'
import { StandInSettingsPage } from './StandInSettingsPage'
import { newStandInRole } from '@/api/personalStandIn'

vi.mock('./StandInComposer', () => ({ StandInComposer: () => null }))
vi.mock('./StandInRequirements', () => ({ StandInRequirements: () => null }))
afterEach(cleanup)

test('keeps a new local role and its draft when the cloud device inventory changes', async () => {
  const personalGet = vi.fn(async () => ({
    userId: 7,
    executionDeviceId: 'mac',
    version: 0,
    roles: [],
  }))
  const personalSave = vi.fn(async (_user, settings) => settings)
  const services = {
    getLocalRuntimeSidebarIdentity: async () => ({ deviceId: 'mac' }),
    standInApi: { personalGet, personalSave },
  } as unknown as WorkbenchServices
  const form = (devices: DeviceInfo[]) => (
    <CloudConnectionContext.Provider value={{ isConnected: true } as CloudConnectionContextValue}>
      <StandInSettingsPage
        api={{} as SharedWorkspaceApi}
        services={services}
        userId={7}
        projects={[]}
        initialCreate
        devices={devices}
      />
    </CloudConnectionContext.Provider>
  )
  const device = {
    id: 1,
    device_id: 'cloud-one',
    name: 'Cloud',
    device_type: 'cloud',
    status: 'online',
    is_default: true,
  } as DeviceInfo
  const view = render(form([device]))
  fireEvent.change(await screen.findByTestId('stand-in-role-name'), {
    target: { value: 'Unsaved local role' },
  })
  view.rerender(
    form([
      { ...device, status: 'offline' },
      { ...device, id: 2, device_id: 'two' },
    ])
  )
  expect(screen.getByTestId('stand-in-role-name')).toHaveValue('Unsaved local role')
  expect(screen.getByTestId('stand-in-role-device')).toHaveValue('mac')
  expect(personalGet).toHaveBeenCalledExactlyOnceWith(7, 'mac')
  fireEvent.click(screen.getByTestId('stand-in-save'))
  await waitFor(() => expect(personalSave).toHaveBeenCalledOnce())
  expect(personalSave).toHaveBeenCalledWith(
    7,
    expect.objectContaining({
      roles: [expect.objectContaining({ name: 'Unsaved local role', executionDeviceId: 'mac' })],
    }),
    'mac'
  )
})

test('edits a signed-out local role after cloud connection without querying cloud agents for user zero', async () => {
  const role = { ...newStandInRole('mac', 'local-role'), name: 'Local role' }
  const personalGet = vi.fn(async () => ({
    userId: 0,
    executionDeviceId: 'mac',
    version: 1,
    roles: [role],
  }))
  const personalSave = vi.fn(async (_user, settings) => settings)
  const personalAgents = vi.fn()
  const services = {
    getLocalRuntimeSidebarIdentity: async () => ({ deviceId: 'mac' }),
    standInApi: { personalGet, personalSave, personalAgents },
  } as unknown as WorkbenchServices
  render(
    <CloudConnectionContext.Provider
      value={{ isConnected: true, user: { id: 7 } } as CloudConnectionContextValue}
    >
      <StandInSettingsPage
        api={{} as SharedWorkspaceApi}
        services={services}
        userId={0}
        projects={[]}
        devices={[]}
        initialDeviceId="mac"
        initialProfileId="local-role"
      />
    </CloudConnectionContext.Provider>
  )
  expect(await screen.findByTestId('stand-in-role-name')).toHaveValue('Local role')
  fireEvent.change(screen.getByTestId('stand-in-role-name'), {
    target: { value: 'Updated local role' },
  })
  fireEvent.click(screen.getByTestId('stand-in-save'))
  await waitFor(() => expect(personalSave).toHaveBeenCalled())
  expect(personalSave.mock.calls[0][0]).toBe(0)
  expect(personalSave.mock.calls[0][2]).toBe('mac')
  expect(personalAgents).not.toHaveBeenCalled()
  expect(personalGet).toHaveBeenCalledWith(0, 'mac')
})

test('retries a failed cloud profile load on the same device without a local fallback', async () => {
  const personalGet = vi
    .fn()
    .mockRejectedValueOnce(new Error('Executor is offline'))
    .mockResolvedValue({ userId: 7, executionDeviceId: 'cloud-one', version: 0, roles: [] })
  const personalSave = vi.fn()
  const services = {
    getLocalRuntimeSidebarIdentity: async () => ({ deviceId: 'mac' }),
    standInApi: { personalGet, personalSave, personalAgents: vi.fn(async () => []) },
  } as unknown as WorkbenchServices
  render(
    <CloudConnectionContext.Provider value={{ isConnected: true } as CloudConnectionContextValue}>
      <StandInSettingsPage
        api={{} as SharedWorkspaceApi}
        services={services}
        userId={7}
        projects={[]}
        initialCreate
        initialDeviceId="cloud-one"
        devices={[
          {
            id: 1,
            device_id: 'cloud-one',
            name: 'Cloud',
            device_type: 'cloud',
            status: 'online',
          } as DeviceInfo,
        ]}
      />
    </CloudConnectionContext.Provider>
  )
  fireEvent.click(await screen.findByTestId('stand-in-reload'))
  await screen.findByTestId('stand-in-role-name')
  expect(personalGet.mock.calls).toEqual([
    [7, 'cloud-one'],
    [7, 'cloud-one'],
  ])
  expect(personalSave).not.toHaveBeenCalled()
})

test('loads and saves a new role on the explicitly selected cloud Executor without touching the local profile', async () => {
  const personalGet = vi.fn(async (_user, deviceId) => ({
    userId: 7,
    executionDeviceId: deviceId,
    version: 0,
    roles: [],
  }))
  const personalSave = vi.fn(async (_user, settings) => settings)
  const services = {
    getLocalRuntimeSidebarIdentity: async () => ({ deviceId: 'mac' }),
    standInApi: { personalGet, personalSave, personalAgents: vi.fn(async () => []) },
  } as unknown as WorkbenchServices
  const cloud = { isConnected: true, user: { id: 7 } } as CloudConnectionContextValue
  render(
    <CloudConnectionContext.Provider value={cloud}>
      <StandInSettingsPage
        api={{} as SharedWorkspaceApi}
        services={services}
        userId={7}
        projects={[]}
        initialCreate
        initialDeviceId="cloud-one"
        devices={[
          {
            id: 1,
            device_id: 'cloud-one',
            name: 'Cloud',
            device_type: 'cloud',
            status: 'online',
          } as DeviceInfo,
        ]}
      />
    </CloudConnectionContext.Provider>
  )
  fireEvent.change(await screen.findByTestId('stand-in-role-name'), {
    target: { value: 'Cloud reviewer' },
  })
  fireEvent.click(screen.getByTestId('stand-in-save'))
  await waitFor(() => expect(personalSave).toHaveBeenCalledOnce())
  expect(personalGet).toHaveBeenCalledWith(7, 'cloud-one')
  expect(personalGet).not.toHaveBeenCalledWith(7, 'mac')
  expect(personalSave).toHaveBeenCalledWith(
    7,
    expect.objectContaining({
      executionDeviceId: 'cloud-one',
      roles: [expect.objectContaining({ name: 'Cloud reviewer', executionDeviceId: 'cloud-one' })],
    }),
    'cloud-one'
  )
})

test('keeps the cloud device and unsaved draft when the cloud connection drops', async () => {
  const personalGet = vi.fn(async (_user, deviceId) => ({
    userId: 7,
    executionDeviceId: deviceId,
    version: 0,
    roles: [],
  }))
  const services = {
    getLocalRuntimeSidebarIdentity: async () => ({ deviceId: 'mac' }),
    standInApi: { personalGet, personalSave: vi.fn(), personalAgents: vi.fn(async () => []) },
  } as unknown as WorkbenchServices
  const form = (
    <StandInSettingsPage
      api={{} as SharedWorkspaceApi}
      services={services}
      userId={7}
      projects={[]}
      initialCreate
      initialDeviceId="cloud-one"
      devices={[
        {
          id: 1,
          device_id: 'cloud-one',
          name: 'Cloud',
          device_type: 'cloud',
          status: 'online',
        } as DeviceInfo,
      ]}
    />
  )
  const view = render(
    <CloudConnectionContext.Provider value={{ isConnected: true } as CloudConnectionContextValue}>
      {form}
    </CloudConnectionContext.Provider>
  )
  fireEvent.change(await screen.findByTestId('stand-in-role-name'), {
    target: { value: 'Unsaved cloud draft' },
  })
  view.rerender(
    <CloudConnectionContext.Provider value={{ isConnected: false } as CloudConnectionContextValue}>
      {form}
    </CloudConnectionContext.Provider>
  )
  await waitFor(() =>
    expect(screen.getByTestId('stand-in-role-name')).toHaveValue('Unsaved cloud draft')
  )
  expect(personalGet).not.toHaveBeenCalledWith(7, 'mac')
})
