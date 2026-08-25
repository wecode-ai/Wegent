import { describe, expect, it, vi } from 'vitest'
import { loadTaskChangeRequests, type TaskChangeRequestTarget } from './changeRequests'

const targets: TaskChangeRequestTarget[] = [
  {
    deviceId: 'device-1',
    taskId: 'task-a',
    workspacePath: '/repo/worktrees/a',
    remoteUrl: 'git@github.com:wecode-ai/Wegent.git',
    branch: 'feature/a',
  },
  {
    deviceId: 'device-1',
    taskId: 'task-b',
    workspacePath: '/repo/worktrees/b',
    remoteUrl: 'git@github.com:wecode-ai/Wegent.git',
    branch: 'feature/b',
  },
]

describe('loadTaskChangeRequests', () => {
  it('loads one repository snapshot and maps PR and merge queue states back to tasks', async () => {
    const executeCommand = vi.fn(async (_deviceId: string, request: { command_key: string }) => {
      if (request.command_key === 'git_github_pull_requests_batch') {
        return {
          success: true,
          stdout: [
            {
              number: 10,
              html_url: 'https://github.com/wecode-ai/Wegent/pull/10',
              title: 'Feature A',
              state: 'open',
              head: { ref: 'feature/a' },
              updated_at: '2026-08-20T10:00:00Z',
            },
            {
              number: 11,
              html_url: 'https://github.com/wecode-ai/Wegent/pull/11',
              title: 'Feature B',
              state: 'open',
              head: { ref: 'feature/b' },
              updated_at: '2026-08-20T11:00:00Z',
            },
          ],
          stderr: '',
        }
      }
      return {
        success: true,
        stdout: {
          data: {
            repository: {
              pr0: {
                state: 'OPEN',
                statusCheckRollup: { state: 'PENDING' },
                mergeable: 'MERGEABLE',
                mergeStateStatus: 'CLEAN',
                mergeQueueEntry: { state: 'AWAITING_CHECKS' },
                timelineItems: { nodes: [] },
              },
              pr1: {
                state: 'OPEN',
                statusCheckRollup: { state: 'SUCCESS' },
                mergeable: 'MERGEABLE',
                mergeStateStatus: 'CLEAN',
                mergeQueueEntry: null,
                timelineItems: {
                  nodes: [
                    {
                      __typename: 'RemovedFromMergeQueueEvent',
                      createdAt: '2026-08-20T11:30:00Z',
                      reason: 'Required status check failed',
                    },
                  ],
                },
              },
            },
          },
        },
        stderr: '',
      }
    })

    const snapshots = await loadTaskChangeRequests({ executeCommand }, targets)

    expect(executeCommand).toHaveBeenCalledTimes(2)
    expect(snapshots).toHaveLength(2)
    expect(snapshots[0].changeRequest).toMatchObject({
      number: 10,
      headBranch: 'feature/a',
      checks: 'pending',
      mergeQueue: 'checking',
    })
    expect(snapshots[1].changeRequest).toMatchObject({
      number: 11,
      headBranch: 'feature/b',
      checks: 'success',
      mergeQueue: 'failed',
      mergeQueueReason: 'Required status check failed',
    })
  })

  it('queries separate repositories once each instead of once per task', async () => {
    const executeCommand = vi.fn().mockResolvedValue({
      success: true,
      stdout: [],
      stderr: '',
    })

    await loadTaskChangeRequests({ executeCommand }, [
      ...targets,
      {
        ...targets[0],
        taskId: 'task-c',
        remoteUrl: 'https://github.com/openai/example.git',
        workspacePath: '/repo/example',
      },
    ])

    expect(executeCommand).toHaveBeenCalledTimes(2)
  })

  it('loads check conclusions for merged pull requests', async () => {
    const executeCommand = vi.fn(async (_deviceId: string, request: { command_key: string }) => {
      if (request.command_key === 'git_github_pull_requests_batch') {
        return {
          success: true,
          stdout: [
            {
              number: 12,
              html_url: 'https://github.com/wecode-ai/Wegent/pull/12',
              title: 'Merged feature',
              state: 'closed',
              merged_at: '2026-08-20T12:00:00Z',
              head: { ref: 'feature/a' },
            },
          ],
          stderr: '',
        }
      }
      return {
        success: true,
        stdout: {
          data: {
            repository: {
              pr0: {
                state: 'MERGED',
                mergedAt: '2026-08-20T12:00:00Z',
                statusCheckRollup: { state: 'SUCCESS' },
                mergeable: 'UNKNOWN',
                mergeStateStatus: 'UNKNOWN',
                mergeQueueEntry: null,
                timelineItems: { nodes: [] },
              },
            },
          },
        },
        stderr: '',
      }
    })

    const snapshots = await loadTaskChangeRequests({ executeCommand }, [targets[0]])

    expect(executeCommand).toHaveBeenCalledTimes(2)
    expect(snapshots[0].changeRequest).toMatchObject({
      number: 12,
      state: 'merged',
      checks: 'success',
    })
  })
})
