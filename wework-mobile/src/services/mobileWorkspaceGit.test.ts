import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceGitSelection } from '@/types/workspaceGit'
import { RuntimeApi } from './runtimeApi'
import { listMobileWorkspaceBranches, loadMobileWorkspaceChanges } from './mobileWorkspaceGit'

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

const response = (stdout: unknown, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ success: true, exit_code: 0, stdout, stderr: '', ...extra }))
const requestBody = (input: RequestInit) => JSON.parse(input.body as string)

afterEach(() => vi.unstubAllGlobals())

describe('Mobile cloud workspace Git protocol', () => {
  it.each([
    [{ mode: 'branch' }, 'git_branch_diff', undefined],
    [
      { mode: 'branch', baseRef: ' origin/release ' },
      'git_compare_branch_diff',
      ['origin/release'],
    ],
    [{ mode: 'unstaged' }, 'git_diff_unstaged', undefined],
    [{ mode: 'staged' }, 'git_diff_staged', undefined],
    [{ mode: 'commit' }, 'git_diff_last_commit', undefined],
  ] as const)(
    'routes %j through the PC cloud command with its exact scope',
    async (selection, key, args) => {
      const controller = new AbortController()
      const fetch = vi.fn().mockResolvedValue(response(patch))
      vi.stubGlobal('fetch', fetch)
      await expect(
        new RuntimeApi(config).getWorkspaceGitDiff(
          target.deviceId,
          target.path,
          selection,
          controller.signal
        )
      ).resolves.toBe(patch.trim())
      expect(fetch).toHaveBeenCalledWith(
        'https://example.com/api/devices/cloud%2Fselected/commands',
        expect.objectContaining({
          method: 'POST',
          signal: controller.signal,
          headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
        })
      )
      expect(requestBody(fetch.mock.calls[0]![1])).toEqual({
        command_key: key,
        path: target.path,
        ...(args ? { args } : {}),
        timeout_seconds: 30,
        max_output_bytes: 5 * 1024 * 1024,
      })
    }
  )

  it.each(['', '-main', '../main', 'main~1', 'main^{commit}', 'main\nother', 'a.lock', 'a//b'])(
    'rejects invalid named base %j without contacting the device',
    async baseRef => {
      const fetch = vi.fn()
      vi.stubGlobal('fetch', fetch)
      await expect(
        new RuntimeApi(config).getWorkspaceGitDiff(target.deviceId, target.path, {
          mode: 'branch',
          baseRef,
        })
      ).rejects.toThrow('Invalid comparison branch')
      expect(fetch).not.toHaveBeenCalled()
    }
  )

  it('rejects unsupported selections, relative paths and empty device identity before transport', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const api = new RuntimeApi(config)
    await expect(
      api.getWorkspaceGitDiff('cloud', '/repo', {
        mode: 'unstaged',
        baseRef: 'main',
      } as unknown as WorkspaceGitSelection)
    ).rejects.toThrow('Only branch diffs')
    await expect(api.getWorkspaceGitDiff('cloud', 'repo', { mode: 'branch' })).rejects.toThrow(
      'absolute'
    )
    await expect(api.getWorkspaceGitBranch(' ', '/repo')).rejects.toThrow('device is required')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('normalizes a Windows cloud workspace without changing its device', async () => {
    const fetch = vi.fn().mockResolvedValue(response('main\n'))
    vi.stubGlobal('fetch', fetch)
    await new RuntimeApi(config).getWorkspaceGitBranch('windows-cloud', 'c:\\worktrees\\repo')
    expect(requestBody(fetch.mock.calls[0]![1])).toEqual({
      command_key: 'git_branch',
      path: 'C:/worktrees/repo',
      timeout_seconds: 10,
      max_output_bytes: 4096,
    })
  })

  it('preserves PC branch ordering and deduplicates current branch exactly once', async () => {
    const fetch = vi.fn(async (_url: string, input: RequestInit) =>
      response(
        requestBody(input).command_key === 'git_branch_list'
          ? ['feature/a', ' main ', '', 'feature/a', 'release', 'origin/main']
          : 'release\n'
      )
    )
    vi.stubGlobal('fetch', fetch)
    await expect(listMobileWorkspaceBranches(new RuntimeApi(config), target)).resolves.toEqual([
      'release',
      'feature/a',
      'main',
      'origin/main',
    ])
    expect(fetch.mock.calls.map(([, input]) => requestBody(input))).toEqual([
      {
        command_key: 'git_branch_list',
        args: ['--all', '--format=%(if)%(symref)%(then)%(else)%(refname:short)%(end)'],
        path: target.path,
        timeout_seconds: 15,
        max_output_bytes: 65536,
      },
      { command_key: 'git_branch', path: target.path, timeout_seconds: 10, max_output_bytes: 4096 },
    ])
  })

  it('retains the branch list if optional current-branch ordering is unavailable, like PC', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, input: RequestInit) =>
        requestBody(input).command_key === 'git_branch_list'
          ? response('main\nrelease')
          : response('', { success: false, error: 'branch discovery failed' })
      )
    )
    await expect(listMobileWorkspaceBranches(new RuntimeApi(config), target)).resolves.toEqual([
      'main',
      'release',
    ])
  })

  it('surfaces an old backend rejecting explicit comparison without retrying a different baseline', async () => {
    const fetch = vi.fn(async (_url: string, input: RequestInit) =>
      requestBody(input).command_key === 'git_compare_branch_diff'
        ? new Response(JSON.stringify({ detail: 'Unsupported command' }), { status: 400 })
        : response(patch)
    )
    vi.stubGlobal('fetch', fetch)
    const api = new RuntimeApi(config)
    await expect(
      api.getWorkspaceGitDiff(target.deviceId, target.path, {
        mode: 'branch',
        baseRef: 'origin/main',
      })
    ).rejects.toThrow('Unsupported command')
    expect(fetch).toHaveBeenCalledTimes(1)
    await expect(
      api.getWorkspaceGitDiff(target.deviceId, target.path, { mode: 'branch' })
    ).resolves.toBe(patch.trim())
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('preserves permission denial without changing owner or attempting another command', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ detail: 'Forbidden workspace' }), { status: 403 })
      )
    vi.stubGlobal('fetch', fetch)
    await expect(
      new RuntimeApi(config).getWorkspaceGitDiff(target.deviceId, target.path, {
        mode: 'branch',
        baseRef: 'origin/main',
      })
    ).rejects.toMatchObject({ status: 403, message: 'Forbidden workspace' })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it.each([
    [{ success: false, error: 'device offline' }, 'device offline'],
    [{ success: true, exit_code: 128, stderr: 'unknown branch' }, 'unknown branch'],
    [{ stdout: { diff: patch } }, 'Expected text stdout'],
    [{ stdout_truncated: true }, 'size limit'],
  ])(
    'does not reinterpret command failure or incomplete output as an empty change list: %j',
    async (extra, message) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response('', extra)))
      await expect(
        new RuntimeApi(config).getWorkspaceGitDiff(target.deviceId, target.path, { mode: 'branch' })
      ).rejects.toThrow(message)
    }
  )
})

