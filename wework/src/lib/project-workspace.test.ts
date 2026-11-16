// @vitest-environment node

import type { ProjectWithTasks } from '@/types/api'
import { describe, expect, test, vi } from 'vitest'
import { resolveProjectWorkspacePath } from './project-workspace'

describe('project workspace helpers', () => {
  test('rejects relative git checkout paths with parent traversal', async () => {
    const api = {
      getProjectWorkspaceRoot: vi.fn().mockResolvedValue('/workspace/projects'),
    }
    const project: ProjectWithTasks = {
      id: 12,
      name: 'Wegent',
      tasks: [],
      config: {
        mode: 'workspace',
        execution: { targetType: 'local', deviceId: 'device-b' },
        workspace: { source: 'git', checkoutPath: '../secrets' },
      },
    }

    await expect(resolveProjectWorkspacePath(project, 'device-b', api)).rejects.toThrow(
      'Workspace path cannot contain parent traversal'
    )
  })
})
