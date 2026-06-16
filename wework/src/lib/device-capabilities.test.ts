import { describe, expect, test } from 'vitest'
import {
  WEWORK_MIN_EXECUTOR_VERSION,
  canRequestDeviceUpgrade,
  canUseForProjectCreation,
  isDeviceBelowWeWorkVersion,
  isDeviceRunningTask,
  isVersionAtLeast,
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
      }),
    ).toBe(true)
    expect(
      canRequestDeviceUpgrade({
        status: 'online',
        bind_shell: 'claudecode',
        slot_used: 1,
      }),
    ).toBe(false)
    expect(
      canRequestDeviceUpgrade({
        status: 'offline',
        bind_shell: 'claudecode',
        slot_used: 0,
      }),
    ).toBe(false)
  })
})
