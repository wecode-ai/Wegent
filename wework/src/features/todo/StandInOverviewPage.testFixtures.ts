import {
  newStandInRole,
  type PersonalStandInSettings,
  type StandInRole,
} from '@/api/personalStandIn'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { CollaborationProject, SharedWorkspaceApi } from '@wegent/collaboration'
import { vi } from 'vitest'

export function standInOverviewFixture(
  roles: StandInRole[] = [newStandInRole('device', 'default')]
) {
  let settings: PersonalStandInSettings = {
    userId: 7,
    executionDeviceId: 'device',
    version: 0,
    roles,
  }
  const personalAgents = vi.fn(async () => [])
  const personalSave = vi.fn(async (_user, value: PersonalStandInSettings) => {
    settings = value
    return settings
  })
  const props = {
    userId: 7,
    api: {} as SharedWorkspaceApi,
    devices: [],
    projects: [
      { id: '12', name: 'Example project', project_store: 'backend' },
    ] as CollaborationProject[],
    services: {
      getLocalRuntimeSidebarIdentity: async () => ({ deviceId: 'device' }),
      modelApi: { listModels: async () => ({ data: [] }) },
      standInApi: {
        onboarding: vi.fn(async () => ({ state: { version: 1, completed: true } })),
        connectionProviders: vi.fn(async () => ({ items: [] })),
        catalog: async () => ({ models: [] }),
        personalGet: vi.fn(async () => settings),
        memories: vi.fn(async () => []),
        inbox: vi.fn(async () => ({ items: [], sourceErrors: [] })),
        proposal: vi.fn(async () => null),
        processingStatus: vi.fn(async () => ({ pendingCount: 0, running: false, actions: [] })),
        personalSave,
        personalAgents,
      },
    } as unknown as WorkbenchServices,
  }
  return { props, personalAgents, personalSave }
}
