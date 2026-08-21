import { describe, expect, test } from 'vitest'
import type { ProjectWithTasks, RuntimeDeviceWorkspace, UserPreferences } from '@/types/api'
import {
  getProjectWorkPreferenceKey,
  mergeProjectWorkPreference,
  readProjectWorkPreference,
  resolveProjectWorkPreferenceScope,
} from './projectWorkPreferences'

const project: ProjectWithTasks = {
  id: 7,
  name: 'Wegent',
  config: {
    mode: 'workspace',
    execution: {
      targetType: 'local',
      deviceId: 'device-1',
    },
    workspace: {
      source: 'git',
      checkoutPath: '/workspace/wegent',
    },
  },
}

function workspace(overrides: Partial<RuntimeDeviceWorkspace> = {}): RuntimeDeviceWorkspace {
  return {
    id: 22,
    projectId: 7,
    deviceId: 'device-1',
    available: true,
    workspacePath: '/workspace/wegent',
    tasks: [],
    ...overrides,
  }
}

describe('projectWorkPreferences', () => {
  test('uses the DeviceWorkspace id as the primary preference identity', () => {
    const scope = resolveProjectWorkPreferenceScope(project, workspace())

    expect(getProjectWorkPreferenceKey(scope)).toBe('project:7:workspace:22')
  })

  test('uses a stable device and repository identity when a workspace has no backend id', () => {
    const scope = resolveProjectWorkPreferenceScope(
      project,
      workspace({
        id: null,
        deviceId: 'local/device',
        repoRootFingerprint: 'sha256:repo',
      })
    )

    expect(getProjectWorkPreferenceKey(scope)).toBe(
      'project:7:workspace:local%2Fdevice:sha256%3Arepo'
    )
  })

  test('normalizes the workspace path fallback when no fingerprint exists', () => {
    const trailingSlash = resolveProjectWorkPreferenceScope(
      project,
      workspace({ id: null, workspacePath: '/workspace/wegent/' })
    )
    const backslashes = resolveProjectWorkPreferenceScope(
      project,
      workspace({ id: null, workspacePath: '\\workspace\\wegent' })
    )

    expect(getProjectWorkPreferenceKey(trailingSlash)).toBe(
      getProjectWorkPreferenceKey(backslashes)
    )
  })

  test('reads the legacy project preference until a workspace preference exists', () => {
    const preferences: UserPreferences = {
      wework_project_work_preferences: {
        'project:7': {
          executionMode: 'git_worktree',
          worktreeBranch: 'feature/legacy',
        },
      },
    }
    const scope = resolveProjectWorkPreferenceScope(project, workspace())

    expect(readProjectWorkPreference(preferences, scope)).toEqual({
      preference: {
        executionMode: 'git_worktree',
        worktreeBranch: 'feature/legacy',
      },
      source: 'legacy_project',
    })
  })

  test('prefers a DeviceWorkspace preference over the legacy project value', () => {
    const preferences: UserPreferences = {
      wework_project_work_preferences: {
        'project:7': {
          executionMode: 'git_worktree',
          worktreeBranch: 'feature/legacy',
        },
        'project:7:workspace:22': {
          executionMode: 'current_workspace',
          worktreeBranch: 'main',
        },
      },
    }
    const scope = resolveProjectWorkPreferenceScope(project, workspace())

    expect(readProjectWorkPreference(preferences, scope)).toEqual({
      preference: {
        executionMode: 'current_workspace',
        worktreeBranch: 'main',
      },
      source: 'workspace',
    })
  })

  test('migrates the legacy value on the first workspace-scoped write without deleting it', () => {
    const preferences: UserPreferences = {
      wework_project_work_preferences: {
        'project:7': {
          executionMode: 'git_worktree',
          worktreeBranch: 'feature/legacy',
        },
      },
    }
    const scope = resolveProjectWorkPreferenceScope(project, workspace())

    const next = mergeProjectWorkPreference(preferences, scope!, {
      worktreeBranch: 'feature/device',
    })

    expect(next?.wework_project_work_preferences).toEqual({
      'project:7': {
        executionMode: 'git_worktree',
        worktreeBranch: 'feature/legacy',
      },
      'project:7:workspace:22': {
        executionMode: 'git_worktree',
        worktreeBranch: 'feature/device',
      },
    })
  })

  test('does not write a project-scoped value when the workspace identity is incomplete', () => {
    const scope = {
      projectId: 7,
      deviceId: 'device-1',
    }

    expect(getProjectWorkPreferenceKey(scope)).toBeNull()
    expect(mergeProjectWorkPreference({}, scope, { executionMode: 'git_worktree' })).toBeNull()
  })
})
