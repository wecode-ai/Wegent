import { describe, expect, test } from 'vitest'
import type { ProjectWithTasks } from '@/types/api'
import type { EnvironmentInfo } from '@/types/environment'
import {
  applySharedChangeRequestSnapshot,
  resolveConversationSummaryIsGitRepository,
  resolveEnvironmentExecutionDeviceId,
  resolveSelectedWorkspaceProject,
} from './useWorkbenchPaneEnvironment'

describe('resolveConversationSummaryIsGitRepository', () => {
  test('uses project repository metadata instead of an unrelated task environment', () => {
    expect(
      resolveConversationSummaryIsGitRepository({
        environmentInfo: {
          additions: '',
          deletions: '',
          executionTarget: 'local',
          isGitRepository: true,
        },
        project: {
          id: 7,
          name: 'Documents',
          tasks: [],
          config: {
            workspace: { source: 'local_path', localPath: '/workspace/documents' },
          },
        },
        projectWorkspace: {
          repoRootFingerprint: null,
          repoUrl: null,
          workspacePath: '/workspace/documents',
        },
      })
    ).toBe(false)
  })

  test('uses fresh environment inspection when it matches the project workspace', () => {
    expect(
      resolveConversationSummaryIsGitRepository({
        environmentInfo: {
          additions: '',
          deletions: '',
          executionTarget: 'local',
          isGitRepository: true,
          workspacePath: '/workspace/repository',
        },
        project: {
          id: 8,
          name: 'Repository',
          tasks: [],
          config: {
            workspace: { source: 'local_path', localPath: '/workspace/repository' },
          },
        },
        projectWorkspace: {
          repoRootFingerprint: null,
          repoUrl: null,
          workspacePath: '/workspace/repository',
        },
      })
    ).toBe(true)
  })

  test('recognizes a Git worktree from direct branch evidence outside the project root', () => {
    expect(
      resolveConversationSummaryIsGitRepository({
        environmentInfo: {
          additions: '+3',
          branchName: 'feature/output-summary',
          deletions: '-1',
          executionTarget: 'local',
          isGitRepository: false,
          workspacePath: '/workspace/worktrees/output-summary',
        },
        project: {
          id: 8,
          name: 'Repository',
          tasks: [],
          config: {
            workspace: { source: 'local_path', localPath: '/workspace/repository' },
          },
        },
        projectWorkspace: {
          repoRootFingerprint: null,
          repoUrl: null,
          workspacePath: '/workspace/repository',
        },
      })
    ).toBe(true)
  })

  test('uses fresh environment inspection for the active Runtime worktree', () => {
    expect(
      resolveConversationSummaryIsGitRepository({
        activeWorkspacePath: '/workspace/worktrees/output-summary',
        environmentInfo: {
          additions: '',
          deletions: '',
          executionTarget: 'local',
          isGitRepository: true,
          workspacePath: '/workspace/worktrees/output-summary',
        },
        project: {
          id: 8,
          name: 'Repository',
          tasks: [],
          config: {
            workspace: { source: 'local_path', localPath: '/workspace/repository' },
          },
        },
        projectWorkspace: {
          repoRootFingerprint: null,
          repoUrl: null,
          workspacePath: '/workspace/repository',
        },
      })
    ).toBe(true)
  })

  test('ignores environment inspection for a different Runtime worktree', () => {
    expect(
      resolveConversationSummaryIsGitRepository({
        activeWorkspacePath: '/workspace/worktrees/active-task',
        environmentInfo: {
          additions: '',
          deletions: '',
          executionTarget: 'local',
          isGitRepository: true,
          workspacePath: '/workspace/worktrees/other-task',
        },
        project: {
          id: 8,
          name: 'Repository',
          tasks: [],
          config: {
            workspace: { source: 'local_path', localPath: '/workspace/repository' },
          },
        },
        projectWorkspace: {
          repoRootFingerprint: null,
          repoUrl: null,
          workspacePath: '/workspace/repository',
        },
      })
    ).toBe(false)
  })

  test('recognizes local Git projects from repository metadata', () => {
    expect(
      resolveConversationSummaryIsGitRepository({
        environmentInfo: {
          additions: '',
          deletions: '',
          executionTarget: 'local',
          isGitRepository: false,
        },
        project: {
          id: 8,
          name: 'Repository',
          tasks: [],
        },
        projectWorkspace: {
          repoRootFingerprint: 'sha256:repository',
          repoUrl: null,
          workspacePath: '/workspace/repository',
        },
      })
    ).toBe(true)
  })

  test('keeps the summary selection unresolved while a project workspace awaits inspection', () => {
    expect(
      resolveConversationSummaryIsGitRepository({
        environmentInfo: {
          additions: '',
          deletions: '',
          executionTarget: 'local',
        },
        project: {
          id: 8,
          name: 'Workspace',
          tasks: [],
          config: {
            workspace: { source: 'local_path', localPath: '/workspace/project' },
          },
        },
        projectWorkspace: {
          repoRootFingerprint: null,
          repoUrl: null,
          workspacePath: '/workspace/project',
        },
      })
    ).toBeUndefined()
  })

  test('falls back to environment classification before project metadata is available', () => {
    expect(
      resolveConversationSummaryIsGitRepository({
        environmentInfo: {
          additions: '',
          deletions: '',
          executionTarget: 'local',
          isGitRepository: true,
        },
        project: null,
        projectWorkspace: null,
      })
    ).toBe(true)
  })
})

