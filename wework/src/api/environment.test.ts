import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  buildPullRequestUrl,
  checkoutProjectBranch,
  commitAndPushProjectChanges,
  commitProjectChanges,
  createAndCheckoutProjectBranch,
  listProjectBranches,
  loadProjectEnvironment,
  loadProjectEnvironmentDiff,
  parseGitShortStat,
  pushProjectChanges,
  removeGitWorktree,
  workspaceHasUncommittedChanges,
} from './environment'

const changeRequestStatusPreference = vi.hoisted(() => ({ enabled: true }))

vi.mock('@/desktop/appPreferences', () => ({
  getAppPreferences: vi.fn(async () => ({
    changeRequestStatusEnabled: changeRequestStatusPreference.enabled,
  })),
}))

beforeEach(() => {
  changeRequestStatusPreference.enabled = true
})

describe('parseGitShortStat', () => {
  test('extracts additions and deletions from git shortstat output', () => {
    expect(parseGitShortStat(' 10 files changed, 173 insertions(+), 13366 deletions(-)')).toEqual({
      additions: '+173',
      deletions: '-13366',
    })
  })

  test('detects a non-git workspace without depending on localized stderr', async () => {
    const executeCommand = vi.fn().mockResolvedValue({
      success: false,
      stdout: '',
      error: 'Command failed',
      stderr: 'fatal: 不是 git 仓库（或者任何父目录）：.git',
    })

    const info = await loadProjectEnvironment(
      { executeCommand },
      {
        id: 4,
        name: 'plain-cloud-workspace',
        config: {
          mode: 'workspace',
          execution: {
            targetType: 'cloud',
            deviceId: 'device-456',
          },
          workspace: {
            source: 'local_path',
            localPath: '/workspace/plain-cloud-workspace',
          },
        },
      }
    )

    expect(info).toMatchObject({
      isGitRepository: false,
      deviceId: 'device-456',
      workspacePath: '/workspace/plain-cloud-workspace',
    })
    expect(info.error).toBeUndefined()
    expect(executeCommand).toHaveBeenCalledWith('device-456', {
      command_key: 'git_is_worktree',
      path: '/workspace/plain-cloud-workspace',
      args: ['/workspace/plain-cloud-workspace'],
      timeout_seconds: 10,
      max_output_bytes: 4096,
    })
  })

  test('defaults missing additions and deletions to zero', () => {
    expect(parseGitShortStat('')).toEqual({ additions: '+0', deletions: '-0' })
  })

  test('parses pending file count from no-commit repos', () => {
    expect(parseGitShortStat(' 3 file(s) pending')).toEqual({
      additions: '+3',
      deletions: '-0',
    })
  })
})

describe('buildPullRequestUrl', () => {
  test('builds GitHub compare URL from https remote', () => {
    expect(
      buildPullRequestUrl(
        'https://github.com/wecode-ai/Wegent.git',
        'human/narwhal-20260528-073440'
      )
    ).toBe('https://github.com/wecode-ai/Wegent/compare/human%2Fnarwhal-20260528-073440?expand=1')
  })

  test('builds GitLab merge request URL from ssh remote', () => {
    expect(buildPullRequestUrl('git@gitlab.com:wecode-ai/Wegent.git', 'feature/context-info')).toBe(
      'https://gitlab.com/wecode-ai/Wegent/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature%2Fcontext-info'
    )
  })

  test('does not use the SSH transport port as the GitLab web port', () => {
    expect(
      buildPullRequestUrl(
        'ssh://git@gitlab.example.com:2222/wecode-ai/Wegent.git',
        'feature/context-info'
      )
    ).toBe(
      'https://gitlab.example.com/wecode-ai/Wegent/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature%2Fcontext-info'
    )
  })

  test('preserves an explicit HTTPS web port', () => {
    expect(
      buildPullRequestUrl(
        'https://gitlab.example.com:8443/wecode-ai/Wegent.git',
        'feature/context-info'
      )
    ).toBe(
      'https://gitlab.example.com:8443/wecode-ai/Wegent/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature%2Fcontext-info'
    )
  })
})

describe('workspaceHasUncommittedChanges', () => {
  test('detects pending tracked and untracked worktree changes', async () => {
    const executeCommand = vi.fn().mockResolvedValue({
      success: true,
      stdout: ' M src/App.tsx\n?? notes.md\n',
      stderr: '',
    })

    await expect(
      workspaceHasUncommittedChanges({ executeCommand }, 'device-123', '/workspace/worktrees/9/app')
    ).resolves.toBe(true)

    expect(executeCommand).toHaveBeenCalledWith('device-123', {
      command_key: 'git_status_porcelain',
      path: '/workspace/worktrees/9/app',
      timeout_seconds: 10,
      max_output_bytes: 65536,
    })
  })

  test('removes clean worktrees through the device command API', async () => {
    const executeCommand = vi.fn().mockResolvedValue({
      success: true,
      stdout: '',
      stderr: '',
    })

    await removeGitWorktree({ executeCommand }, 'device-123', '/workspace/worktrees/9/app')

    expect(executeCommand).toHaveBeenCalledWith('device-123', {
      command_key: 'git_worktree_remove',
      path: '/workspace/worktrees/9/app',
      args: ['/workspace/worktrees/9/app', '/workspace/worktrees/9/app'],
      timeout_seconds: 30,
      max_output_bytes: 8192,
    })
  })
})

