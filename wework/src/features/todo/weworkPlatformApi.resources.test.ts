// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest'
import type { CollaborationExecutionEnvironment } from '@wegent/collaboration'
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
  it('uses the cloud record for the current local device and removes its duplicate', () => {
    const local = environment({
      id: 'device:APB22015038',
      device_id: 0,
      device_key: 'APB22015038',
      name: 'APB22015038',
      owner_type: 'workspace',
      owner_id: 'wework-local-workspace',
    })
    const registered = environment({
      id: '42',
      device_id: 42,
      device_key: 'APB22015038',
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

  it('does not expose an unregistered local placeholder to cloud projects', () => {
    const local = environment({
      id: 'device:local-only',
      device_id: 0,
      device_key: 'local-only',
      owner_type: 'workspace',
      owner_id: 'wework-local-workspace',
    })
    const cloudHost = environment({
      id: '43',
      device_id: 43,
      device_key: 'cloud-device',
      kind: 'cloud_host',
    })

    expect(mergeExecutionEnvironmentResources([local], [cloudHost])).toEqual([cloudHost])
  })
})
