import { newStandInRole, type PersonalStandInSettings } from '@/api/personalStandIn'
import type { StandInExecutorApi } from '@/api/standIn'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { vi } from 'vitest'

export function personalStandInFixture() {
  const settings: PersonalStandInSettings = {
    userId: 7,
    executionDeviceId: 'old-device',
    version: 1,
    roles: [newStandInRole('old-device', 'default')],
  }
  const personalGet = vi.fn(async () => settings)
  const personalSave = vi.fn<StandInExecutorApi['personalSave']>(async (_user, value) => value)
  const services = {
    getLocalRuntimeSidebarIdentity: vi.fn(async () => ({ deviceId: 'mac' })),
    standInApi: { personalGet, personalSave },
  } as unknown as WorkbenchServices
  return { settings, personalGet, personalSave, services }
}

export function standInProfile(
  device: string,
  roles: PersonalStandInSettings['roles']
): PersonalStandInSettings {
  return { userId: 7, executionDeviceId: device, version: 1, roles }
}
