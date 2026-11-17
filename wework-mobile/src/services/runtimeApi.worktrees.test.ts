import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('expo-file-system', () => ({ File: class {} }))
import { RuntimeApi } from './runtimeApi'
import type { LocalRuntimeApi } from './localRuntimeApi'
import { worktreePreflight } from '@/testing/worktreeFixtures'

const config = {
  backendUrl: 'https://example.test',
  apiBaseUrl: 'https://example.test/api',
  socketBaseUrl: 'https://example.test',
  socketPath: '/socket.io',
  accessToken: 'test-token',
}

afterEach(() => vi.unstubAllGlobals())

describe('mobile worktree transport matches PC', () => {
  it('routes capabilities and branch preflight through authorized remote endpoints', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(worktreePreflight())))
    vi.stubGlobal('fetch', fetcher)
    const api = new RuntimeApi(config)
    await api.getWorktreeCapabilities({ deviceId: 'cloud' })
    await api.preflightWorkspace({ deviceId: 'cloud', sourcePath: '/repo', ref: 'feature/mobile' })
    expect(fetcher.mock.calls.map(call => (call as unknown[])[0])).toEqual([
      'https://example.test/api/runtime-work/worktrees/capabilities',
      'https://example.test/api/runtime-work/worktrees/preflight',
    ])
    const request = fetcher.mock.calls[1] as unknown as [string, RequestInit]
    expect(request[1].method).toBe('POST')
    expect(JSON.parse(request[1].body as string)).toEqual({
      deviceId: 'cloud',
      sourcePath: '/repo',
      ref: 'feature/mobile',
    })
  })

  it('keeps phone-local worktree reads on IPC without a Backend session', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const request = vi.fn(async () => ({}))
    const local = {
      runtime: { ownsDevice: (id: string) => id === 'phone', request },
    } as unknown as LocalRuntimeApi
    const api = new RuntimeApi(null, undefined, undefined, undefined, local)
    await api.getWorktreeCapabilities({ deviceId: 'phone' })
    await api.preflightWorkspace({ deviceId: 'phone', sourcePath: '/repo', ref: 'main' })
    expect(request.mock.calls).toEqual([
      ['runtime.worktrees.capabilities', { deviceId: 'phone' }],
      ['runtime.worktrees.preflight', { deviceId: 'phone', sourcePath: '/repo', ref: 'main' }],
    ])
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('reads and prioritizes branches through typed preflight on the workspace owner', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify(
            worktreePreflight({ branches: ['release', 'main', 'release', 'feature/mobile'] })
          )
        )
    )
    vi.stubGlobal('fetch', fetcher)
    const api = new RuntimeApi(config)
    expect(await api.listWorkspaceGitBranches('owner', '/repo')).toEqual([
      'main',
      'release',
      'feature/mobile',
    ])
    const request = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(request[0]).toBe('https://example.test/api/runtime-work/worktrees/preflight')
    expect(JSON.parse(request[1].body as string)).toEqual({
      deviceId: 'owner',
      sourcePath: '/repo',
      includeBranches: true,
    })
    fetcher.mockResolvedValueOnce(
      new Response(JSON.stringify(worktreePreflight({ error: 'Failed', gitRepository: false })))
    )
    await expect(api.listWorkspaceGitBranches('owner', '/repo')).rejects.toThrow('Failed')
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify(worktreePreflight())))
    await expect(api.listWorkspaceGitBranches('owner', '/repo')).rejects.toThrow(
      'does not support worktree branch inspection'
    )
  })
})
