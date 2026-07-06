import { describe, expect, test } from 'vitest'
import { runtimeProjectToProject, runtimeProjectUiId } from './runtime-project'
import type { RuntimeProjectWork } from '@/types/api'

describe('runtime project helpers', () => {
  test('builds a workspace project config from runtime device workspace context', () => {
    const runtimeProject: RuntimeProjectWork = {
      project: {
        key: 'local:/Users/me/Wegent',
        name: 'Wegent',
        description: '/Users/me/Wegent',
        color: '#14B8A6',
      },
      deviceWorkspaces: [
        {
          id: null,
          projectId: null,
          deviceId: 'local-device',
          deviceName: 'Local Device',
          deviceStatus: 'online',
          available: true,
          workspacePath: '/Users/me/Wegent',
          workspaceKind: 'workspace',
          mapped: true,
          tasks: [],
        },
      ],
    }

    expect(runtimeProjectToProject(runtimeProject)).toEqual({
      id: runtimeProjectUiId(runtimeProject.project),
      name: 'Wegent',
      description: '/Users/me/Wegent',
      color: '#14B8A6',
      config: {
        mode: 'workspace',
        execution: {
          targetType: 'local',
          deviceId: 'local-device',
        },
        workspace: {
          source: 'local_path',
          localPath: '/Users/me/Wegent',
        },
      },
      tasks: [],
    })
  })

  test('prefers an available workspace when multiple runtime workspaces exist', () => {
    const project = runtimeProjectToProject({
      project: {
        key: 'project:Wegent',
        name: 'Wegent',
      },
      deviceWorkspaces: [
        {
          id: 1,
          projectId: null,
          deviceId: 'offline-device',
          deviceName: 'Offline Device',
          deviceStatus: 'offline',
          available: false,
          workspacePath: '/offline/Wegent',
          workspaceKind: 'workspace',
          mapped: true,
          tasks: [],
        },
        {
          id: 2,
          projectId: null,
          deviceId: 'local-device',
          deviceName: 'Local Device',
          deviceStatus: 'online',
          available: true,
          workspacePath: '/Users/me/Wegent',
          workspaceKind: 'workspace',
          mapped: true,
          tasks: [],
        },
      ],
    })

    expect(project.config?.execution?.deviceId).toBe('local-device')
    expect(project.config?.workspace?.localPath).toBe('/Users/me/Wegent')
  })
})