describe('loadProjectEnvironment', () => {
  test('does not call gh or glab when PR/MR status is disabled', async () => {
    changeRequestStatusPreference.enabled = false
    const executeCommand = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        stdout: 'feature/change-request-status\n',
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: '',
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: '',
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: 'https://github.com/wecode-ai/Wegent.git\n',
        stderr: '',
      })

    const info = await loadProjectEnvironment(
      { executeCommand },
      null,
      {
        deviceId: 'local-device',
        path: '/workspace/Wegent',
      },
      { force: true }
    )

    expect(info.changeRequest).toBeUndefined()
    expect(info.createPullRequestUrl).toContain('/compare/feature%2Fchange-request-status')
    expect(executeCommand).not.toHaveBeenCalledWith(
      'local-device',
      expect.objectContaining({
        command_key: expect.stringMatching(/^git_(github_pull_requests|gitlab_merge_requests)$/),
      })
    )
  })

  test('loads the current GitHub pull request and check status from the local device', async () => {
    const executeCommand = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        stdout: 'feature/change-request-status\n',
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: '',
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: '',
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: 'https://github.com/wecode-ai/Wegent.git\n',
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: [
          {
            number: 2631,
            url: 'https://github.com/wecode-ai/Wegent/pull/2631',
            title: 'feat(wework): show pull request status',
            state: 'OPEN',
            isDraft: false,
            mergeable: 'CONFLICTING',
            mergeStateStatus: 'DIRTY',
            statusCheckRollup: [
              { status: 'COMPLETED', conclusion: 'SUCCESS' },
              { status: 'IN_PROGRESS', conclusion: '' },
            ],
          },
        ],
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: {
          data: {
            resource: {
              mergeQueueEntry: null,
            },
          },
        },
        stderr: '',
      })

    const info = await loadProjectEnvironment(
      { executeCommand },
      null,
      {
        deviceId: 'local-device',
        path: '/workspace/Wegent',
      },
      { force: true }
    )

    expect(info.changeRequest).toEqual({
      provider: 'github',
      state: 'found',
      changeRequest: {
        provider: 'github',
        number: 2631,
        url: 'https://github.com/wecode-ai/Wegent/pull/2631',
        title: 'feat(wework): show pull request status',
        state: 'open',
        draft: false,
        checks: 'pending',
        mergeability: 'conflicting',
        mergeQueue: 'not_queued',
      },
    })
    expect(executeCommand).toHaveBeenCalledWith('local-device', {
      command_key: 'git_github_pull_requests',
      path: '/workspace/Wegent',
      args: ['feature/change-request-status'],
      timeout_seconds: 20,
      max_output_bytes: 256 * 1024,
    })
    expect(executeCommand).toHaveBeenLastCalledWith('local-device', {
      command_key: 'git_github_pull_request_merge_queue',
      path: '/workspace/Wegent',
      args: ['-F', 'url=https://github.com/wecode-ai/Wegent/pull/2631'],
      timeout_seconds: 20,
      max_output_bytes: 64 * 1024,
    })
  })

  test('publishes a GitHub pull request before its merge queue lookup finishes', async () => {
    let resolveMergeQueue: (value: {
      success: boolean
      stdout: Record<string, unknown>
      stderr: string
    }) => void = () => {}
    const mergeQueueResult = new Promise<{
      success: boolean
      stdout: Record<string, unknown>
      stderr: string
    }>(resolve => {
      resolveMergeQueue = resolve
    })
    const executeCommand = vi.fn((_: string, data: { command_key: string }) => {
      if (data.command_key === 'git_branch') {
        return Promise.resolve({
          success: true,
          stdout: 'fix/fast-pr-status\n',
          stderr: '',
        })
      }
      if (data.command_key === 'git_remote_url') {
        return Promise.resolve({
          success: true,
          stdout: 'https://github.com/wecode-ai/Wegent.git\n',
          stderr: '',
        })
      }
      if (data.command_key === 'git_github_pull_requests') {
        return Promise.resolve({
          success: true,
          stdout: [
            {
              number: 2875,
              url: 'https://github.com/wecode-ai/Wegent/pull/2875',
              title: 'fix(executor): converge cancelled runtime turns',
              state: 'OPEN',
              isDraft: false,
              mergeable: 'MERGEABLE',
              mergeStateStatus: 'CLEAN',
              statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
            },
          ],
          stderr: '',
        })
      }
      if (data.command_key === 'git_github_pull_request_merge_queue') {
        return mergeQueueResult
      }
      return Promise.resolve({
        success: true,
        stdout: '',
        stderr: '',
      })
    })
    const onPartialInfo = vi.fn()
    const load = loadProjectEnvironment(
      { executeCommand },
      null,
      {
        deviceId: 'local-device',
        path: '/workspace/fast-pr-status',
      },
      { force: true, onPartialInfo }
    )

    await vi.waitFor(() => {
      expect(onPartialInfo).toHaveBeenCalledWith(
        expect.objectContaining({
          changeRequest: {
            provider: 'github',
            state: 'found',
            changeRequest: expect.objectContaining({
              number: 2875,
              mergeQueue: 'unknown',
            }),
          },
        })
      )
    })

    let settled = false
    void load.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    resolveMergeQueue({
      success: true,
      stdout: { data: { resource: { mergeQueueEntry: null } } },
      stderr: '',
    })

    await expect(load).resolves.toMatchObject({
      changeRequest: {
        provider: 'github',
        state: 'found',
        changeRequest: expect.objectContaining({
          number: 2875,
          mergeQueue: 'not_queued',
        }),
      },
    })
  })

  test('keeps a GitHub pull request pending while it is in the merge queue', async () => {
    const executeCommand = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        stdout: 'fix/merge-queue-status\n',
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: '',
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: '',
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: 'https://github.com/wecode-ai/Wegent.git\n',
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: [
          {
            number: 2779,
            url: 'https://github.com/wecode-ai/Wegent/pull/2779',
            title: 'fix(wework): stabilize paused streaming scroll',
            state: 'OPEN',
            isDraft: false,
            mergeable: 'MERGEABLE',
            mergeStateStatus: 'CLEAN',
            statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
          },
        ],
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: {
          data: {
            resource: {
              mergeQueueEntry: {
                id: 'merge-queue-entry',
              },
            },
          },
        },
        stderr: '',
      })

    const info = await loadProjectEnvironment(
      { executeCommand },
      null,
      {
        deviceId: 'local-device',
        path: '/workspace/Wegent',
      },
      { force: true }
    )

    expect(info.changeRequest?.changeRequest).toMatchObject({
      number: 2779,
      checks: 'success',
      mergeability: 'mergeable',
      mergeQueue: 'queued',
    })
  })

  test.each([
    ['STARTUP_FAILURE', 'failure'],
    ['STALE', 'failure'],
    ['WAITING', 'pending'],
  ] as const)('maps GitHub check status %s to %s', async (status, expected) => {
    const check =
      status === 'WAITING'
        ? { status, conclusion: '' }
        : { status: 'COMPLETED', conclusion: status }
    const executeCommand = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        stdout: 'feature/change-request-status\n',
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: '',
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: '',
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: 'https://github.com/wecode-ai/Wegent.git\n',
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: [
          {
            number: 2631,
            url: 'https://github.com/wecode-ai/Wegent/pull/2631',
            title: 'feat(wework): show pull request status',
            state: 'OPEN',
            isDraft: false,
            statusCheckRollup: [check],
          },
        ],
        stderr: '',
      })

    const info = await loadProjectEnvironment(
      { executeCommand },
      null,
      {
        deviceId: 'local-device',
        path: '/workspace/Wegent',
      },
      { force: true }
    )

    expect(info.changeRequest?.changeRequest?.checks).toBe(expected)
  })

  test('uses the latest GitHub run when an earlier run was cancelled', async () => {
    const executeCommand = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        stdout: 'feature/change-request-status\n',
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: '',
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: '',
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: 'https://github.com/wecode-ai/Wegent.git\n',
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: [
          {
            number: 2631,
            url: 'https://github.com/wecode-ai/Wegent/pull/2631',
            title: 'feat(wework): show pull request status',
            state: 'MERGED',
            isDraft: false,
            statusCheckRollup: [
              {
                name: 'Test Wework',
                workflowName: 'Tests',
                startedAt: '2026-08-14T06:19:55Z',
                status: 'COMPLETED',
                conclusion: 'CANCELLED',
              },
              {
                name: 'Test Summary',
                workflowName: 'Tests',
                startedAt: '2026-08-14T06:20:54Z',
                status: 'COMPLETED',
                conclusion: 'FAILURE',
              },
              {
                name: 'Test Wework',
                workflowName: 'Tests',
                startedAt: '2026-08-14T06:21:16Z',
                status: 'COMPLETED',
                conclusion: 'SUCCESS',
              },
              {
                name: 'Test Summary',
                workflowName: 'Tests',
                startedAt: '2026-08-14T06:25:46Z',
                status: 'COMPLETED',
                conclusion: 'SUCCESS',
              },
            ],
          },
        ],
        stderr: '',
      })

    const info = await loadProjectEnvironment(
      { executeCommand },
      null,
      {
        deviceId: 'local-device',
        path: '/workspace/Wegent',
      },
      { force: true }
    )

    expect(info.changeRequest?.changeRequest).toMatchObject({
      state: 'merged',
      checks: 'success',
      mergeability: 'unknown',
    })
  })

  test('keeps create request available when the provider CLI is unavailable', async () => {
    const executeCommand = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        stdout: 'feature/change-request-status\n',
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: '',
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: '',
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: 'git@gitlab.com:wecode-ai/Wegent.git\n',
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: false,
        stdout: '',
        stderr: 'glab: command not found',
        error: 'Command failed',
      })

    const info = await loadProjectEnvironment(
      { executeCommand },
      null,
      {
        deviceId: 'local-device',
        path: '/workspace/Wegent',
      },
      { force: true }
    )

    expect(info.changeRequest).toEqual({
      provider: 'gitlab',
      state: 'unavailable',
    })
    expect(info.createPullRequestUrl).toContain('/-/merge_requests/new?')
  })

  test('preserves the provider when the change request command rejects', async () => {
    const executeCommand = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        stdout: 'feature/change-request-status\n',
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: '',
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: '',
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: 'https://github.com/wecode-ai/Wegent.git\n',
        stderr: '',
      })
      .mockRejectedValueOnce(new Error('Device command transport unavailable'))

    const info = await loadProjectEnvironment(
      { executeCommand },
      null,
      {
        deviceId: 'local-device',
        path: '/workspace/Wegent',
      },
      { force: true }
    )

    expect(info.changeRequest).toEqual({
      provider: 'github',
      state: 'error',
    })
  })

  test('loads the current GitLab merge request and pipeline status', async () => {
    const executeCommand = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        stdout: 'feature/change-request-status\n',
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: '',
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: '',
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: 'git@gitlab.com:wecode-ai/Wegent.git\n',
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: [
          {
            iid: 42,
            web_url: 'https://gitlab.com/wecode-ai/Wegent/-/merge_requests/42',
            title: 'feat(wework): show merge request status',
            state: 'opened',
            draft: true,
            head_pipeline: { status: 'success' },
          },
        ],
        stderr: '',
      })

    const info = await loadProjectEnvironment(
      { executeCommand },
      null,
      {
        deviceId: 'local-device',
        path: '/workspace/Wegent',
      },
      { force: true }
    )

    expect(info.changeRequest).toEqual({
      provider: 'gitlab',
      state: 'found',
      changeRequest: {
        provider: 'gitlab',
        number: 42,
        url: 'https://gitlab.com/wecode-ai/Wegent/-/merge_requests/42',
        title: 'feat(wework): show merge request status',
        state: 'open',
        draft: true,
        checks: 'success',
        mergeability: 'unknown',
        mergeQueue: 'unknown',
      },
    })
  })

  test('resolves git checkout path to an absolute device workspace path', async () => {
    const executeCommand = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        stdout: '/workspace/projects\n',
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: 'human/full-path-20260609\n',
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: ' 1 file changed, 2 insertions(+), 1 deletion(-)',
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: '',
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: 'https://github.com/wecode-ai/Wegent.git\n',
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: [],
        stderr: '',
      })

    const info = await loadProjectEnvironment(
      { executeCommand },
      {
        id: 1,
        name: 'Wegent',
        config: {
          mode: 'workspace',
          execution: {
            targetType: 'local',
            deviceId: 'device-123',
          },
          workspace: {
            source: 'git',
            checkoutPath: 'directmessage_single',
          },
        },
      }
    )

    expect(info.additions).toBe('+2')
    expect(info.deletions).toBe('-1')
    expect(info.workspacePath).toBe('/workspace/projects/directmessage_single')
    expect(executeCommand).toHaveBeenNthCalledWith(1, 'device-123', {
      command_key: 'project_workspace_root',
      timeout_seconds: 10,
      max_output_bytes: 4096,
    })
    expect(executeCommand).toHaveBeenCalledWith('device-123', {
      command_key: 'git_branch_diff_shortstat',
      path: '/workspace/projects/directmessage_single',
      timeout_seconds: 10,
      max_output_bytes: 4096,
    })
  })

  test('loads git info through the selected project device command API', async () => {
    const executeCommand = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        stdout: 'human/narwhal-20260528-073440\n',
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: ' 2 files changed, 8 insertions(+), 3 deletions(-)',
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: '',
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: 'https://github.com/wecode-ai/Wegent.git\n',
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: [],
        stderr: '',
      })

    const info = await loadProjectEnvironment(
      { executeCommand },
      {
        id: 1,
        name: 'Wegent',
        config: {
          mode: 'workspace',
          execution: {
            targetType: 'cloud',
            deviceId: 'device-123',
          },
          workspace: {
            source: 'local_path',
            localPath: '/workspace/Wegent',
          },
        },
      }
    )

    expect(info).toEqual({
      executionTarget: 'cloud',
      deviceId: 'device-123',
      workspacePath: '/workspace/Wegent',
      isGitRepository: true,
      branchName: 'human/narwhal-20260528-073440',
      additions: '+8',
      deletions: '-3',
      createPullRequestUrl:
        'https://github.com/wecode-ai/Wegent/compare/human%2Fnarwhal-20260528-073440?expand=1',
      changeRequest: {
        provider: 'github',
        state: 'not_found',
      },
    })
    expect(executeCommand).toHaveBeenCalledWith('device-123', {
      command_key: 'git_branch',
      path: '/workspace/Wegent',
      timeout_seconds: 10,
      max_output_bytes: 4096,
    })
    expect(executeCommand).toHaveBeenCalledWith('device-123', {
      command_key: 'git_branch_diff_shortstat',
      path: '/workspace/Wegent',
      timeout_seconds: 10,
      max_output_bytes: 4096,
    })
  })

  test('loads git info from the active workspace target', async () => {
    const executeCommand = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        stdout: 'human/worktree-branch\n',
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: ' 1 file changed, 4 insertions(+)',
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: '',
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: 'https://github.com/wecode-ai/Wegent.git\n',
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: [],
        stderr: '',
      })

    const info = await loadProjectEnvironment(
      { executeCommand },
      {
        id: 1,
        name: 'Wegent',
        config: {
          mode: 'workspace',
          execution: {
            targetType: 'cloud',
            deviceId: 'project-device',
          },
          workspace: {
            source: 'local_path',
            localPath: '/workspace/Wegent',
          },
        },
      },
      {
        deviceId: 'runtime-device',
        path: '/workspace/worktrees/1029/Wegent',
        source: 'runtime',
      }
    )

    expect(info).toMatchObject({
      executionTarget: 'cloud',
      deviceId: 'runtime-device',
      branchName: 'human/worktree-branch',
      additions: '+4',
      deletions: '-0',
    })
    for (const commandKey of [
      'git_branch',
      'git_branch_diff_shortstat',
      'git_status_porcelain',
      'git_remote_url',
    ]) {
      expect(executeCommand).toHaveBeenCalledWith(
        'runtime-device',
        expect.objectContaining({
          command_key: commandKey,
          path: '/workspace/worktrees/1029/Wegent',
        })
      )
    }
  })

  test('surfaces structured stdout from text device commands as an environment error', async () => {
    const executeCommand = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        stdout: { branch: 'main' },
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: '',
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: '',
        stderr: '',
      })

    const info = await loadProjectEnvironment(
      { executeCommand },
      {
        id: 2,
        name: 'Wegent',
        config: {
          mode: 'workspace',
          execution: {
            targetType: 'local',
            deviceId: 'device-123',
          },
          workspace: {
            source: 'local_path',
            localPath: '/workspace/Wegent',
          },
        },
      }
    )

    expect(info).toEqual({
      additions: '+0',
      deletions: '-0',
      executionTarget: 'local',
      deviceId: 'device-123',
      workspacePath: '/workspace/Wegent',
      error: 'Expected text stdout from device command',
    })
  })

  test('does not surface an error when the workspace is not a git repository', async () => {
    const executeCommand = vi.fn().mockResolvedValue({
      success: false,
      stdout: '',
      stderr: 'fatal: not a git repository (or any of the parent directories): .git',
    })

    const info = await loadProjectEnvironment(
      { executeCommand },
      {
        id: 3,
        name: 'plain-workspace',
        config: {
          mode: 'workspace',
          execution: {
            targetType: 'local',
            deviceId: 'device-123',
          },
          workspace: {
            source: 'local_path',
            localPath: '/workspace/plain-workspace',
          },
        },
      }
    )

    expect(info).toEqual({
      additions: '+0',
      deletions: '-0',
      executionTarget: 'local',
      isGitRepository: false,
      deviceId: 'device-123',
      workspacePath: '/workspace/plain-workspace',
    })
  })

  test('preserves git command errors when the workspace is a repository', async () => {
    const executeCommand = vi.fn((_: string, data: { command_key: string }) => {
      if (data.command_key === 'git_branch') {
        return Promise.resolve({
          success: false,
          stdout: '',
          stderr: 'fatal: failed to read git metadata',
        })
      }
      if (data.command_key === 'git_is_worktree') {
        return Promise.resolve({
          success: true,
          stdout: 'true\n',
          stderr: '',
        })
      }
      return Promise.resolve({
        success: true,
        stdout: '',
        stderr: '',
      })
    })

    const info = await loadProjectEnvironment(
      { executeCommand },
      {
        id: 5,
        name: 'broken-repository',
        config: {
          mode: 'workspace',
          execution: {
            targetType: 'local',
            deviceId: 'device-123',
          },
          workspace: {
            source: 'local_path',
            localPath: '/workspace/broken-repository',
          },
        },
      }
    )

    expect(info).toMatchObject({
      deviceId: 'device-123',
      workspacePath: '/workspace/broken-repository',
      error: 'fatal: failed to read git metadata',
    })
    expect(info.isGitRepository).toBeUndefined()
  })

  test('deduplicates repeated environment loads for the same project briefly', async () => {
    const executeCommand = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        stdout: 'human/narwhal-20260528-073440\n',
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: ' 2 files changed, 8 insertions(+), 3 deletions(-)',
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: '',
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: 'https://github.com/wecode-ai/Wegent.git\n',
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: [],
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: 'human/narwhal-20260528-073440\n',
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: ' 3 files changed, 13 insertions(+), 5 deletions(-)',
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: '',
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: 'https://github.com/wecode-ai/Wegent.git\n',
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: [],
        stderr: '',
      })

    const api = { executeCommand }
    const project = {
      id: 1001,
      name: 'Wegent',
      config: {
        mode: 'workspace' as const,
        execution: {
          targetType: 'local' as const,
          deviceId: 'device-123',
        },
        workspace: {
          source: 'local_path' as const,
          localPath: '/workspace/Wegent',
        },
      },
    }

    const [firstInfo, secondInfo] = await Promise.all([
      loadProjectEnvironment(api, project),
      loadProjectEnvironment(api, project),
    ])

    expect(firstInfo).toEqual(secondInfo)
    expect(firstInfo).not.toBe(secondInfo)
    firstInfo.branchName = 'mutated'

    const cachedInfo = await loadProjectEnvironment(api, project)

    expect(cachedInfo.branchName).toBe('human/narwhal-20260528-073440')
    // 5 calls: branch, diff, status, remote, and the branch's pull request lookup.
    expect(executeCommand).toHaveBeenCalledTimes(5)
    expect(executeCommand).toHaveBeenCalledWith('device-123', {
      command_key: 'git_branch',
      path: '/workspace/Wegent',
      timeout_seconds: 10,
      max_output_bytes: 4096,
    })
    expect(executeCommand).toHaveBeenCalledWith('device-123', {
      command_key: 'git_branch_diff_shortstat',
      path: '/workspace/Wegent',
      timeout_seconds: 10,
      max_output_bytes: 4096,
    })
    expect(executeCommand).toHaveBeenCalledWith('device-123', {
      command_key: 'git_status_porcelain',
      path: '/workspace/Wegent',
      timeout_seconds: 10,
      max_output_bytes: 4096,
    })
    expect(executeCommand).toHaveBeenCalledWith('device-123', {
      command_key: 'git_remote_url',
      path: '/workspace/Wegent',
      timeout_seconds: 10,
      max_output_bytes: 4096,
    })

    const refreshedInfo = await loadProjectEnvironment(api, project, undefined, { force: true })

    expect(refreshedInfo).toMatchObject({ additions: '+13', deletions: '-5' })
    expect(executeCommand).toHaveBeenCalledTimes(10)
  })

  test('publishes stale environment info immediately while revalidating an expired cache', async () => {
    const initialNow = Date.now()
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(initialNow)
    let pullRequestLookupCount = 0
    let resolveRefreshedPullRequests: (value: {
      success: boolean
      stdout: unknown[]
      stderr: string
    }) => void = () => {}
    const refreshedPullRequests = new Promise<{
      success: boolean
      stdout: unknown[]
      stderr: string
    }>(resolve => {
      resolveRefreshedPullRequests = resolve
    })
    const executeCommand = vi.fn((_: string, data: { command_key: string }) => {
      if (data.command_key === 'git_branch') {
        return Promise.resolve({
          success: true,
          stdout: 'fix/cached-pr-status\n',
          stderr: '',
        })
      }
      if (data.command_key === 'git_remote_url') {
        return Promise.resolve({
          success: true,
          stdout: 'https://github.com/wecode-ai/Wegent.git\n',
          stderr: '',
        })
      }
      if (data.command_key === 'git_github_pull_requests') {
        pullRequestLookupCount += 1
        if (pullRequestLookupCount === 1) {
          return Promise.resolve({
            success: true,
            stdout: [
              {
                number: 2875,
                url: 'https://github.com/wecode-ai/Wegent/pull/2875',
                title: 'Cached pull request',
                state: 'CLOSED',
                isDraft: false,
                statusCheckRollup: [],
              },
            ],
            stderr: '',
          })
        }
        return refreshedPullRequests
      }
      return Promise.resolve({
        success: true,
        stdout: '',
        stderr: '',
      })
    })
    const api = { executeCommand }
    const target = {
      deviceId: 'local-device',
      path: '/workspace/cached-pr-status',
    }

    const initialInfo = await loadProjectEnvironment(api, null, target)
    expect(initialInfo.changeRequest?.changeRequest?.number).toBe(2875)

    dateNow.mockReturnValue(initialNow + 2000)
    const onPartialInfo = vi.fn()
    const refresh = loadProjectEnvironment(api, null, target, { onPartialInfo })

    expect(onPartialInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        branchName: 'fix/cached-pr-status',
        changeRequest: expect.objectContaining({
          state: 'found',
          changeRequest: expect.objectContaining({ number: 2875 }),
        }),
      })
    )

    let settled = false
    void refresh.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    resolveRefreshedPullRequests({
      success: true,
      stdout: [
        {
          number: 2876,
          url: 'https://github.com/wecode-ai/Wegent/pull/2876',
          title: 'Refreshed pull request',
          state: 'CLOSED',
          isDraft: false,
          statusCheckRollup: [],
        },
      ],
      stderr: '',
    })

    await expect(refresh).resolves.toMatchObject({
      changeRequest: {
        state: 'found',
        changeRequest: expect.objectContaining({ number: 2876 }),
      },
    })
    dateNow.mockRestore()
  })

  test('deduplicates a forced refresh while the current environment load is still pending', async () => {
    let resolveBranch: (value: {
      success: boolean
      stdout: string
      stderr: string
    }) => void = () => {}
    const branchResult = new Promise<{
      success: boolean
      stdout: string
      stderr: string
    }>(resolve => {
      resolveBranch = resolve
    })
    const executeCommand = vi.fn((_: string, data: { command_key: string }) => {
      if (data.command_key === 'git_branch') {
        return branchResult
      }
      if (data.command_key === 'git_remote_url') {
        return Promise.resolve({
          success: true,
          stdout: 'https://github.com/wecode-ai/Wegent.git\n',
          stderr: '',
        })
      }
      if (data.command_key === 'git_github_pull_requests') {
        return Promise.resolve({
          success: true,
          stdout: [],
          stderr: '',
        })
      }
      return Promise.resolve({
        success: true,
        stdout: '',
        stderr: '',
      })
    })
    const api = { executeCommand }
    const project = {
      id: 1002,
      name: 'Wegent',
      config: {
        mode: 'workspace' as const,
        execution: {
          targetType: 'local' as const,
          deviceId: 'device-123',
        },
        workspace: {
          source: 'local_path' as const,
          localPath: '/workspace/Wegent',
        },
      },
    }

    const initialLoad = loadProjectEnvironment(api, project)
    const forcedRefresh = loadProjectEnvironment(api, project, undefined, { force: true })

    await vi.waitFor(() => {
      expect(executeCommand).toHaveBeenCalledTimes(4)
    })

    resolveBranch({
      success: true,
      stdout: 'fix/environment-refresh\n',
      stderr: '',
    })

    const [initialInfo, refreshedInfo] = await Promise.all([initialLoad, forcedRefresh])

    expect(initialInfo).toEqual(refreshedInfo)
    expect(initialInfo.branchName).toBe('fix/environment-refresh')
    expect(executeCommand).toHaveBeenCalledTimes(5)
  })

  test('publishes pull request status before a slow branch diff finishes', async () => {
    let resolveShortStat: (value: {
      success: boolean
      stdout: string
      stderr: string
    }) => void = () => {}
    const shortStatResult = new Promise<{
      success: boolean
      stdout: string
      stderr: string
    }>(resolve => {
      resolveShortStat = resolve
    })
    const executeCommand = vi.fn((_: string, data: { command_key: string }) => {
      if (data.command_key === 'git_branch') {
        return Promise.resolve({
          success: true,
          stdout: 'fix/fast-pr-status\n',
          stderr: '',
        })
      }
      if (data.command_key === 'git_branch_diff_shortstat') {
        return shortStatResult
      }
      if (data.command_key === 'git_remote_url') {
        return Promise.resolve({
          success: true,
          stdout: 'https://github.com/wecode-ai/Wegent.git\n',
          stderr: '',
        })
      }
      if (data.command_key === 'git_github_pull_requests') {
        return Promise.resolve({
          success: true,
          stdout: [
            {
              number: 301,
              url: 'https://github.com/wecode-ai/Wegent/pull/301',
              title: 'fix(wework): show PR status immediately',
              state: 'OPEN',
              isDraft: false,
              statusCheckRollup: [],
              mergeable: 'MERGEABLE',
              mergeStateStatus: 'CLEAN',
            },
          ],
          stderr: '',
        })
      }
      if (data.command_key === 'git_github_pull_request_merge_queue') {
        return Promise.resolve({
          success: true,
          stdout: { data: { resource: { mergeQueueEntry: null } } },
          stderr: '',
        })
      }
      return Promise.resolve({
        success: true,
        stdout: '',
        stderr: '',
      })
    })
    const onPartialInfo = vi.fn()
    const load = loadProjectEnvironment(
      { executeCommand },
      {
        id: 1003,
        name: 'Wegent',
        config: {
          mode: 'workspace' as const,
          execution: {
            targetType: 'local' as const,
            deviceId: 'device-123',
          },
          workspace: {
            source: 'local_path' as const,
            localPath: '/workspace/Wegent',
          },
        },
      },
      undefined,
      { onPartialInfo }
    )

    await vi.waitFor(() => {
      expect(onPartialInfo).toHaveBeenCalledWith(
        expect.objectContaining({
          branchName: 'fix/fast-pr-status',
          changeRequest: expect.objectContaining({
            state: 'found',
            changeRequest: expect.objectContaining({ number: 301 }),
          }),
        })
      )
    })

    let settled = false
    void load.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    resolveShortStat({
      success: true,
      stdout: ' 2 files changed, 3 insertions(+), 1 deletion(-)',
      stderr: '',
    })

    await expect(load).resolves.toMatchObject({
      additions: '+3',
      deletions: '-1',
      changeRequest: expect.objectContaining({ state: 'found' }),
    })
  })

  test('publishes the branch before a slow pull request lookup finishes', async () => {
    let resolvePullRequests: (value: {
      success: boolean
      stdout: unknown[]
      stderr: string
    }) => void = () => {}
    const pullRequestsResult = new Promise<{
      success: boolean
      stdout: unknown[]
      stderr: string
    }>(resolve => {
      resolvePullRequests = resolve
    })
    const executeCommand = vi.fn((_: string, data: { command_key: string }) => {
      if (data.command_key === 'git_branch') {
        return Promise.resolve({
          success: true,
          stdout: 'fix/fast-branch-status\n',
          stderr: '',
        })
      }
      if (data.command_key === 'git_remote_url') {
        return Promise.resolve({
          success: true,
          stdout: 'https://github.com/wecode-ai/Wegent.git\n',
          stderr: '',
        })
      }
      if (data.command_key === 'git_github_pull_requests') {
        return pullRequestsResult
      }
      return Promise.resolve({
        success: true,
        stdout: '',
        stderr: '',
      })
    })
    const onPartialInfo = vi.fn()
    const load = loadProjectEnvironment(
      { executeCommand },
      {
        id: 1004,
        name: 'Wegent',
        config: {
          mode: 'workspace' as const,
          execution: {
            targetType: 'local' as const,
            deviceId: 'device-123',
          },
          workspace: {
            source: 'local_path' as const,
            localPath: '/workspace/Wegent',
          },
        },
      },
      undefined,
      { onPartialInfo }
    )

    await vi.waitFor(() => {
      expect(onPartialInfo).toHaveBeenCalledWith(
        expect.objectContaining({
          branchName: 'fix/fast-branch-status',
        })
      )
    })
    expect(onPartialInfo.mock.calls[0]?.[0]).not.toHaveProperty('changeRequest')

    let settled = false
    void load.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    resolvePullRequests({
      success: true,
      stdout: [],
      stderr: '',
    })

    await expect(load).resolves.toMatchObject({
      branchName: 'fix/fast-branch-status',
      changeRequest: expect.objectContaining({ state: 'not_found' }),
    })
  })

  test('uses git diff against HEAD for tracked uncommitted changes', async () => {
    const executeCommand = vi.fn((_: string, data: { command_key: string; args?: string[] }) => {
      if (data.command_key === 'git_branch') {
        return Promise.resolve({
          success: true,
          stdout: 'feature/context-info\n',
          stderr: '',
        })
      }

      if (data.command_key === 'git_branch_diff_shortstat') {
        return Promise.resolve({
          success: true,
          stdout: ' 1 file changed, 1 insertion(+), 1 deletion(-)',
          stderr: '',
        })
      }

      if (data.command_key === 'git_status_porcelain') {
        return Promise.resolve({
          success: true,
          stdout: '',
          stderr: '',
        })
      }

      if (data.command_key === 'git_remote_url') {
        return Promise.resolve({
          success: true,
          stdout: 'https://github.com/wecode-ai/Wegent.git\n',
          stderr: '',
        })
      }

      return Promise.resolve({
        success: false,
        stdout: '',
        stderr: 'unknown command',
      })
    })

    const info = await loadProjectEnvironment(
      { executeCommand },
      {
        id: 1,
        name: 'Wegent',
        config: {
          mode: 'workspace',
          execution: {
            targetType: 'local',
            deviceId: 'device-123',
          },
          workspace: {
            source: 'local_path',
            localPath: '/workspace/Wegent',
          },
        },
      }
    )

    expect(info.additions).toBe('+1')
    expect(info.deletions).toBe('-1')
    expect(executeCommand).toHaveBeenCalledWith('device-123', {
      command_key: 'git_branch_diff_shortstat',
      path: '/workspace/Wegent',
      timeout_seconds: 10,
      max_output_bytes: 4096,
    })
  })

  test('keeps shortstat line counts without counting untracked files as lines', async () => {
    const executeCommand = vi.fn((_: string, data: { command_key: string; args?: string[] }) => {
      if (data.command_key === 'git_branch') {
        return Promise.resolve({
          success: true,
          stdout: 'main\n',
          stderr: '',
        })
      }

      if (data.command_key === 'git_branch_diff_shortstat') {
        return Promise.resolve({
          success: true,
          stdout: ' 1 file changed, 5 insertions(+), 2 deletions(-)',
          stderr: '',
        })
      }

      if (data.command_key === 'git_status_porcelain') {
        return Promise.resolve({
          success: true,
          stdout: '?? output.txt\n?? notes.md\n',
          stderr: '',
        })
      }

      if (data.command_key === 'git_remote_url') {
        return Promise.resolve({
          success: false,
          stdout: '',
          stderr: 'No such remote',
        })
      }

      return Promise.resolve({
        success: false,
        stdout: '',
        stderr: 'unknown command',
      })
    })

    const info = await loadProjectEnvironment(
      { executeCommand },
      {
        id: 1,
        name: 'Wegent',
        config: {
          mode: 'workspace',
          execution: {
            targetType: 'local',
            deviceId: 'device-123',
          },
          workspace: {
            source: 'local_path',
            localPath: '/workspace/Wegent',
          },
        },
      }
    )

    // 5 tracked insertions; untracked files are files, not lines.
    expect(info.additions).toBe('+5')
    expect(info.deletions).toBe('-2')
    expect(info.branchName).toBe('main')
  })

  test('counts pending files from porcelain when repo has no commits', async () => {
    const executeCommand = vi.fn((_: string, data: { command_key: string; args?: string[] }) => {
      if (data.command_key === 'git_branch') {
        return Promise.resolve({
          success: true,
          stdout: 'master\n',
          stderr: '',
        })
      }

      if (data.command_key === 'git_branch_diff_shortstat') {
        return Promise.resolve({
          success: false,
          stdout: '',
          stderr: "fatal: bad revision 'HEAD'",
        })
      }

      if (data.command_key === 'git_status_porcelain') {
        return Promise.resolve({
          success: true,
          stdout: '?? output.txt\n',
          stderr: '',
        })
      }

      if (data.command_key === 'git_remote_url') {
        return Promise.resolve({
          success: false,
          stdout: '',
          stderr: 'No such remote',
        })
      }

      return Promise.resolve({
        success: false,
        stdout: '',
        stderr: 'unknown command',
      })
    })

    const info = await loadProjectEnvironment(
      { executeCommand },
      {
        id: 2,
        name: 'empty-repo',
        config: {
          mode: 'workspace',
          execution: {
            targetType: 'local',
            deviceId: 'device-123',
          },
          workspace: {
            source: 'local_path',
            localPath: '/Volumes/OuterHD/Documents/test-porject',
          },
        },
      }
    )

    expect(info.additions).toBe('+1')
    expect(info.deletions).toBe('-0')
    expect(info.branchName).toBe('master')
    expect(info.error).toBeUndefined()
    expect(executeCommand).toHaveBeenCalledWith('device-123', {
      command_key: 'git_status_porcelain',
      path: '/Volumes/OuterHD/Documents/test-porject',
      timeout_seconds: 10,
      max_output_bytes: 4096,
    })
  })

  test('keeps an empty shortstat for a committed repo with only untracked files', async () => {
    const executeCommand = vi.fn((_: string, data: { command_key: string }) => {
      if (data.command_key === 'git_branch') {
        return Promise.resolve({ success: true, stdout: 'main\n', stderr: '' })
      }
      if (data.command_key === 'git_branch_diff_shortstat') {
        return Promise.resolve({ success: true, stdout: '', stderr: '' })
      }
      if (data.command_key === 'git_status_porcelain') {
        return Promise.resolve({ success: true, stdout: '?? output.txt\n', stderr: '' })
      }
      return Promise.resolve({ success: false, stdout: '', stderr: 'unknown command' })
    })

    const info = await loadProjectEnvironment(
      { executeCommand },
      {
        id: 1,
        name: 'Wegent',
        config: {
          mode: 'workspace',
          execution: { targetType: 'local', deviceId: 'device-123' },
          workspace: { source: 'local_path', localPath: '/workspace/Wegent' },
        },
      }
    )

    // Untracked files are not lines; an empty shortstat on a committed repo
    // must stay +0 instead of falling back to the porcelain file count.
    expect(info.additions).toBe('+0')
    expect(info.deletions).toBe('-0')
  })

  test('does not count porcelain files when shortstat fails on a committed repo', async () => {
    const executeCommand = vi.fn((_: string, data: { command_key: string }) => {
      if (data.command_key === 'git_branch') {
        return Promise.resolve({ success: true, stdout: 'main\n', stderr: '' })
      }
      if (data.command_key === 'git_branch_diff_shortstat') {
        return Promise.resolve({
          success: false,
          stdout: '',
          stderr: 'fatal: repository error',
        })
      }
      if (data.command_key === 'git_status_porcelain') {
        return Promise.resolve({ success: true, stdout: ' M tracked.txt\n', stderr: '' })
      }
      return Promise.resolve({ success: false, stdout: '', stderr: 'unknown command' })
    })

    const info = await loadProjectEnvironment(
      { executeCommand },
      {
        id: 1,
        name: 'Wegent',
        config: {
          mode: 'workspace',
          execution: { targetType: 'local', deviceId: 'device-123' },
          workspace: { source: 'local_path', localPath: '/workspace/Wegent' },
        },
      }
    )

    // Porcelain entries with tracked modifications prove a commit baseline
    // exists, so the shortstat failure must not be replaced by file counts.
    expect(info.additions).toBe('+0')
    expect(info.deletions).toBe('-0')
  })

  test('shows zero diff when repo is clean and has no untracked files', async () => {
    const executeCommand = vi.fn((_: string, data: { command_key: string; args?: string[] }) => {
      if (data.command_key === 'git_branch') {
        return Promise.resolve({
          success: true,
          stdout: 'main\n',
          stderr: '',
        })
      }

      if (data.command_key === 'git_branch_diff_shortstat') {
        return Promise.resolve({
          success: false,
          stdout: '',
          stderr: "fatal: bad revision 'HEAD'",
        })
      }

      if (data.command_key === 'git_status_porcelain') {
        return Promise.resolve({
          success: true,
          stdout: '',
          stderr: '',
        })
      }

      if (data.command_key === 'git_remote_url') {
        return Promise.resolve({
          success: false,
          stdout: '',
          stderr: 'No such remote',
        })
      }

      return Promise.resolve({
        success: false,
        stdout: '',
        stderr: 'unknown command',
      })
    })

    const info = await loadProjectEnvironment(
      { executeCommand },
      {
        id: 3,
        name: 'clean-repo',
        config: {
          mode: 'workspace',
          execution: {
            targetType: 'local',
            deviceId: 'device-123',
          },
          workspace: {
            source: 'local_path',
            localPath: '/tmp/clean-repo',
          },
        },
      }
    )

    expect(info.additions).toBe('+0')
    expect(info.deletions).toBe('-0')
    expect(info.error).toBeUndefined()
  })
})

