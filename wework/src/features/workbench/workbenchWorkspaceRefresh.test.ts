import { expect, test } from 'vitest'
import { initialWorkbenchState, workbenchReducer } from './workbenchReducer'

test.each(['lists_refreshed', 'devices_refreshed'] as const)(
  'keeps an opened workspace owner when an earlier %s finishes',
  type => {
    const opened = workbenchReducer(initialWorkbenchState, {
      type: 'runtime_workspace_opened',
      deviceId: 'cloud-device',
      workspacePath: '/workspace/project',
      label: 'Project',
    })
    const refreshed = workbenchReducer(opened, {
      type,
      projects: [],
      devices: [],
      runtimeWork: { projects: [], chats: [], totalTasks: 0 },
      standaloneDeviceId: 'local-device',
    })

    expect(refreshed.standaloneDeviceId).toBe('cloud-device')
    expect(refreshed.standaloneWorkspacePath).toBe('/workspace/project')
  }
)
