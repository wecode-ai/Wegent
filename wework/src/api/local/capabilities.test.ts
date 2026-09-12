import { beforeEach, describe, expect, test, vi } from 'vitest'
import { requestLocalExecutor } from '@/desktop/localExecutor'
import {
  listStandaloneSkills,
  listMcpServers,
  getCachedMcpServers,
  clearMcpServersCache,
  saveMcpServer,
  canRemoveSkill,
  isPluginSkill,
  type McpListResult,
  type McpStatus,
  type StandaloneSkill,
} from './capabilities'
vi.mock('@/desktop/localExecutor', () => ({
  ensureLocalExecutorStarted: vi.fn(),
  requestLocalExecutor: vi.fn(),
}))
vi.mock('@/features/plugins/pluginTrial', () => ({ notifyLocalPluginSkillsChanged: vi.fn() }))
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requestLocalExecutor).mockReset()
  clearMcpServersCache()
})
describe('native capability management', () => {
  test('retains disabled and same-name skills by path', async () => {
    vi.mocked(requestLocalExecutor).mockResolvedValue({
      data: [
        {
          skills: [
            { name: 'report', path: '/a/SKILL.md', enabled: false },
            { name: 'report', path: '/b/SKILL.md', enabled: true },
          ],
          errors: [{ message: 'invalid frontmatter' }],
        },
      ],
    })
    const result = await listStandaloneSkills('/project')
    expect(result.skills).toHaveLength(2)
    expect(result.skills[0].enabled).toBe(false)
    expect(result.errors).toHaveLength(1)
    expect(requestLocalExecutor).toHaveBeenCalledWith('codex.app_server_request', {
      method: 'skills/list',
      params: { cwds: ['/project'], forceReload: true },
    })
  })
  test('paginates runtime inventory and preserves disconnected configuration', async () => {
    vi.mocked(requestLocalExecutor).mockImplementation((_command: string, args?: unknown) => {
      const request = args as { method?: string; params?: { cursor?: string | null } }
      if (request.method === 'config/read') {
        return Promise.resolve({
          config: { mcp_servers: { offline: { url: 'https://example.test/mcp' } } },
        })
      }
      if (request.params?.cursor === 'next') {
        return Promise.resolve({ data: [{ name: 'second', tools: {} }], nextCursor: null })
      }
      return Promise.resolve({
        data: [{ name: 'plugin-server', pluginId: 'plugin', tools: {} }],
        nextCursor: 'next',
      })
    })
    const result = await listMcpServers()
    expect(result.entries.map(e => e.name)).toEqual(['offline', 'plugin-server', 'second'])
    expect(result.entries[1].config).toBeNull()
    expect(result.statusError).toBe(false)
    expect(getCachedMcpServers()).toEqual(result)
  })
  test('returns cached MCP inventory immediately while refreshing in the background', async () => {
    vi.mocked(requestLocalExecutor).mockImplementation((_command: string, args?: unknown) => {
      const request = args as { method?: string }
      if (request.method === 'config/read') {
        return Promise.resolve({
          config: { mcp_servers: { company: { url: 'https://example.test/mcp' } } },
        })
      }
      return Promise.resolve({
        data: [
          {
            name: 'company',
            serverInfo: { name: 'company' },
            authStatus: 'unsupported',
            tools: {},
          },
        ],
        nextCursor: null,
      })
    })
    await listMcpServers()
    const updates: McpListResult[] = []
    await listMcpServers(update => updates.push(update))
    expect(updates[0]).toEqual(getCachedMcpServers())
  })
  test('streams saved configuration while runtime status is still loading', async () => {
    let resolveStatus: (value: { data: McpStatus[]; nextCursor: null }) => void = () => undefined
    const pendingStatus = new Promise<{ data: McpStatus[]; nextCursor: null }>(resolve => {
      resolveStatus = resolve
    })
    vi.mocked(requestLocalExecutor).mockImplementation((_command: string, args?: unknown) => {
      const request = args as { method?: string }
      if (request.method === 'config/read') {
        return Promise.resolve({
          config: { mcp_servers: { company: { url: 'https://example.test/mcp' } } },
        })
      }
      return pendingStatus
    })
    const updates: McpListResult[] = []
    const resultPromise = listMcpServers(update => updates.push(update))
    await vi.waitFor(() => {
      expect(updates.at(-1)?.entries).toMatchObject([
        { name: 'company', config: { url: 'https://example.test/mcp' } },
      ])
    })
    resolveStatus({
      data: [
        {
          name: 'company',
          serverInfo: { name: 'company' },
          authStatus: 'unsupported',
          tools: {},
        },
      ],
      nextCursor: null,
    })
    const result = await resultPromise
    expect(result.entries[0]).toMatchObject({
      name: 'company',
      config: { url: 'https://example.test/mcp' },
      status: { serverInfo: { name: 'company' } },
    })
  })
  test('reports status failure without discarding saved configuration', async () => {
    vi.mocked(requestLocalExecutor).mockImplementation((_command: string, args?: unknown) => {
      const request = args as { method?: string }
      return request.method === 'config/read'
        ? Promise.resolve({ config: { mcp_servers: { offline: { enabled: false } } } })
        : Promise.reject(new Error('not reachable'))
    })
    expect(await listMcpServers()).toMatchObject({
      entries: [{ name: 'offline', config: { enabled: false } }],
      statusError: true,
    })
  })
  test('deletes a native configuration entry and rejects key injection', async () => {
    await saveMcpServer('company-service', null)
    expect(requestLocalExecutor).toHaveBeenCalledWith('codex.app_server_request', {
      method: 'config/value/write',
      params: { keyPath: 'mcp_servers.company-service', value: null, mergeStrategy: 'replace' },
    })
    await expect(saveMcpServer('a.enabled', {})).rejects.toThrow()
    expect(requestLocalExecutor).toHaveBeenCalledTimes(1)
  })
  test('MCP edits omit native null defaults while preserving configured options', async () => {
    await saveMcpServer('company', {
      command: 'node',
      args: ['server.js'],
      enabled: false,
      tool_timeout_sec: null,
      environment_id: 'local',
    })
    expect(requestLocalExecutor).toHaveBeenCalledWith('codex.app_server_request', {
      method: 'config/value/write',
      params: {
        keyPath: 'mcp_servers.company',
        value: { command: 'node', args: ['server.js'], enabled: false, environment_id: 'local' },
        mergeStrategy: 'replace',
      },
    })
  })
  test('requires HTTPS when bearer-token authentication is configured', async () => {
    await expect(
      saveMcpServer('company', {
        url: 'http://example.test/mcp',
        bearer_token_env_var: 'COMPANY_MCP_TOKEN',
      })
    ).rejects.toThrow('HTTPS')
    expect(requestLocalExecutor).not.toHaveBeenCalled()

    await saveMcpServer('local-development', { url: 'http://127.0.0.1:3000/mcp' })
    expect(requestLocalExecutor).toHaveBeenCalledTimes(1)
  })
  test('plugin-owned and built-in skills cannot be independently removed', () => {
    const skill: StandaloneSkill = {
      name: 'report',
      description: '',
      scope: 'user',
      enabled: true,
      path: '/home/skills/report/SKILL.md',
    }
    expect(canRemoveSkill(skill, '/home')).toBe(true)
    expect(canRemoveSkill({ ...skill, pluginId: 'plugin' }, '/home')).toBe(false)
    expect(isPluginSkill({ ...skill, pluginId: 'plugin' })).toBe(true)
    expect(
      canRemoveSkill({ ...skill, path: '/home/skills/.system/report/SKILL.md' }, '/home')
    ).toBe(false)
  })
})
