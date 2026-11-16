// @vitest-environment node

// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { CollaborationExecutionEnvironment } from '@wegent/collaboration'
import { describe, expect, it } from 'vitest'
import { mergeExecutionEnvironmentResources } from './weworkPlatformApi'

function environment(
  overrides: Partial<CollaborationExecutionEnvironment>
): CollaborationExecutionEnvironment {
  return {
    id: 'environment-1',
    device_id: 1,
    device_key: 'device-1',
    name: 'Device',
    kind: 'local_device',
    coding_tools: ['codex'],
    owner_type: 'user',
    owner_id: '7',
    owner_name: 'User',
    status: 'online',
    updated_at: '2026-09-21T00:00:00Z',
    ...overrides,
  }
}

describe('mergeExecutionEnvironmentResources', () => {
  it.each([true, false])(
    'keeps distinct device records when historical records come first: %s',
    historicalFirst => {
      const local = environment({ device_id: 0, device_key: 'electron-current' })
      const current = environment({
        id: '42',
        device_id: 42,
        device_key: 'app-record-42',
        app_device_id: 'electron-current',
      })
      const historical = environment({
        id: '41',
        device_id: 41,
        device_key: 'electron-current',
        status: 'offline',
      })
      const devices = historicalFirst ? [historical, current] : [current, historical]
      const merged = mergeExecutionEnvironmentResources([local], devices)
      expect(merged).toEqual(devices.map(device => ({ ...device, is_current_device: true })))
      expect(
        merged.filter(device => device.is_current_device && device.status === 'online')
      ).toEqual([{ ...current, is_current_device: true }])
    }
  )

  it('deduplicates repeated grants for the same cloud device record', () => {
    const device = environment({ id: '42', device_id: 42 })
    expect(mergeExecutionEnvironmentResources([], [device, { ...device, id: 'grant-42' }])).toEqual(
      [device]
    )
  })

  it('uses the cloud record for the current local device and removes its duplicate', () => {
    const local = environment({
      id: 'device:APB22015038',
      device_id: 0,
      device_key: 'APB22015038',
      app_device_id: 'electron-installation-1',
      name: 'APB22015038',
      owner_type: 'workspace',
      owner_id: 'wework-local-workspace',
    })
    const registered = environment({
      id: '42',
      device_id: 42,
      device_key: 'app-record-42',
      app_device_id: 'electron-installation-1',
      name: 'APB22015038',
    })
    const cloudHost = environment({
      id: '43',
      device_id: 43,
      device_key: 'cloud-device',
      name: 'Cloud device',
      kind: 'cloud_host',
    })

    expect(mergeExecutionEnvironmentResources([local], [registered, cloudHost])).toEqual([
      { ...registered, is_current_device: true },
      cloudHost,
    ])
  })
})
