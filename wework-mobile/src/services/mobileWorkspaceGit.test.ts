import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installReactNativeAbortGlobals } from '../../test/reactNativeAbortController'
import type { WorkspaceGitSelection } from '@/types/workspaceGit'
import { RuntimeApi } from './runtimeApi'
import { loadMobileWorkspaceChanges, WorkspaceNotGitRepositoryError } from './mobileWorkspaceGit'

const config = {
  apiBaseUrl: 'https://example.com/api',
  backendUrl: 'https://example.com',
  socketBaseUrl: 'https://example.com',
  socketPath: '/socket.io',
  accessToken: 'test-token',
}
const target = {
  deviceId: 'cloud/selected',
  path: '/worktrees/selected/repo',
  taskId: 'task-a',
  workspaceSource: 'remote',
}
const patch = [
  'diff --git a/src/file.ts b/src/file.ts',
  '--- a/src/file.ts',
  '+++ b/src/file.ts',
  '@@ -1 +1,2 @@',
  '-old',
  '+new',
  '+second',
  '',
].join('\n')
const response = (stdout: unknown, extra: Record<string, unknown> = {}) => ({
  success: true,
  exit_code: 0,
  stdout,
  stderr: '',
  ...extra,
})
afterEach(() => vi.unstubAllGlobals())
beforeEach(installReactNativeAbortGlobals)

describe('Mobile uses the PC cloud runtime command transport', () => {
  it.each([
    [{ mode: 'branch' }, 'git_branch_diff'],
    [{ mode: 'unstaged' }, 'git_diff_unstaged'],
    [{ mode: 'staged' }, 'git_diff_staged'],
    [{ mode: 'commit' }, 'git_diff_last_commit'],
  ] as const)(
    'routes %j through the existing command key with exact scope and cancellation',
    async (selection, key) => {
      const fetch = vi.fn()
      vi.stubGlobal('fetch', fetch)
      const commands = {
        request: vi.fn(),
        executeCommand: vi.fn().mockResolvedValue(response(patch)),
      }
      const controller = new AbortController()
      const api = new RuntimeApi(config, undefined, undefined, commands)
      await expect(
        api.getWorkspaceGitDiff(target.deviceId, target.path, selection, controller.signal)
      ).resolves.toBe(patch.trim())
      expect(commands.executeCommand).toHaveBeenCalledExactlyOnceWith(
        target.deviceId,
        {
          command_key: key,
          path: target.path,
          timeout_seconds: 30,
          max_output_bytes: 5 * 1024 * 1024,
        },
        controller.signal
      )
      expect(fetch).not.toHaveBeenCalled()
    }
  )

  it('rejects unknown modes, relative paths and empty device identities before transport', async () => {
    const commands = { request: vi.fn(), executeCommand: vi.fn() }
    const api = new RuntimeApi(config, undefined, undefined, commands)
    await expect(
      api.getWorkspaceGitDiff('cloud', '/repo', {
        mode: 'invalid',
      } as unknown as WorkspaceGitSelection)
    ).rejects.toThrow('Invalid Git diff mode')
    await expect(api.getWorkspaceGitDiff('cloud', 'repo', { mode: 'branch' })).rejects.toThrow(
      'absolute'
    )
    await expect(api.getWorkspaceGitBranch(' ', '/repo')).rejects.toThrow('device is required')
    expect(commands.executeCommand).not.toHaveBeenCalled()
  })

  it('normalizes Windows workspace paths without changing the owning execution target', async () => {
    const commands = {
      request: vi.fn(),
      executeCommand: vi.fn().mockResolvedValue(response('main\n')),
    }
    await new RuntimeApi(config, undefined, undefined, commands).getWorkspaceGitBranch(
      'execution-target',
      'c:\\worktrees\\repo'
    )
    expect(commands.executeCommand).toHaveBeenCalledWith(
      'execution-target',
      {
        command_key: 'git_branch',
        path: 'C:/worktrees/repo',
        timeout_seconds: 10,
        max_output_bytes: 4096,
      },
      undefined
    )
  })

  it('does not replace an unavailable runtime connection with an HTTP command request', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(
      new RuntimeApi(config).getWorkspaceGitBranch(target.deviceId, target.path)
    ).rejects.toThrow('Runtime command connection is unavailable')
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    [{ success: false, error: 'device offline' }, 'device offline'],
    [{ success: true, exit_code: 128, stderr: 'unknown branch' }, 'unknown branch'],
    [{ stdout: { diff: patch } }, 'Expected text stdout'],
    [{ stdout_truncated: true }, 'size limit'],
  ])('preserves failed or incomplete command results: %j', async (extra, message) => {
    const commands = {
      request: vi.fn(),
      executeCommand: vi.fn().mockResolvedValue(response('', extra)),
    }
    await expect(
      new RuntimeApi(config, undefined, undefined, commands).getWorkspaceGitDiff(
        target.deviceId,
        target.path,
        { mode: 'branch' }
      )
    ).rejects.toThrow(message)
    expect(commands.executeCommand).toHaveBeenCalledOnce()
  })

  it('uses the exact PC repository probe and preserves rejected permission checks', async () => {
    const commands = {
      request: vi.fn(),
      executeCommand: vi
        .fn()
        .mockResolvedValueOnce(response('true\n'))
        .mockResolvedValueOnce(
          response('', { success: false, exit_code: 128, stderr: 'not a git repository' })
        )
        .mockRejectedValueOnce(new Error('permission denied')),
    }
    const api = new RuntimeApi(config, undefined, undefined, commands)
    await expect(api.isWorkspaceGitRepository(target.deviceId, target.path)).resolves.toBe(true)
    expect(commands.executeCommand).toHaveBeenNthCalledWith(
      1,
      target.deviceId,
      {
        command_key: 'git_is_worktree',
        path: target.path,
        args: [target.path],
        timeout_seconds: 10,
        max_output_bytes: 4096,
      },
      undefined
    )
    await expect(api.isWorkspaceGitRepository(target.deviceId, target.path)).resolves.toBe(false)
    await expect(api.isWorkspaceGitRepository(target.deviceId, target.path)).rejects.toThrow(
      'permission denied'
    )
  })
})