describe('Mobile workspace changes state', () => {
  const api = () => ({
    getWorkspaceGitBranch: vi.fn().mockResolvedValue('feature/selected'),
    getWorkspaceGitDiff: vi.fn().mockResolvedValue(patch),
    listWorkspaceGitBranches: vi.fn().mockResolvedValue(['feature/selected', 'main']),
  })

  it('returns exact target, explicit baseline and shared PC per-file statistics', async () => {
    const service = api()
    const result = await loadMobileWorkspaceChanges(service, target, {
      mode: 'branch',
      baseRef: ' main ',
    })
    expect(result).toMatchObject({
      target,
      selection: { mode: 'branch', baseRef: 'main' },
      baseRef: 'main',
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
      { mode: 'branch', baseRef: 'main' },
      undefined
    )
    expect(result.target).not.toBe(target)
  })

  it('keeps empty and detached repositories truthful without inventing a branch or baseline', async () => {
    const service = api()
    service.getWorkspaceGitBranch.mockResolvedValue('')
    service.getWorkspaceGitDiff.mockResolvedValue('')
    await expect(
      loadMobileWorkspaceChanges(service, target, { mode: 'branch' })
    ).resolves.toMatchObject({
      branchName: '',
      baseRef: undefined,
      files: [],
      fileCount: 0,
      additions: 0,
      deletions: 0,
    })
  })

  it('rejects invalid selection before any branch or diff requests', async () => {
    const service = api()
    await expect(
      loadMobileWorkspaceChanges(service, target, { mode: 'branch', baseRef: '-main' })
    ).rejects.toThrow()
    expect(service.getWorkspaceGitBranch).not.toHaveBeenCalled()
    expect(service.getWorkspaceGitDiff).not.toHaveBeenCalled()
  })

  it('does not publish an aborted old device load even when its responses arrive later', async () => {
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
    expect(service.getWorkspaceGitBranch).toHaveBeenCalledWith(
      target.deviceId,
      target.path,
      controller.signal
    )
  })

  it('allows an explicit retry after failure without caching failed or cross-device results', async () => {
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
