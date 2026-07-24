import { describe, expect, test } from 'vitest'
import {
  WEWORK_MIN_EXECUTOR_VERSION,
  canRequestDeviceUpgrade,
  canUseForProjectCreation,
  isDeviceBelowWeWorkVersion,
  isDeviceRunningTask,
  isVersionAtLeast,
  supportsCloudSessions,
  supportsLocalTerminalLaunch,
  supportsRemoteTerminalSessions,
} from './device-capabilities'

describe('device-capabilities', () => {
  test('compares executor versions with v prefixes and suffixes', () => {
    expect(isVersionAtLeast('v1.8.5', WEWORK_MIN_EXECUTOR_VERSION)).toBe(true)
    expect(isVersionAtLeast('1.8.6-beta', WEWORK_MIN_EXECUTOR_VERSION)).toBe(true)
    expect(isVersionAtLeast('1.8.4', WEWORK_MIN_EXECUTOR_VERSION)).toBe(false)
  })

  test('detects devices running tasks from slot or task ids', () => {
    expect(isDeviceRunningTask({ status: 'online', slot_used: 1 })).toBe(true)
    expect(isDeviceRunningTask({ status: 'online', running_task_ids: [7] })).toBe(true)
    expect(isDeviceRunningTask({ status: 'online', running_tasks: [{ task_id: 8 }] })).toBe(true)
    expect(isDeviceRunningTask({ status: 'online', slot_used: 0 })).toBe(false)
  })

  test('blocks project creation for devices below the WeWork executor version', () => {
    const oldDevice = {
      device_type: 'cloud',
      bind_shell: 'claudecode',
      status: 'online',
      executor_version: '1.8.4',
    }
    const compatibleDevice = {
      ...oldDevice,
      executor_version: '1.8.5',
    }

    expect(isDeviceBelowWeWorkVersion(oldDevice)).toBe(true)
    expect(canUseForProjectCreation(oldDevice)).toBe(false)
    expect(canUseForProjectCreation(compatibleDevice)).toBe(true)
    expect(canUseForProjectCreation({ ...oldDevice, executor_version: undefined })).toBe(false)
  })

  test('requires online idle state before requesting an upgrade', () => {
    expect(
      canRequestDeviceUpgrade({
        status: 'online',
        bind_shell: 'claudecode',
        slot_used: 0,
      })
    ).toBe(true)
    expect(
      canRequestDeviceUpgrade({
        status: 'online',
        bind_shell: 'claudecode',
        slot_used: 1,
      })
    ).toBe(false)
    expect(
      canRequestDeviceUpgrade({
        status: 'offline',
        bind_shell: 'claudecode',
        slot_used: 0,
      })
    ).toBe(false)
  })

  test('supports native terminal launch only on local Claude Code devices', () => {
    const claudeDevice = {
      bind_shell: 'claudecode',
      status: 'online',
    }

    expect(supportsLocalTerminalLaunch({ ...claudeDevice, device_type: 'local' })).toBe(true)
    expect(supportsLocalTerminalLaunch({ ...claudeDevice, device_type: 'cloud' })).toBe(false)
    expect(
      supportsLocalTerminalLaunch({
        ...claudeDevice,
        device_type: 'local',
        bind_shell: 'openclaw',
      })
    ).toBe(false)
  })

  test('supports remote terminal sessions only on remote or cloud Claude Code devices', () => {
    const claudeDevice = {
      bind_shell: 'claudecode',
      status: 'online',
    }

    expect(supportsRemoteTerminalSessions({ ...claudeDevice, device_type: 'local' })).toBe(false)
    expect(supportsRemoteTerminalSessions({ ...claudeDevice, device_type: 'cloud' })).toBe(true)
    expect(supportsRemoteTerminalSessions({ ...claudeDevice, device_type: 'remote' })).toBe(true)
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
