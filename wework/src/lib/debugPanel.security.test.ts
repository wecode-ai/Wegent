import { RuntimeTaskLifecycleStore } from '@/features/workbench/runtimeTaskLifecycle'
import { EMPTY_CLOUD_WORK_STATUS } from '@/features/workbench/workbenchCloudStatus'
import { initialWorkbenchState } from '@/features/workbench/workbenchReducer'
import { describe, expect, it } from 'vitest'
import { getWorkbenchDebugSnapshot, updateWorkbenchDebugSnapshot } from './debugPanel'

describe('device debug snapshot security', () => {
  it('exports device diagnostics without raw connection configuration', () => {
    const device = {
      id: 1,
      device_id: 'device-1',
      name: 'Device',
      status: 'online' as const,
      is_default: true,
      cloud_config: { ubuntuInitialPassword: 'secret-cloud-value' },
      remote_config: { password: 'secret-remote-value' },
    }
    updateWorkbenchDebugSnapshot({
      state: { ...initialWorkbenchState, devices: [device] },
      lifecycle: new RuntimeTaskLifecycleStore('device-debug-test').getSnapshot(),
      taskReminders: { unreadCount: 0 },
      cloudWorkStatus: EMPTY_CLOUD_WORK_STATUS,
    })
    const devices = getWorkbenchDebugSnapshot().workbench?.devices
    expect(devices?.[0]).toMatchObject({ device_id: 'device-1', status: 'online' })
    expect(JSON.stringify(devices)).not.toContain('secret-')
    expect(devices?.[0]).not.toHaveProperty('cloud_config')
    expect(devices?.[0]).not.toHaveProperty('remote_config')
  })
})
