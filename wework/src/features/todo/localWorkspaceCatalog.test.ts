import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_WORK_ITEM_PROJECT_ID } from '@/api/deliveries'
import type {
  LocalProjectSpaceApi,
  ProjectSpaceDetailServices,
} from '@/features/workbench/workbenchServices'
import { createLocalWorkspaceApi } from './localWorkspaceApi'
import { loadWorkspaceCatalog } from './localWorkspaceCatalog'

beforeEach(() => {
  vi.spyOn(console, 'debug').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => vi.restoreAllMocks())

function failures() {
  return vi.mocked(console.error).mock.calls.map(([prefix, value]) => {
    expect(prefix).toBe('[Wework] Local workspace catalog failed')
    return JSON.parse(String(value))
  })
}

function progress() {
  return vi.mocked(console.debug).mock.calls.map(([prefix, value]) => {
    expect(prefix).toBe('[Wework] Local workspace catalog')
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
    expect(progress()).toEqual([
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

  it.each([
    { listFails: true, defaultFails: true, agentCount: 0, failed: ['agents', 'default-agent'] },
    { listFails: true, defaultFails: false, agentCount: 1, failed: ['agents'] },
    { listFails: false, defaultFails: true, agentCount: 1, failed: ['default-agent'] },
  ])(
    'attributes request failures while preserving the workspace summary ($listFails, $defaultFails)',
    async scenario => {
      const error = Object.assign(new Error('private agent payload'), {
        name: 'private-error-name',
        status: 503,
        response: { token: 'private-token' },
      })
      const list = scenario.listFails
        ? vi.fn().mockRejectedValue(error)
        : vi.fn().mockResolvedValue([{ id: 'private-custom-agent', name: 'custom-agent' }])
      const ensureDefault = scenario.defaultFails
        ? vi.fn().mockRejectedValue(error)
        : vi.fn().mockResolvedValue({ id: 'private-default-agent', name: 'current-device-agent' })
      const api = createLocalWorkspaceApi(
        {
          listCloudProjects: vi.fn().mockResolvedValue({
            items: [{ id: DEFAULT_WORK_ITEM_PROJECT_ID, name: 'private-workspace', version: 1 }],
          }),
        } as unknown as LocalProjectSpaceApi,
        1,
        'private-user',
        'private@example.com',
        {
          deviceApi: { listDevices: vi.fn().mockResolvedValue([]) },
          localProjectChatAgentApi: { list, ensureDefault },
        } as unknown as ProjectSpaceDetailServices
      )!

      await expect(api.workspaces!.list()).resolves.toMatchObject([
        { agent_count: scenario.agentCount },
      ])

      expect(list).toHaveBeenCalledOnce()
      expect(ensureDefault).toHaveBeenCalledOnce()
      expect(failures()).toEqual(
        scenario.failed.map(catalog => ({
          source: 'local',
          catalog,
          status: 'rejected',
          elapsedMs: expect.any(Number),
          errorName: 'Error',
          reason: 'rejected',
          httpStatus: 503,
        }))
      )
      expect(progress()).toContainEqual({
        source: 'local',
        catalog: 'agents-summary',
        status: 'fulfilled',
        elapsedMs: expect.any(Number),
      })
      expect(console.warn).not.toHaveBeenCalled()
      expect(
        JSON.stringify([
          ...vi.mocked(console.debug).mock.calls,
          ...vi.mocked(console.error).mock.calls,
          ...vi.mocked(console.warn).mock.calls,
        ])
      ).not.toContain('private')
    }
  )
})
