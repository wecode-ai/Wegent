// @vitest-environment node

import type { ProjectWithTasks } from '@/types/api'
import { describe, expect, test } from 'vitest'
import { supportsGitWorktreeExecution } from './projectClassification'

function createProject(
  targetType: 'local' | 'cloud' | 'remote',
  source: 'git' | 'local_path' | 'device_path'
): ProjectWithTasks {
  return {
    id: 1,
    name: 'Wegent',
    config: {
      mode: 'workspace',
      execution: {
        targetType,
        deviceId: `${targetType}-device`,
      },
      workspace: {
        source,
        localPath: '/workspace/wegent',
        checkoutPath: '/workspace/wegent',
      },
    },
  }
}

describe('supportsGitWorktreeExecution', () => {
  test('rejects projects without a configured workspace path', () => {
    const project = createProject('cloud', 'device_path')
    project.config!.workspace = { source: 'device_path' }

    expect(supportsGitWorktreeExecution(project)).toBe(false)
  })
})
