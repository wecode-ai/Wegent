// @vitest-environment node

import type { DeviceInfo, ProjectWithTasks, RuntimeDeviceWorkspace } from '@/types/api'
import { describe, expect, test } from 'vitest'
import { resolveComposerWorktreeAvailability } from './project-work-bar-utils'

const project: ProjectWithTasks = {
  id: 7,
  name: 'Wegent',
  tasks: [],
  config: {
    mode: 'workspace',
    execution: {
      targetType: 'cloud',
      deviceId: 'cloud-device',
    },
    workspace: {
      source: 'device_path',
      localPath: '/workspace/wegent',
    },
  },
}

const workspace: RuntimeDeviceWorkspace = {
  id: 10,
  projectId: 7,
  deviceId: 'cloud-device',
  deviceStatus: 'online',
  available: true,
  workspacePath: '/workspace/wegent',
  workspaceKind: 'workspace',
  workspaceSource: 'remote',
  tasks: [],
}

const device: DeviceInfo = {
  id: 2,
  device_id: 'cloud-device',
  name: 'Cloud Executor',
  status: 'online',
  is_default: false,
  device_type: 'cloud',
  executor_version: '1.8.5',
}

describe('resolveComposerWorktreeAvailability', () => {
  test('stays fail-closed until authoritative Runtime availability is provided', () => {
    expect(
      resolveComposerWorktreeAvailability({
        project,
        workspace,
        device,
      })
    ).toEqual({
      available: false,
      reason: 'preflight_pending',
      deviceId: 'cloud-device',
      sourcePath: '/workspace/wegent',
    })
  })
})
