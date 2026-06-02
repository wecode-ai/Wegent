import { describe, expect, test, vi } from 'vitest'
import { createProjectApi } from './projects'
import { createDeviceApi } from './devices'
import { createSystemSkillApi } from './systemSkills'
import { createTaskApi } from './tasks'
import { createTeamApi } from './teams'
import { createModelApi } from './models'
import { createSkillApi } from './skills'
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

    expect(client.get).toHaveBeenCalledWith(
      '/projects?include_tasks=true&client_origin=wework',
    )
  })

  test('loads recent online and offline workbench tasks', async () => {
    const client = mockClient()
    vi.mocked(client.get).mockResolvedValueOnce({ total: 0, items: [] })

    await createTaskApi(client).listRecentTasks({ limit: 20 })

    expect(client.get).toHaveBeenCalledWith(
      '/tasks/lite/personal?limit=20&page=1&types=online%2Coffline&client_origin=wework',
    )
  })

  test('loads task detail from the wework client origin', async () => {
    const client = mockClient()
    vi.mocked(client.get).mockResolvedValueOnce({ id: 8 })

    await createTaskApi(client).getTaskDetail(8)

    expect(client.get).toHaveBeenCalledWith('/tasks/8?client_origin=wework')
  })

  test('picks default team for code first and then chat', async () => {
    const client = mockClient()
    vi.mocked(client.get).mockResolvedValueOnce({
      total: 2,
      items: [
        { id: 1, name: 'general', default_for_modes: ['chat'], is_active: true },
        { id: 2, name: 'coder', default_for_modes: ['code'], is_active: true },
      ],
    })

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

  test('loads unified llm models from existing backend endpoint', async () => {
    const client = mockClient()
    vi.mocked(client.get).mockResolvedValueOnce({ data: [] })

    await createModelApi(client).listModels()

    expect(client.get).toHaveBeenCalledWith(
      '/models/unified?include_config=true&scope=all&model_category_type=llm'
    )
  })

  test('loads unified skills and team skills from existing backend endpoints', async () => {
    const client = mockClient()
    vi.mocked(client.get).mockResolvedValue({ items: [] })

    await createSkillApi(client).listSkills()
    await createSkillApi(client).getTeamSkills(2)

    expect(client.get).toHaveBeenNthCalledWith(1, '/v1/kinds/skills/unified?scope=all')
    expect(client.get).toHaveBeenNthCalledWith(2, '/teams/2/skills')
  })

  test('adapts project and task archive endpoints', async () => {
    const client = mockClient()
    vi.mocked(client.post).mockResolvedValue({ message: 'ok', count: 1 })
    vi.mocked(client.get).mockResolvedValue({ total: 0, items: [] })
    vi.mocked(client.delete).mockResolvedValue({ message: 'ok', count: 0 })

    await createProjectApi(client).archiveProjectChats(7)
    await createProjectApi(client).archiveAllProjectChats()
    await createTaskApi(client).archiveAllChats()
    await createTaskApi(client).archiveTask(8)
    await createTaskApi(client).listArchivedTasks()
    await createTaskApi(client).unarchiveTask(8)
    await createTaskApi(client).deleteArchivedTasks()

    expect(client.post).toHaveBeenNthCalledWith(
      1,
      '/projects/7/archive-chats?client_origin=wework',
    )
    expect(client.post).toHaveBeenNthCalledWith(
      2,
      '/projects/archive-chats?client_origin=wework',
    )
    expect(client.post).toHaveBeenNthCalledWith(
      3,
      '/tasks/archive?scope=standalone&client_origin=wework',
    )
    expect(client.post).toHaveBeenNthCalledWith(
      4,
      '/tasks/8/archive?client_origin=wework',
    )
    expect(client.get).toHaveBeenCalledWith(
      '/tasks/archived?limit=200&page=1&client_origin=wework',
    )
    expect(client.post).toHaveBeenNthCalledWith(
      5,
      '/tasks/8/unarchive?client_origin=wework',
    )
    expect(client.delete).toHaveBeenCalledWith('/tasks/archived?client_origin=wework')
  })

  test('starts project-scoped terminal and IDE sessions', async () => {
    const client = mockClient()
    vi.mocked(client.post).mockResolvedValue({ url: 'http://localhost/session' })

    const api = createProjectApi(client)

    await api.startTerminalSession(7)
    await api.startCodeServerSession(7)

    expect(client.post).toHaveBeenNthCalledWith(
      1,
      '/projects/7/terminal?client_origin=wework',
    )
    expect(client.post).toHaveBeenNthCalledWith(
      2,
      '/projects/7/code-server?client_origin=wework',
    )
  })

  test('resolves device home and project workspace root', async () => {
    const client = mockClient()
    vi.mocked(client.post)
      .mockResolvedValueOnce({
        success: true,
        stdout: '/home/ubuntu\n',
        stderr: '',
      })
      .mockResolvedValueOnce({
        success: true,
        stdout: '/workspace/projects\n',
        stderr: '',
      })

    const api = createDeviceApi(client)

    await expect(api.getHomeDirectory('device-1')).resolves.toBe('/home/ubuntu')
    await expect(api.getProjectWorkspaceRoot('device-1')).resolves.toBe('/workspace/projects')

    expect(client.post).toHaveBeenNthCalledWith(
      1,
      '/devices/device-1/commands',
      expect.objectContaining({ command_key: 'home_dir' }),
    )
    expect(client.post).toHaveBeenNthCalledWith(
      2,
      '/devices/device-1/commands',
      expect.objectContaining({ command_key: 'project_workspace_root' }),
    )
  })
})
