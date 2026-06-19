import { describe, expect, test } from 'vitest'
import {
  canRequestDeviceUpgrade,
  canUseForProjectCreation,
  isDeviceUpgradeRequiredForWeWork,
  isDeviceRunningTask,
  supportsLocalTerminalLaunch,
  supportsRemoteTerminalSessions,
} from './device-capabilities'

describe('device-capabilities', () => {
  test('detects devices running tasks from slot or task ids', () => {
    expect(isDeviceRunningTask({ status: 'online', slot_used: 1 })).toBe(true)
    expect(isDeviceRunningTask({ status: 'online', running_task_ids: [7] })).toBe(true)
    expect(isDeviceRunningTask({ status: 'online', running_tasks: [{ task_id: 8 }] })).toBe(true)
    expect(isDeviceRunningTask({ status: 'online', slot_used: 0 })).toBe(false)
  })

  test('blocks project creation for devices that require an upgrade', () => {
    const upgradeRequiredDevice = {
      device_type: 'cloud',
      bind_shell: 'claudecode',
      status: 'online',
      executor_version: '1.8.4',
    }
    const compatibleDevice = {
      ...upgradeRequiredDevice,
      direct_chat: { enabled: true },
    }

    expect(isDeviceUpgradeRequiredForWeWork(upgradeRequiredDevice)).toBe(true)
    expect(canUseForProjectCreation(upgradeRequiredDevice)).toBe(false)
    expect(canUseForProjectCreation(compatibleDevice)).toBe(true)
    expect(canUseForProjectCreation({ ...compatibleDevice, direct_chat: null })).toBe(false)
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

  test('supports remote terminal sessions on Claude Code devices without requiring cloud type', () => {
    const claudeDevice = {
      bind_shell: 'claudecode',
      status: 'online',
    }

    expect(supportsRemoteTerminalSessions({ ...claudeDevice, device_type: 'local' })).toBe(true)
    expect(supportsRemoteTerminalSessions({ ...claudeDevice, device_type: 'cloud' })).toBe(true)
    expect(
      supportsRemoteTerminalSessions({
        ...claudeDevice,
        device_type: 'local',
        bind_shell: 'openclaw',
      })
    ).toBe(false)
  })
})
