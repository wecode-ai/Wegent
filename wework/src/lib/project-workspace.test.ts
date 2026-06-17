import { describe, expect, test, vi } from 'vitest'
import type { ProjectWithTasks } from '@/types/api'
import {
  configuredWorkspacePath,
  executionDeviceId,
  resolveProjectWorkspacePath,
} from './project-workspace'

describe('project workspace helpers', () => {
  test('reads configured workspace path and execution device id', () => {
    const project: ProjectWithTasks = {
      id: 12,
      name: 'Wegent',
      tasks: [],
      config: {
        mode: 'workspace',
        device_id: 'legacy-device',
        execution: { targetType: 'local', deviceId: 'device-a' },
        workspace: { source: 'local_path', localPath: '/workspace/Wegent' },
      },
    }

    expect(configuredWorkspacePath(project)).toBe('/workspace/Wegent')
    expect(executionDeviceId(project)).toBe('device-a')
  })

  test('resolves relative git checkout paths under the executor workspace root', async () => {
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
        workspace: { source: 'git', checkoutPath: 'projects/abc/Wegent' },
      },
    }

    await expect(resolveProjectWorkspacePath(project, 'device-b', api)).resolves.toBe(
      '/workspace/projects/abc/Wegent'
    )
  })

  test('prefers git checkout path over local path for git projects', async () => {
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
        workspace: {
          source: 'git',
          localPath: '/Users/me/Wegent',
          checkoutPath: 'projects/abc/Wegent',
        },
      },
    }

    expect(configuredWorkspacePath(project)).toBe('projects/abc/Wegent')
    await expect(resolveProjectWorkspacePath(project, 'device-b', api)).resolves.toBe(
      '/workspace/projects/abc/Wegent'
    )
  })

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
