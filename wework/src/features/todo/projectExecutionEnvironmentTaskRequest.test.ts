import { describe, expect, it } from 'vitest'

import { projectExecutionEnvironmentTaskRequest } from './projectExecutionEnvironmentTaskRequest'

describe('projectExecutionEnvironmentTaskRequest', () => {
  it('uses an isolated worktree for a prepared primary repository', () => {
    expect(
      projectExecutionEnvironmentTaskRequest({
        execution_environment: {
          repositories: [
            {
              name: 'wegent',
              url: '/workspace/wegent',
              ref: '',
              path: 'wegent',
              primary: true,
            },
          ],
          setup_steps: [],
          devices: {
            'runtime-device': {
              status: 'ready',
              workspace_path: '/srv/projects/wegent',
            },
          },
        },
      })
    ).toEqual({
      schemaVersion: 2,
      runtime: 'codex',
      message: '',
      deviceId: 'runtime-device',
      workspacePath: '/srv/projects/wegent',
      execution: {
        workspace: { source: 'git_worktree' },
      },
    })
  })

  it('uses the prepared workspace directly when no repository is configured', () => {
    expect(
      projectExecutionEnvironmentTaskRequest({
        execution_environment: {
          repositories: [],
          setup_steps: [{ command: 'make setup', working_directory: '.' }],
          devices: {
            'runtime-device': {
              status: 'ready',
              workspace_path: '/srv/projects/setup-only',
            },
          },
        },
      })
    ).toEqual({
      schemaVersion: 2,
      runtime: 'codex',
      message: '',
      deviceId: 'runtime-device',
      workspacePath: '/srv/projects/setup-only',
    })
  })
})
