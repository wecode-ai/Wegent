import { describe, expect, it } from 'vitest'
import type { RuntimeDeviceWorkspace, RuntimeTaskSummary } from '@/types/api'
import { runtimeTaskChangeRequestTarget } from './changeRequestMonitor'

describe('runtimeTaskChangeRequestTarget', () => {
  it('uses the runtime current branch when registering a PR lookup target', () => {
    const workspace = {
      deviceId: 'local-device',
      workspacePath: '/repo',
      repoUrl: 'https://github.com/wecode-ai/Wegent.git',
      tasks: [],
    } as RuntimeDeviceWorkspace
    const task = {
      taskId: 'runtime-1',
      title: 'Fix status',
      runtime: 'codex',
      workspacePath: '/repo/worktrees/runtime-1',
      gitInfo: {
        branch: 'main',
        currentBranch: 'fix/pr-status',
        originUrl: 'https://github.com/wecode-ai/Wegent.git',
      },
    } as RuntimeTaskSummary

    expect(runtimeTaskChangeRequestTarget(workspace, task)).toEqual({
      deviceId: 'local-device',
      taskId: 'runtime-1',
      workspacePath: '/repo/worktrees/runtime-1',
      remoteUrl: 'https://github.com/wecode-ai/Wegent.git',
      branch: 'fix/pr-status',
    })
  })
})
