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

vi.mock('./StandInComposer', () => ({ StandInComposer: () => null }))
vi.mock('./StandInRequirements', () => ({ StandInRequirements: () => null }))
afterEach(cleanup)

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

test('loads and saves a new role on the sole cloud Executor without touching the local profile', async () => {
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
  const cloud = { isConnected: true } as CloudConnectionContextValue
  render(
    <CloudConnectionContext.Provider value={cloud}>
      <StandInSettingsPage
        api={{} as SharedWorkspaceApi}
        services={services}
        userId={7}
        projects={[]}
        initialCreate
        initialDeviceId="mac"
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
