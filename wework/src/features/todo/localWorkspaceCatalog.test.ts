import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalProjectSpaceApi } from '@/features/workbench/workbenchServices'
import { createLocalWorkspaceApi } from './localWorkspaceApi'
import { loadWorkspaceCatalog } from './localWorkspaceCatalog'

beforeEach(() => {
  vi.spyOn(console, 'debug').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => vi.restoreAllMocks())

function failures() {
  return vi.mocked(console.error).mock.calls.map(([prefix, value]) => {
    expect(prefix).toBe('[Wework] Local workspace catalog failed')
    return JSON.parse(String(value))
  })
}

describe('local workspace catalog diagnostics', () => {
  it('returns the original value and records completion without logging contents', async () => {
    const value = { token: 'private-token' }
    const load = vi.fn(async () => value)

    await expect(loadWorkspaceCatalog('navigation-projects', load)).resolves.toBe(value)

    expect(load).toHaveBeenCalledOnce()
    expect(console.error).not.toHaveBeenCalled()
    expect(vi.mocked(console.debug).mock.calls.map(([, record]) => record)).toEqual([
      expect.objectContaining({
        source: 'local',
        catalog: 'navigation-projects',
        status: 'started',
      }),
      expect.objectContaining({
        source: 'local',
        catalog: 'navigation-projects',
        status: 'fulfilled',
      }),
    ])
    expect(JSON.stringify(vi.mocked(console.debug).mock.calls)).not.toContain('private-token')
  })

  it.each([
    { mode: 'sync', name: 'TypeError', message: 'Failed to fetch', reason: 'network' },
    { mode: 'async', name: 'Error', message: 'Connection timed out', reason: 'timeout' },
    { mode: 'sync', name: 'AbortError', message: 'Aborted', reason: 'aborted' },
    { mode: 'async', name: 'private-name', message: 'Unavailable', reason: 'rejected' },
  ])('records a $mode $reason failure without exposing its payload or retrying', async scenario => {
    const error = Object.assign(
      new Error(`${scenario.message} https://private.example/user?token=private-token`),
      {
        name: scenario.name,
        code: 'private-code',
        status: 403,
        response: { user: 'private-user', token: 'private-token' },
      }
    )
    const load = vi.fn(() => {
      if (scenario.mode === 'sync') throw error
      return Promise.reject(error)
    })

    await expect(loadWorkspaceCatalog('navigation-workspaces', load)).rejects.toBe(error)

    expect(load).toHaveBeenCalledOnce()
    expect(failures()).toEqual([
      {
        source: 'local',
        catalog: 'navigation-workspaces',
        status: 'rejected',
        elapsedMs: expect.any(Number),
        errorName: scenario.name === 'private-name' ? 'Error' : scenario.name,
        reason: scenario.reason,
        httpStatus: 403,
      },
    ])
    expect(failures()[0].elapsedMs).toBeGreaterThanOrEqual(0)
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toMatch(/private|https:/)
  })

  it.each(['projects', 'workspaces'] as const)(
    'identifies the real local %s navigation boundary and preserves the original rejection',
    async catalog => {
      const error = new Error('Private catalog failure')
      const listCloudProjects = vi.fn().mockRejectedValue(error)
      const api = createLocalWorkspaceApi(
        { listCloudProjects } as unknown as LocalProjectSpaceApi,
        1,
        'private-user',
        'private@example.com'
      )!

      await expect(
        catalog === 'projects' ? api.projects.list() : api.workspaces!.list()
      ).rejects.toBe(error)

      expect(failures()).toContainEqual(
        expect.objectContaining({
          source: 'local',
          catalog: `navigation-${catalog}`,
          status: 'rejected',
        })
      )
      if (catalog === 'workspaces') {
        expect(failures().map(failure => failure.catalog)).toEqual(
          expect.arrayContaining(['projects', 'workspace-settings'])
        )
      }
      expect(listCloudProjects).toHaveBeenCalledTimes(catalog === 'projects' ? 1 : 2)
      expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toMatch(/private/i)
    }
  )
})
