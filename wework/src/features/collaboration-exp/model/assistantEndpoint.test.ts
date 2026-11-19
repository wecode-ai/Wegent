import { describe, expect, it } from 'vitest'
import type { DeviceInfo } from '@/types/api'
import { experienceAssistantEndpoint } from './assistantEndpoint'

function device(deviceType: DeviceInfo['device_type'], status = 'online' as const): DeviceInfo {
  return {
    id: 1,
    device_id: 'device-1',
    name: 'Assistant device',
    status,
    is_default: false,
    device_type: deviceType,
    bind_shell: 'claudecode',
  }
}

describe('experienceAssistantEndpoint', () => {
  it.each([
    ['local', 'local_wework'],
    ['app', 'local_wework'],
    ['cloud', 'cloud_device'],
    ['remote', 'cloud_device'],
  ] as const)('maps %s execution to %s endpoint identity', (deviceType, kind) => {
    expect(
      experienceAssistantEndpoint([device(deviceType)], 'device-1', {
        ownerUserId: 7,
        roleId: 'review',
        displayName: 'Reviewer',
      })
    ).toMatchObject({ id: `${kind}:7:review`, kind, availability: 'online' })
  })

  it('does not guess a provider when the configured device is unavailable', () => {
    expect(
      experienceAssistantEndpoint([], 'missing-device', {
        ownerUserId: 7,
        roleId: 'review',
        displayName: 'Reviewer',
      })
    ).toBeNull()
  })
})
