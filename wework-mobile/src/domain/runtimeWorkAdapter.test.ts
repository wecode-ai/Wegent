import { describe, expect, it } from 'vitest'

import { adaptRuntimeWorkListResponse } from './runtimeWorkAdapter'

describe('adaptRuntimeWorkListResponse', () => {
  it('matches the Mac cloud-device grouping and preserves runtime metadata', () => {
    const result = adaptRuntimeWorkListResponse(
      {
        workspaces: [
          {
            workspacePath: '/work/Wegent',
            projectKey: 'project:wegent',
            label: 'Wegent',
            workspaceKind: 'workspace',
            tasks: [
              {
                task_id: 41,
                thread_id: 'thread-1',
                title: 'Fix mobile loading',
                runtime: 'codex',
                workspace_kind: 'worktree',
                worktree_id: '4159',
                updated_at: '2026-09-04T01:00:00Z',
              },
            ],
          },
          {
            workspacePath: '/chat/one',
            workspaceKind: 'chat',
            tasks: [],
          },
        ],
      },
      'device-1',
      'Mac Studio'
    )

    expect(result.totalTasks).toBe(1)
    expect(result.projects[0]).toMatchObject({
      project: { key: 'project:wegent', name: 'Wegent', stateDeviceId: 'device-1' },
      deviceWorkspaces: [
        {
          deviceId: 'device-1',
          deviceName: 'Mac Studio',
          tasks: [
            {
              taskId: '41',
              threadId: 'thread-1',
              workspaceKind: 'worktree',
              worktreeId: '4159',
            },
          ],
        },
      ],
    })
    expect(result.chats).toHaveLength(1)
  })

  it('does not let an empty remote projection replace its local owner workspace', () => {
    const result = adaptRuntimeWorkListResponse(
      {
        workspaces: [
          { workspacePath: '/local/Wegent', label: 'Wegent', workspaceSource: 'local', tasks: [] },
          {
            workspacePath: '/remote/Wegent',
            label: 'Wegent',
            workspaceSource: 'remote',
            remoteHostId: 'remote-device',
            tasks: [],
          },
        ],
      },
      'device-1'
    )

    expect(result.projects).toHaveLength(1)
    expect(result.projects[0]?.deviceWorkspaces[0]?.deviceId).toBe('device-1')
  })
})
