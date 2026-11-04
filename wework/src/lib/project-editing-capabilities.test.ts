// @vitest-environment node

import type { DeviceInfo } from '@/types/api'
import { describe, expect, test } from 'vitest'
import { projectEditingCapabilities } from './project-editing-capabilities'

const remote = (values: Partial<DeviceInfo> = {}) =>
  ({ device_id: 'remote', device_type: 'remote', status: 'online', ...values }) as DeviceInfo

describe('project editing compatibility contracts', () => {
  test.each([undefined, '', 'invalid', '1.8.4', '1.8.7', '2.0.22', '99.0.0', '1.8.6-beta'])(
    'grants no new settings writes for unverified version %s',
    executor_version => {
      expect(projectEditingCapabilities(remote({ executor_version }))).toEqual({
        multiRoots: false,
        aiSettings: false,
        defaultProjectSpace: false,
        plugins: 'unknown',
      })
    }
  )
})
