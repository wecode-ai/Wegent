import { describe, expect, test } from 'vitest'
import {
  buildManagedWorktreePath,
  executorWorkspaceRoot,
  joinDevicePath,
  normalizeRelativeWorkspacePath,
} from './device-workspace-path'

describe('device workspace path helpers', () => {
  test('joins absolute device paths without duplicate separators', () => {
    expect(joinDevicePath('/Users/me/', '/Documents/', 'Codex', 'task')).toBe(
      '/Users/me/Documents/Codex/task'
    )
    expect(joinDevicePath('/', 'workspace', 'Wegent')).toBe('/workspace/Wegent')
  })

  test('normalizes relative workspace paths and rejects parent traversal', () => {
    expect(normalizeRelativeWorkspacePath('/projects//Wegent')).toBe('projects/Wegent')
    expect(() => normalizeRelativeWorkspacePath('../secrets')).toThrow(
      'Workspace path cannot contain parent traversal'
    )
  })

  test('resolves executor workspace root from project workspace root', () => {
    expect(executorWorkspaceRoot('/Users/me/.wegent-executor/workspace/projects')).toBe(
      '/Users/me/.wegent-executor/workspace'
    )
    expect(executorWorkspaceRoot('/workspace')).toBe('/workspace')
  })

  test('builds managed worktree paths beside executor projects', () => {
    expect(
      buildManagedWorktreePath({
        projectWorkspaceRoot: '/Users/me/.wegent-executor/workspace/projects',
        sourceWorkspacePath: '/Users/me/project',
        worktreeId: 42,
      })
    ).toBe('/Users/me/.wegent-executor/workspace/worktrees/42/project')
  })
})