describe('commitProjectChanges', () => {
  test('loads the full environment diff through the project device command API', async () => {
    const executeCommand = vi.fn().mockResolvedValue({
      success: true,
      stdout: 'diff --git a/src/env.ts b/src/env.ts\n+new\n',
      stderr: '',
    })

    await expect(
      loadProjectEnvironmentDiff(
        { executeCommand },
        {
          id: 1,
          name: 'Wegent',
          config: {
            mode: 'workspace',
            execution: {
              targetType: 'local',
              deviceId: 'device-123',
            },
            workspace: {
              source: 'local_path',
              localPath: '/workspace/Wegent',
            },
          },
        }
      )
    ).resolves.toBe('diff --git a/src/env.ts b/src/env.ts\n+new')

    expect(executeCommand).toHaveBeenCalledWith('device-123', {
      command_key: 'git_branch_diff',
      path: '/workspace/Wegent',
      timeout_seconds: 30,
      max_output_bytes: 5 * 1024 * 1024,
    })
  })

  test('loads the full environment diff from the active workspace target', async () => {
    const executeCommand = vi.fn().mockResolvedValue({
      success: true,
      stdout: '',
      stderr: '',
    })

    await expect(
      loadProjectEnvironmentDiff(
        { executeCommand },
        {
          id: 1,
          name: 'Wegent',
          config: {
            mode: 'workspace',
            execution: {
              targetType: 'local',
              deviceId: 'device-123',
            },
            workspace: {
              source: 'local_path',
              localPath: '/workspace/Wegent',
            },
          },
        },
        {
          deviceId: 'device-123',
          path: '/workspace/worktrees/1029/Wegent',
        }
      )
    ).resolves.toBe('')

    expect(executeCommand).toHaveBeenCalledWith('device-123', {
      command_key: 'git_branch_diff',
      path: '/workspace/worktrees/1029/Wegent',
      timeout_seconds: 30,
      max_output_bytes: 5 * 1024 * 1024,
    })
  })

  test('stages all changes and commits with the provided message', async () => {
    const executeCommand = vi
      .fn()
      .mockResolvedValueOnce({ success: true, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ success: true, stdout: '[main abc123] update\n', stderr: '' })

    await commitProjectChanges(
      { executeCommand },
      {
        id: 1,
        name: 'Wegent',
        config: {
          mode: 'workspace',
          execution: {
            targetType: 'local',
            deviceId: 'device-123',
          },
          workspace: {
            source: 'local_path',
            localPath: '/workspace/Wegent',
          },
        },
      },
      'feat: update environment info'
    )

    expect(executeCommand).toHaveBeenNthCalledWith(1, 'device-123', {
      command_key: 'git_add_all',
      path: '/workspace/Wegent',
      timeout_seconds: 30,
      max_output_bytes: 4096,
    })
    expect(executeCommand).toHaveBeenNthCalledWith(2, 'device-123', {
      command_key: 'git_commit',
      path: '/workspace/Wegent',
      args: ['-m', 'feat: update environment info'],
      timeout_seconds: 30,
      max_output_bytes: 8192,
    })
  })

  test('stages and commits changes in the active workspace target', async () => {
    const executeCommand = vi
      .fn()
      .mockResolvedValueOnce({ success: true, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ success: true, stdout: '[main abc123] update\n', stderr: '' })

    await commitProjectChanges(
      { executeCommand },
      {
        id: 1,
        name: 'Wegent',
        config: {
          mode: 'workspace',
          execution: {
            targetType: 'local',
            deviceId: 'project-device',
          },
          workspace: {
            source: 'local_path',
            localPath: '/workspace/Wegent',
          },
        },
      },
      'feat: update environment info',
      {
        deviceId: 'runtime-device',
        path: '/workspace/worktrees/1029/Wegent',
        source: 'runtime',
      }
    )

    expect(executeCommand).toHaveBeenNthCalledWith(1, 'runtime-device', {
      command_key: 'git_add_all',
      path: '/workspace/worktrees/1029/Wegent',
      timeout_seconds: 30,
      max_output_bytes: 4096,
    })
    expect(executeCommand).toHaveBeenNthCalledWith(2, 'runtime-device', {
      command_key: 'git_commit',
      path: '/workspace/worktrees/1029/Wegent',
      args: ['-m', 'feat: update environment info'],
      timeout_seconds: 30,
      max_output_bytes: 8192,
    })
  })

  test('generates a commit message before committing when the provided message is empty', async () => {
    const executeCommand = vi
      .fn()
      .mockResolvedValueOnce({ success: true, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ success: true, stdout: 'diff --git a/src/env.ts b/src/env.ts\n' })
      .mockResolvedValueOnce({
        success: true,
        stdout: { success: true, message: 'feat: update environment info' },
        stderr: '',
      })
      .mockResolvedValueOnce({ success: true, stdout: '[main abc123] update\n', stderr: '' })

    await commitProjectChanges(
      { executeCommand },
      {
        id: 1,
        name: 'Wegent',
        config: {
          mode: 'workspace',
          execution: { targetType: 'local', deviceId: 'device-123' },
          workspace: { source: 'local_path', localPath: '/workspace/Wegent' },
        },
      },
      '   '
    )

    expect(executeCommand).toHaveBeenNthCalledWith(1, 'device-123', {
      command_key: 'git_add_all',
      path: '/workspace/Wegent',
      timeout_seconds: 30,
      max_output_bytes: 4096,
    })
    expect(executeCommand).toHaveBeenNthCalledWith(2, 'device-123', {
      command_key: 'git_diff_staged',
      path: '/workspace/Wegent',
      timeout_seconds: 30,
      max_output_bytes: 4096,
    })
    expect(executeCommand).toHaveBeenNthCalledWith(3, 'device-123', {
      command_key: 'git_generate_commit_message',
      path: '/workspace/Wegent',
      timeout_seconds: 120,
      max_output_bytes: 8192,
    })
    expect(executeCommand).toHaveBeenNthCalledWith(4, 'device-123', {
      command_key: 'git_commit',
      path: '/workspace/Wegent',
      args: ['-m', 'feat: update environment info'],
      timeout_seconds: 30,
      max_output_bytes: 8192,
    })
  })

  test('does not ask AI for a message when staging leaves no changes', async () => {
    const executeCommand = vi
      .fn()
      .mockResolvedValueOnce({ success: true, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ success: true, stdout: '', stderr: '' })

    await expect(
      commitProjectChanges(
        { executeCommand },
        {
          id: 1,
          name: 'Wegent',
          config: {
            mode: 'workspace',
            execution: { targetType: 'local', deviceId: 'device-123' },
            workspace: { source: 'local_path', localPath: '/workspace/Wegent' },
          },
        },
        ''
      )
    ).rejects.toThrow('No changes to commit')

    expect(executeCommand).toHaveBeenCalledTimes(2)
    expect(executeCommand).not.toHaveBeenCalledWith(
      'device-123',
      expect.objectContaining({ command_key: 'git_generate_commit_message' })
    )
  })

  test('rejects invalid generated commit messages before running git commit', async () => {
    const executeCommand = vi
      .fn()
      .mockResolvedValueOnce({ success: true, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ success: true, stdout: 'diff --git a/src/env.ts b/src/env.ts\n' })
      .mockResolvedValueOnce({
        success: true,
        stdout: { success: false, error: 'Codex auth is missing' },
        stderr: '',
      })

    await expect(
      commitProjectChanges(
        { executeCommand },
        {
          id: 1,
          name: 'Wegent',
          config: {
            mode: 'workspace',
            execution: { targetType: 'local', deviceId: 'device-123' },
            workspace: { source: 'local_path', localPath: '/workspace/Wegent' },
          },
        },
        ''
      )
    ).rejects.toThrow('Codex auth is missing')

    expect(executeCommand).toHaveBeenCalledTimes(3)
  })
})

