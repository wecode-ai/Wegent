import { describe, expect, it } from 'vitest'
import type { ProjectWithTasks } from '@/types/api'
import { collaborationExecutionMode } from './collaborationWorkspacePolicy'

describe('collaborationExecutionMode', () => {
  const project = {
    id: 1,
    name: 'Repository',
    tasks: [],
    config: { mode: 'workspace', workspace: { source: 'git' } },
  } as ProjectWithTasks

  it('isolates Git tasks by default without depending on device availability', () => {
    expect(collaborationExecutionMode(project)).toBe('git_worktree')
  })

  it('respects explicit shared directory policy', () => {
    expect(collaborationExecutionMode(project, 'project')).toBe('current_workspace')
  })

  it('does not request worktrees without a Git repository', () => {
    expect(collaborationExecutionMode(null)).toBe('current_workspace')
    expect(collaborationExecutionMode({ ...project, config: undefined })).toBe('current_workspace')
  })

  it('does not confuse imported Git directories or unavailable probes with non-Git directories', () => {
    const imported = {
      ...project,
      config: { mode: 'workspace', workspace: { source: 'local_path' } },
    } as ProjectWithTasks
    expect(collaborationExecutionMode(imported)).toBe('git_worktree')
    const probe = {
      available: false,
      reason: 'preflight_failed',
      deviceId: null,
      sourcePath: null,
    } as const
    expect(collaborationExecutionMode(imported, undefined, probe)).toBe('git_worktree')
    expect(collaborationExecutionMode(imported, undefined, { ...probe, reason: 'not_git' })).toBe(
      'current_workspace'
    )
  })
})
