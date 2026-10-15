import { describe, expect, test } from 'vitest'
import type { DeviceInfo } from '@/types/api'
import {
  projectEditingCapabilities,
  projectEditingDeviceRevision,
} from './project-editing-capabilities'

const remote = (values: Partial<DeviceInfo> = {}) =>
  ({ device_id: 'remote', device_type: 'remote', status: 'online', ...values }) as DeviceInfo

describe('project editing compatibility contracts', () => {
  test('online and busy describe the same connected runtime lifecycle', () => {
    expect(projectEditingDeviceRevision(remote({ status: 'online' }))).toBe(
      projectEditingDeviceRevision(remote({ status: 'busy' }))
    )
    expect(projectEditingDeviceRevision(remote({ status: 'online' }))).not.toBe(
      projectEditingDeviceRevision(remote({ status: 'offline' }))
    )
  })
  test('retains full settings on the verified published 2.0.21 image', () => {
    expect(projectEditingCapabilities(remote({ executor_version: '2.0.21' }))).toEqual({
      multiRoots: true,
      aiSettings: true,
      defaultProjectSpace: true,
      plugins: 'unknown',
    })
  })

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

  test('explicit independent flags override a verified legacy version', () => {
    expect(
      projectEditingCapabilities(
        remote({
          executor_version: '1.8.6',
          runtime_features: {
            schemaVersion: 4,
            projectEditing: { multiRoots: false, aiSettings: true, plugins: false },
          },
        })
      )
    ).toEqual({
      multiRoots: false,
      aiSettings: true,
      defaultProjectSpace: false,
      plugins: 'unsupported',
    })
  })

  test.each([null, 'invalid', { aiSettings: 'true', multiRoots: 1 }])(
    'malformed explicit advertisements stay conservative: %s',
    projectEditing => {
      expect(
        projectEditingCapabilities(
          remote({
            executor_version: '1.8.6',
            runtime_features: { schemaVersion: 4, projectEditing } as never,
          })
        )
      ).toEqual({
        multiRoots: false,
        aiSettings: false,
        defaultProjectSpace: false,
        plugins: 'unsupported',
      })
    }
  )
})
