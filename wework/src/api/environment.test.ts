import { describe, expect, test, vi } from 'vitest'
import {
  buildPullRequestUrl,
  checkoutProjectBranch,
  commitProjectChanges,
  createAndCheckoutProjectBranch,
  listProjectBranches,
  loadProjectEnvironment,
  parseGitShortStat,
} from './environment'

describe('parseGitShortStat', () => {
  test('extracts additions and deletions from git shortstat output', () => {
    expect(parseGitShortStat(' 10 files changed, 173 insertions(+), 13366 deletions(-)')).toEqual({
      additions: '+173',
      deletions: '-13366',
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
        'human/narwhal-20260528-073440',
      ),
    ).toBe('https://github.com/wecode-ai/Wegent/compare/human%2Fnarwhal-20260528-073440?expand=1')
  })

  test('builds GitLab merge request URL from ssh remote', () => {
    expect(
      buildPullRequestUrl('git@gitlab.com:wecode-ai/Wegent.git', 'feature/context-info'),
    ).toBe(
      'https://gitlab.com/wecode-ai/Wegent/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature%2Fcontext-info',
    )
  })
})

describe('loadProjectEnvironment', () => {
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
      },
    )

    expect(info.additions).toBe('+2')
    expect(info.deletions).toBe('-1')
    expect(executeCommand).toHaveBeenNthCalledWith(1, 'device-123', {
      command_key: 'project_workspace_root',
      timeout_seconds: 10,
      max_output_bytes: 4096,
    })
    expect(executeCommand).toHaveBeenCalledWith('device-123', {
      command_key: 'git_diff_shortstat',
      path: '/workspace/projects/directmessage_single',
      args: ['HEAD', '--'],
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
      },
    )

    expect(info).toEqual({
      executionTarget: 'cloud',
      deviceId: 'device-123',
      branchName: 'human/narwhal-20260528-073440',
      additions: '+8',
      deletions: '-3',
      createPullRequestUrl:
        'https://github.com/wecode-ai/Wegent/compare/human%2Fnarwhal-20260528-073440?expand=1',
    })
    expect(executeCommand).toHaveBeenCalledWith('device-123', {
      command_key: 'git_branch',
      path: '/workspace/Wegent',
      timeout_seconds: 10,
      max_output_bytes: 4096,
    })
    expect(executeCommand).toHaveBeenCalledWith('device-123', {
      command_key: 'git_diff_shortstat',
      path: '/workspace/Wegent',
      args: ['HEAD', '--'],
      timeout_seconds: 10,
      max_output_bytes: 4096,
    })
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
      },
    )

    expect(info).toEqual({
      additions: '+0',
      deletions: '-0',
      executionTarget: 'local',
      deviceId: 'device-123',
      error: 'Expected text stdout from device command',
    })
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
    // 4 calls: git_branch, git_diff_shortstat, git_status_porcelain, git_remote_url
    expect(executeCommand).toHaveBeenCalledTimes(4)
    expect(executeCommand).toHaveBeenCalledWith('device-123', {
      command_key: 'git_branch',
      path: '/workspace/Wegent',
      timeout_seconds: 10,
      max_output_bytes: 4096,
    })
    expect(executeCommand).toHaveBeenCalledWith('device-123', {
      command_key: 'git_diff_shortstat',
      path: '/workspace/Wegent',
      args: ['HEAD', '--'],
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

      if (data.command_key === 'git_diff_shortstat') {
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
      },
    )

    expect(info.additions).toBe('+1')
    expect(info.deletions).toBe('-1')
    expect(executeCommand).toHaveBeenCalledWith('device-123', {
      command_key: 'git_diff_shortstat',
      path: '/workspace/Wegent',
      args: ['HEAD', '--'],
      timeout_seconds: 10,
      max_output_bytes: 4096,
    })
  })

  test('adds untracked file count to diff additions', async () => {
    const executeCommand = vi.fn((_: string, data: { command_key: string; args?: string[] }) => {
      if (data.command_key === 'git_branch') {
        return Promise.resolve({
          success: true,
          stdout: 'main\n',
          stderr: '',
        })
      }

      if (data.command_key === 'git_diff_shortstat') {
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
      },
    )

    // 5 tracked insertions + 2 untracked files = +7
    expect(info.additions).toBe('+7')
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

      if (data.command_key === 'git_diff_shortstat') {
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
      },
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

  test('shows zero diff when repo is clean and has no untracked files', async () => {
    const executeCommand = vi.fn((_: string, data: { command_key: string; args?: string[] }) => {
      if (data.command_key === 'git_branch') {
        return Promise.resolve({
          success: true,
          stdout: 'main\n',
          stderr: '',
        })
      }

      if (data.command_key === 'git_diff_shortstat') {
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
      },
    )

    expect(info.additions).toBe('+0')
    expect(info.deletions).toBe('-0')
    expect(info.error).toBeUndefined()
  })
})

describe('commitProjectChanges', () => {
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
      'feat: update environment info',
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

  test('rejects an empty commit message before calling the device', async () => {
    const executeCommand = vi.fn()

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
        '   ',
      ),
    ).rejects.toThrow('Commit message is required')

    expect(executeCommand).not.toHaveBeenCalled()
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

  test('lists branches sorted by name', async () => {
    const executeCommand = vi.fn().mockResolvedValue({
      success: true,
      stdout: 'human/zebra\nmain\nhuman/alpaca\n',
      stderr: '',
    })

    await expect(listProjectBranches({ executeCommand }, project)).resolves.toEqual([
      'human/alpaca',
      'human/zebra',
      'main',
    ])
    expect(executeCommand).toHaveBeenCalledWith('device-123', {
      command_key: 'git_branch_list',
      path: '/workspace/Wegent',
      timeout_seconds: 15,
      max_output_bytes: 1024 * 64,
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
      'Invalid branch name',
    )
    await expect(
      createAndCheckoutProjectBranch({ executeCommand }, project, 'feature/bad..name'),
    ).rejects.toThrow('Invalid branch name')

    expect(executeCommand).not.toHaveBeenCalled()
  })
})