describe('pushProjectChanges', () => {
  const project = {
    id: 1,
    name: 'Wegent',
    config: {
      mode: 'workspace',
      execution: { targetType: 'local' as const, deviceId: 'device-123' },
      workspace: { source: 'local_path' as const, localPath: '/workspace/Wegent' },
    },
  }

  test('pushes the current branch through the project device command API', async () => {
    const executeCommand = vi.fn().mockResolvedValue({
      success: true,
      stdout: 'Everything up-to-date\n',
      stderr: '',
    })

    await pushProjectChanges({ executeCommand }, project)

    expect(executeCommand).toHaveBeenCalledWith('device-123', {
      command_key: 'git_push',
      path: '/workspace/Wegent',
      timeout_seconds: 120,
      max_output_bytes: 8192,
    })
  })

  test('commits and then pushes changes', async () => {
    const executeCommand = vi
      .fn()
      .mockResolvedValueOnce({ success: true, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ success: true, stdout: '[main abc123] update\n', stderr: '' })
      .mockResolvedValueOnce({ success: true, stdout: 'pushed\n', stderr: '' })

    await commitAndPushProjectChanges({ executeCommand }, project, 'feat: update environment info')

    expect(executeCommand).toHaveBeenNthCalledWith(1, 'device-123', {
      command_key: 'git_add_all',
      path: '/workspace/Wegent',
      timeout_seconds: 30,
      max_output_bytes: 4096,
    })
    expect(executeCommand).toHaveBeenNthCalledWith(2, 'device-123', {
      command_key: 'git_commit',
      path: '/workspace/Wegent',
      args: ['-m', 'feat: update environment info'],
      timeout_seconds: 30,
      max_output_bytes: 8192,
    })
    expect(executeCommand).toHaveBeenNthCalledWith(3, 'device-123', {
      command_key: 'git_push',
      path: '/workspace/Wegent',
      timeout_seconds: 120,
      max_output_bytes: 8192,
    })
  })
})