describe('Mobile workspace changes state', () => {
  const api = () => ({
    getWorkspaceGitBranch: vi.fn().mockResolvedValue('feature/selected'),
    getWorkspaceGitDiff: vi.fn().mockResolvedValue(patch),
    isWorkspaceGitRepository: vi.fn().mockResolvedValue(true),
  })
  it('returns the exact owner, mode and shared PC per-file statistics', async () => {
    const service = api()
    const result = await loadMobileWorkspaceChanges(service, target, { mode: 'branch' })
    expect(result).toMatchObject({
      target,
      selection: { mode: 'branch' },
      branchName: 'feature/selected',
      fileCount: 1,
      additions: 2,
      deletions: 1,
      files: [
        {
          path: 'src/file.ts',
          oldPath: 'src/file.ts',
          status: 'modified',
          additions: 2,
          deletions: 1,
        },
      ],
    })
    expect(service.getWorkspaceGitDiff).toHaveBeenCalledWith(
      target.deviceId,
      target.path,
      { mode: 'branch' },
      undefined
    )
    expect(service.isWorkspaceGitRepository).not.toHaveBeenCalled()
    expect(result.target).not.toBe(target)
  })

  it('keeps empty and detached repositories truthful without inventing a branch', async () => {
    const service = api()
    service.getWorkspaceGitBranch.mockResolvedValue('')
    service.getWorkspaceGitDiff.mockResolvedValue('')
    await expect(
      loadMobileWorkspaceChanges(service, target, { mode: 'branch' })
    ).resolves.toMatchObject({
      branchName: '',
      files: [],
      fileCount: 0,
      additions: 0,
      deletions: 0,
    })
  })

  it('uses a distinct non-Git state only after a failed read and a confirmed negative probe', async () => {
    const service = api()
    service.getWorkspaceGitBranch.mockRejectedValueOnce(new Error('Git failed'))
    service.isWorkspaceGitRepository.mockResolvedValue(false)
    await expect(
      loadMobileWorkspaceChanges(service, target, { mode: 'branch' })
    ).rejects.toBeInstanceOf(WorkspaceNotGitRepositoryError)
    expect(service.isWorkspaceGitRepository).toHaveBeenCalledWith(
      target.deviceId,
      target.path,
      undefined
    )
  })

  it.each(['permission denied', 'device offline'])(
    'preserves %s when the repository probe cannot establish non-Git status',
    async message => {
      const service = api()
      const failure = new Error(message)
      service.getWorkspaceGitDiff.mockRejectedValueOnce(failure)
      service.isWorkspaceGitRepository.mockRejectedValueOnce(new Error(message))
      await expect(loadMobileWorkspaceChanges(service, target, { mode: 'branch' })).rejects.toBe(
        failure
      )
    }
  )

  it('does not publish an aborted old-device result or issue a capability probe after cancellation', async () => {
    const service = api()
    let resolve!: (value: string) => void
    service.getWorkspaceGitDiff.mockImplementationOnce(
      () =>
        new Promise<string>(done => {
          resolve = done
        })
    )
    const controller = new AbortController()
    const loading = loadMobileWorkspaceChanges(
      service,
      target,
      { mode: 'unstaged' },
      controller.signal
    )
    controller.abort()
    resolve(patch)
    await expect(loading).rejects.toMatchObject({ name: 'AbortError' })
    expect(service.isWorkspaceGitRepository).not.toHaveBeenCalled()
  })

  it('allows an explicit retry without caching failed or cross-device results', async () => {
    const service = api()
    service.getWorkspaceGitDiff.mockRejectedValueOnce(new Error('device disconnected'))
    await expect(loadMobileWorkspaceChanges(service, target, { mode: 'unstaged' })).rejects.toThrow(
      'device disconnected'
    )
    const next = { ...target, deviceId: 'another-device', path: '/another/worktree' }
    await expect(
      loadMobileWorkspaceChanges(service, next, { mode: 'unstaged' })
    ).resolves.toMatchObject({ target: next, fileCount: 1 })
    expect(service.getWorkspaceGitDiff).toHaveBeenLastCalledWith(
      next.deviceId,
      next.path,
      { mode: 'unstaged' },
      undefined
    )
  })
})