describe('resolveSelectedWorkspaceProject', () => {
  test('uses the active Runtime project when it is absent from the persisted project list', () => {
    const runtimeProject: ProjectWithTasks = {
      id: 7,
      name: 'Remote Runtime Project',
      tasks: [],
    }

    expect(
      resolveSelectedWorkspaceProject({
        currentProject: runtimeProject,
        currentProjectId: runtimeProject.id,
        projects: [],
      })
    ).toBe(runtimeProject)
  })

  test('falls back to the persisted project list', () => {
    const persistedProject: ProjectWithTasks = {
      id: 8,
      name: 'Persisted Project',
      tasks: [],
    }

    expect(
      resolveSelectedWorkspaceProject({
        currentProject: null,
        currentProjectId: persistedProject.id,
        projects: [persistedProject],
      })
    ).toBe(persistedProject)
  })
})

describe('resolveEnvironmentExecutionDeviceId', () => {
  test('keeps the task executor identity when workspace access uses a local host', () => {
    expect(
      resolveEnvironmentExecutionDeviceId(
        { deviceId: 'cloud-device' },
        {
          deviceId: 'local-device',
          path: '/workspace',
          source: 'runtime',
          workspaceSource: 'remote',
        }
      )
    ).toBe('cloud-device')
  })
})

describe('applySharedChangeRequestSnapshot', () => {
  const environmentInfo: EnvironmentInfo = {
    additions: '+2',
    deletions: '-1',
    executionTarget: 'local',
    changeRequest: {
      provider: 'github',
      state: 'found',
      changeRequest: {
        provider: 'github',
        number: 47,
        url: 'https://github.com/wecode-ai/Wegent/pull/47',
        title: 'Stale environment result',
        state: 'open',
        draft: false,
        checks: 'pending',
        mergeability: 'unknown',
        mergeQueue: 'not_queued',
      },
    },
  }

  test('replaces the Environment result with the shared task snapshot', () => {
    const result = applySharedChangeRequestSnapshot(environmentInfo, {
      target: {
        deviceId: 'local',
        taskId: 'runtime-48',
        workspacePath: '/workspace',
        remoteUrl: 'https://github.com/wecode-ai/Wegent.git',
        branch: 'fix/shared-pr-state',
      },
      changeRequest: {
        provider: 'github',
        number: 48,
        url: 'https://github.com/wecode-ai/Wegent/pull/48',
        title: 'Shared task result',
        state: 'open',
        draft: false,
        checks: 'success',
        mergeability: 'mergeable',
        mergeQueue: 'not_queued',
      },
      fetchedAt: '2026-08-21T00:00:00Z',
    })

    expect(result.changeRequest?.changeRequest?.number).toBe(48)
  })

  test('uses the shared not-found state instead of retaining a stale Environment PR', () => {
    const result = applySharedChangeRequestSnapshot(environmentInfo, {
      target: {
        deviceId: 'local',
        taskId: 'runtime-48',
        workspacePath: '/workspace',
        remoteUrl: 'https://github.com/wecode-ai/Wegent.git',
        branch: 'fix/shared-pr-state',
      },
      changeRequest: null,
      fetchedAt: '2026-08-21T00:00:00Z',
    })

    expect(result.changeRequest).toEqual({ provider: 'github', state: 'not_found' })
  })

  test('keeps the fresh Environment result when the shared task snapshot is stale', () => {
    const result = applySharedChangeRequestSnapshot(
      {
        ...environmentInfo,
        changeRequest: {
          provider: 'github',
          state: 'unavailable',
          hint: 'Install GitHub CLI',
        },
      },
      {
        target: {
          deviceId: 'local',
          taskId: 'runtime-48',
          workspacePath: '/workspace',
          remoteUrl: 'https://github.com/wecode-ai/Wegent.git',
          branch: 'fix/shared-pr-state',
        },
        changeRequest: environmentInfo.changeRequest?.changeRequest ?? null,
        fetchedAt: '2026-08-21T00:00:00Z',
        stale: true,
        error: 'GitHub CLI is unavailable',
      }
    )

    expect(result.changeRequest).toEqual({
      provider: 'github',
      state: 'unavailable',
      hint: 'Install GitHub CLI',
    })
  })

  test('keeps an explicit Environment lookup failure instead of showing an older shared result', () => {
    const result = applySharedChangeRequestSnapshot(
      {
        ...environmentInfo,
        changeRequest: {
          provider: 'github',
          state: 'unavailable',
          hint: 'Install GitHub CLI',
        },
      },
      {
        target: {
          deviceId: 'local',
          taskId: 'runtime-48',
          workspacePath: '/workspace',
          remoteUrl: 'https://github.com/wecode-ai/Wegent.git',
          branch: 'fix/shared-pr-state',
        },
        changeRequest: environmentInfo.changeRequest?.changeRequest ?? null,
        fetchedAt: '2026-08-21T00:00:00Z',
      }
    )

    expect(result.changeRequest).toEqual({
      provider: 'github',
      state: 'unavailable',
      hint: 'Install GitHub CLI',
    })
  })
})
