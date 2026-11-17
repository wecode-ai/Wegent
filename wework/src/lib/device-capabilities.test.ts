// @vitest-environment node

import { describe, expect, test } from 'vitest'
import {
  WEWORK_MIN_EXECUTOR_VERSION,
  canUseForProjectCreation,
  isRemoteTaskDevice,
  supportsLocalTerminalLaunch,
  supportsRemoteCodeServerSessions,
  supportsCloudSessions,
  supportsRemoteTerminalSessions,
} from './device-capabilities'

describe('device-capabilities', () => {
  test('opted-in computers support existing tasks without exposing terminal or project creation', () => {
    const device = {
      id: 22,
      device_id: 'app-record-22',
      execution_target_id: 'app-record-22',
      device_type: 'app',
      status: 'online' as const,
      bind_shell: 'claudecode',
      executor_version: WEWORK_MIN_EXECUTOR_VERSION,
      runtime_features: { schemaVersion: 4, remoteTaskAccess: { version: 1, enabled: true } },
      runtime_routes: [
        {
          kind: 'remote-relay' as const,
          device_id: 'app-record-22',
          runtime_device_id: 'app-record-22',
          status: 'online' as const,
        },
      ],
    }
    expect(isRemoteTaskDevice(device)).toBe(true)
    expect(canUseForProjectCreation(device)).toBe(false)
    expect(supportsLocalTerminalLaunch(device)).toBe(false)
    expect(supportsRemoteTerminalSessions(device, device.device_id)).toBe(false)
    expect(supportsRemoteCodeServerSessions(device, device.device_id)).toBe(false)
  })

  test('supports remote terminal sessions only on remote or cloud Claude Code devices', () => {
    const claudeDevice = {
      bind_shell: 'claudecode',
      status: 'online',
    }

    expect(supportsRemoteTerminalSessions({ ...claudeDevice, device_type: 'local' })).toBe(false)
    expect(supportsRemoteTerminalSessions({ ...claudeDevice, device_type: 'cloud' })).toBe(true)
    expect(supportsRemoteTerminalSessions({ ...claudeDevice, device_type: 'remote' })).toBe(true)
    expect(
      supportsRemoteTerminalSessions({
        ...claudeDevice,
        device_type: 'remote',
        runtime_features: {
          schemaVersion: 3,
          interactiveSessions: { terminal: false },
        },
      })
    ).toBe(false)
    expect(
      supportsRemoteTerminalSessions({
        ...claudeDevice,
        device_type: 'remote',
        status: 'offline',
      })
    ).toBe(false)
    const mergedDevice = {
      ...claudeDevice,
      device_type: 'local',
      runtime_routes: [
        {
          kind: 'local-ipc',
          device_id: 'local-device',
          runtime_device_id: 'local-device',
          device_type: 'local',
          status: 'online',
        },
        {
          kind: 'cloud-relay',
          device_id: 'cloud-device',
          runtime_device_id: 'cloud-device',
          device_type: 'cloud',
          status: 'online',
        },
      ],
    }

    expect(supportsRemoteTerminalSessions(mergedDevice, 'cloud-device')).toBe(true)
    expect(supportsRemoteTerminalSessions(mergedDevice, 'local-device')).toBe(false)
    expect(supportsCloudSessions(mergedDevice, 'cloud-device')).toBe(true)
    expect(supportsCloudSessions(mergedDevice, 'local-device')).toBe(false)
    expect(
      supportsRemoteTerminalSessions({
        ...claudeDevice,
        device_type: 'remote',
        bind_shell: 'openclaw',
      })
    ).toBe(false)
  })
})
