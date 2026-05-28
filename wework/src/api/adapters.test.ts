import { describe, expect, test, vi } from 'vitest'
import { createProjectApi } from './projects'
import { createSystemSkillApi } from './systemSkills'
import { createTaskApi } from './tasks'
import { createTeamApi } from './teams'
import type { HttpClient } from './http'

function mockClient(): HttpClient {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  }
}

describe('REST adapters', () => {
  test('loads projects with tasks included', async () => {
    const client = mockClient()
    vi.mocked(client.get).mockResolvedValueOnce({ items: [] })

    await createProjectApi(client).listProjects()

    expect(client.get).toHaveBeenCalledWith('/projects?include_tasks=true')
  })

  test('loads recent personal chat and code tasks', async () => {
    const client = mockClient()
    vi.mocked(client.get).mockResolvedValueOnce({ total: 0, items: [] })

    await createTaskApi(client).listRecentTasks({ limit: 20 })

    expect(client.get).toHaveBeenCalledWith(
      '/tasks/lite/personal?limit=20&page=1&types=chat%2Ccode',
    )
  })

  test('picks default team for code first and then chat', async () => {
    const client = mockClient()
    vi.mocked(client.get).mockResolvedValueOnce([
      { id: 1, name: 'general', default_for_modes: ['chat'], is_active: true },
      { id: 2, name: 'coder', default_for_modes: ['code'], is_active: true },
    ])

    const team = await createTeamApi(client).getDefaultWorkbenchTeam()

    expect(team.id).toBe(2)
  })

  test('loads system skills with search params', async () => {
    const client = mockClient()
    vi.mocked(client.get).mockResolvedValueOnce({
      total: 0,
      page: 1,
      pageSize: 20,
      items: [],
      providerErrors: [],
    })

    await createSystemSkillApi(client).listSystemSkills({
      providerKey: 'builtin',
      keyword: 'image',
      tags: ['system', 'image'],
      page: 1,
      pageSize: 20,
    })

    expect(client.get).toHaveBeenCalledWith(
      '/system-skills?category=system&page=1&pageSize=20&providerKey=builtin&keyword=image&tags=system%2Cimage',
    )
  })

  test('installs, toggles, and uninstalls system skills', async () => {
    const client = mockClient()
    vi.mocked(client.post).mockResolvedValueOnce({})
    vi.mocked(client.put).mockResolvedValueOnce({})
    vi.mocked(client.delete).mockResolvedValueOnce({})
    const api = createSystemSkillApi(client)

    await api.installSystemSkill({
      providerKey: 'weibo',
      skillKey: 'wehot',
      catalogItemId: '@weibo/shitao7_wehot',
      displayName: 'wehot',
      description: 'Weibo hot search',
      version: '1.0.0',
      tags: ['weibo'],
    })
    await api.updateInstalledSystemSkill(42, false)
    await api.uninstallInstalledSystemSkill(42)
    await api.updatePersonalSkillEnabled(77, false)

    expect(client.post).toHaveBeenCalledWith('/system-skills/install', {
      providerKey: 'weibo',
      skillKey: 'wehot',
      catalogItemId: '@weibo/shitao7_wehot',
      displayName: 'wehot',
      description: 'Weibo hot search',
      version: '1.0.0',
      tags: ['weibo'],
    })
    expect(client.put).toHaveBeenCalledWith('/system-skills/installed/42', {
      enabled: false,
    })
    expect(client.put).toHaveBeenCalledWith('/v1/kinds/skills/77/enabled', {
      enabled: false,
    })
    expect(client.delete).toHaveBeenCalledWith('/system-skills/installed/42')
  })
})