describe('branch environment commands', () => {
  const project = {
    id: 1,
    name: 'Wegent',
    config: {
      mode: 'workspace',
      execution: { targetType: 'local' as const, deviceId: 'device-123' },
      workspace: { source: 'local_path' as const, localPath: '/workspace/Wegent' },
    },
  }

  test('lists branches with the current branch first', async () => {
    const executeCommand = vi.fn().mockImplementation(async (_deviceId, data) => {
      if (data.command_key === 'git_branch_list') {
        return {
          success: true,
          stdout: 'human/zebra\nmain\nhuman/alpaca\n',
          stderr: '',
        }
      }
      if (data.command_key === 'git_branch') {
        return { success: true, stdout: 'human/zebra\n', stderr: '' }
      }
      return { success: false, stdout: '', stderr: 'unexpected command' }
    })

    await expect(listProjectBranches({ executeCommand }, project)).resolves.toEqual([
      'human/zebra',
      'main',
      'human/alpaca',
    ])
    expect(executeCommand).toHaveBeenNthCalledWith(1, 'device-123', {
      command_key: 'git_branch_list',
      path: '/workspace/Wegent',
      timeout_seconds: 15,
      max_output_bytes: 1024 * 64,
    })
    expect(executeCommand).toHaveBeenNthCalledWith(2, 'device-123', {
      command_key: 'git_branch',
      path: '/workspace/Wegent',
      timeout_seconds: 10,
      max_output_bytes: 4096,
    })
  })

  test('runs branch commands in the active workspace target', async () => {
    const executeCommand = vi.fn().mockImplementation(async (_deviceId, data) => {
      if (data.command_key === 'git_branch_list') {
        return {
          success: true,
          stdout: 'main\n',
          stderr: '',
        }
      }
      if (data.command_key === 'git_branch') {
        return { success: true, stdout: 'main\n', stderr: '' }
      }
      return { success: true, stdout: '', stderr: '' }
    })
    const target = {
      deviceId: 'runtime-device',
      path: '/workspace/worktrees/1029/Wegent',
      source: 'runtime' as const,
    }

    await expect(listProjectBranches({ executeCommand }, project, target)).resolves.toEqual([
      'main',
    ])
    await checkoutProjectBranch({ executeCommand }, project, 'human/alpaca', target)
    await createAndCheckoutProjectBranch({ executeCommand }, project, 'human/new-branch', target)

    expect(executeCommand).toHaveBeenNthCalledWith(1, 'runtime-device', {
      command_key: 'git_branch_list',
      path: '/workspace/worktrees/1029/Wegent',
      timeout_seconds: 15,
      max_output_bytes: 1024 * 64,
    })
    expect(executeCommand).toHaveBeenNthCalledWith(2, 'runtime-device', {
      command_key: 'git_branch',
      path: '/workspace/worktrees/1029/Wegent',
      timeout_seconds: 10,
      max_output_bytes: 4096,
    })
    expect(executeCommand).toHaveBeenNthCalledWith(3, 'runtime-device', {
      command_key: 'git_checkout',
      path: '/workspace/worktrees/1029/Wegent',
      args: ['human/alpaca'],
      timeout_seconds: 30,
      max_output_bytes: 8192,
    })
    expect(executeCommand).toHaveBeenNthCalledWith(4, 'runtime-device', {
      command_key: 'git_checkout_new',
      path: '/workspace/worktrees/1029/Wegent',
      args: ['human/new-branch'],
      timeout_seconds: 30,
      max_output_bytes: 8192,
    })
  })

  test('checks out an existing branch', async () => {
    const executeCommand = vi.fn().mockResolvedValue({ success: true, stdout: '', stderr: '' })

    await checkoutProjectBranch({ executeCommand }, project, 'human/alpaca')

    expect(executeCommand).toHaveBeenCalledWith('device-123', {
      command_key: 'git_checkout',
      path: '/workspace/Wegent',
      args: ['human/alpaca'],
      timeout_seconds: 30,
      max_output_bytes: 8192,
    })
  })

  test('creates and checks out a new branch', async () => {
    const executeCommand = vi.fn().mockResolvedValue({ success: true, stdout: '', stderr: '' })

    await createAndCheckoutProjectBranch({ executeCommand }, project, 'human/new-branch')

    expect(executeCommand).toHaveBeenCalledWith('device-123', {
      command_key: 'git_checkout_new',
      path: '/workspace/Wegent',
      args: ['human/new-branch'],
      timeout_seconds: 30,
      max_output_bytes: 8192,
    })
  })

  test('rejects invalid branch names before running checkout commands', async () => {
    const executeCommand = vi.fn()

    await expect(checkoutProjectBranch({ executeCommand }, project, '-bad')).rejects.toThrow(
      'Invalid branch name'
    )
    await expect(
      createAndCheckoutProjectBranch({ executeCommand }, project, 'feature/bad..name')
    ).rejects.toThrow('Invalid branch name')

    expect(executeCommand).not.toHaveBeenCalled()
  })
})
