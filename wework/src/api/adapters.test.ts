import { describe, expect, test, vi } from 'vitest'
import { createProjectApi } from './projects'
import { createDeviceApi } from './devices'
import { createSystemSkillApi } from './systemSkills'
import { createTaskApi } from './tasks'
import { createTeamApi } from './teams'
import { createModelApi } from './models'
import { createSkillApi } from './skills'
import { createPluginApi } from './plugins'
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

  test('creates Git workspace projects from the wework client origin', async () => {
    const client = mockClient()
    vi.mocked(client.post).mockResolvedValueOnce({
      project: { id: 9, name: 'Wegent' },
      checkout_path: 'Wegent',
      reused_existing_checkout: false,
    })

    await createProjectApi(client).createGitWorkspaceProject({
      device_id: 'device-1',
      name: 'Wegent',
      git: {
        url: 'https://github.com/wecode-ai/Wegent.git',
        repo: 'wecode-ai/Wegent',
        repoId: 101,
        domain: 'github.com',
        branch: 'main',
      },
    })

    expect(client.post).toHaveBeenCalledWith('/projects/git-workspace', {
      device_id: 'device-1',
      name: 'Wegent',
      client_origin: 'wework',
      git: {
        url: 'https://github.com/wecode-ai/Wegent.git',
        repo: 'wecode-ai/Wegent',
        repoId: 101,
        domain: 'github.com',
        branch: 'main',
      },
    })
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

  test('searches conversation tasks in the wework client origin', async () => {
    const client = mockClient()
    vi.mocked(client.get).mockResolvedValueOnce({ total: 0, items: [] })

    await createTaskApi(client).searchTasks('胡云鹏', { limit: 30 })

    expect(client.get).toHaveBeenCalledWith(
      '/tasks/wework/conversation-search?keyword=%E8%83%A1%E4%BA%91%E9%B9%8F&page=1&limit=30',
    )
  })

  test('picks default team for wework first, then code and chat', async () => {
    const client = mockClient()
    vi.mocked(client.get).mockResolvedValueOnce({
      total: 3,
      items: [
        { id: 1, name: 'general', default_for_modes: ['chat'], is_active: true },
        { id: 2, name: 'coder', default_for_modes: ['code'], is_active: true },
        { id: 3, name: 'wework', default_for_modes: ['wework'], is_active: true },
      ],
    })

    const team = await createTeamApi(client).getDefaultWorkbenchTeam()

    expect(team.id).toBe(3)
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
    await api.installPersonalSkill(77)
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
    expect(client.post).toHaveBeenCalledWith('/system-skills/install/personal', {
      skillId: 77,
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

  test('uploads plugins through the shared http client', async () => {
    const client = mockClient()
    vi.mocked(client.post).mockResolvedValueOnce({ metadata: { labels: { id: '1' } } })
    const file = new File(['zip'], 'plugin.ZIP')

    await createPluginApi(client).uploadPlugin(file, false)

    expect(client.post).toHaveBeenCalledWith('/plugins/upload', expect.any(FormData))
    const formData = vi.mocked(client.post).mock.calls[0][1] as FormData
    expect(formData.get('file')).toBe(file)
    expect(formData.get('enabled')).toBe('false')
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

  test('creates a directory through the device command API', async () => {
    const client = mockClient()
    vi.mocked(client.post).mockResolvedValueOnce({
      success: true,
      stdout: '',
      stderr: '',
    })

    const api = createDeviceApi(client)

    await expect(api.createDirectory('device-1', '  /home/ubuntu/new-app  ')).resolves.toBeUndefined()

    expect(client.post).toHaveBeenCalledWith(
      '/devices/device-1/commands',
      expect.objectContaining({
        command_key: 'mkdir_p',
        args: ['/home/ubuntu/new-app'],
      }),
    )
  })

  test('rejects blank directory paths before calling the device command API', async () => {
    const client = mockClient()
    const api = createDeviceApi(client)

    await expect(api.createDirectory('device-1', '   ')).rejects.toThrow(
      'Directory path is required',
    )
    expect(client.post).not.toHaveBeenCalled()
  })

  test('throws backend command errors when directory creation fails', async () => {
    const client = mockClient()
    vi.mocked(client.post).mockResolvedValueOnce({
      success: false,
      stdout: '',
      stderr: 'mkdir failed',
    })

    const api = createDeviceApi(client)

    await expect(api.createDirectory('device-1', '/home/ubuntu/new-app')).rejects.toThrow(
      'mkdir failed',
    )
  })

  test('loads local device skills through the device command API', async () => {
    const client = mockClient()
    const skills = [
      {
        name: 'zeta',
        description: 'Zeta skill',
        path: '/Users/crystal/.codex/skills/zeta/SKILL.md',
        source: 'codex',
      },
      {
        name: 'Dws',
        description: 'DingTalk skill from Claude',
        path: '/Users/crystal/.claude/skills/dws/SKILL.md',
        source: 'claude',
      },
      {
        name: 'dws',
        description: 'DingTalk skill from Codex',
        path: '/Users/crystal/.codex/skills/dws/SKILL.md',
        source: 'codex',
      },
      {
        name: 'alpha',
        description: 'Alpha skill',
        path: '/Users/crystal/.codex/skills/alpha/SKILL.md',
        source: 'codex',
      },
    ]
    vi.mocked(client.post).mockResolvedValueOnce({
      success: true,
      stdout: skills,
      stderr: '',
    })

    await expect(createDeviceApi(client).listSkills('device-1')).resolves.toEqual([
      skills[3],
      skills[1],
      skills[0],
    ])

    expect(client.post).toHaveBeenCalledWith(
      '/devices/device-1/commands',
      expect.objectContaining({
        command_key: 'ls_skills',
      }),
    )
  })

  test('loads local device skills from JSON command stdout', async () => {
    const client = mockClient()
    const skills = [
      {
        name: 'env-context',
        description: 'Environment facts',
        path: '/Users/crystal/.codex/skills/env-context/SKILL.md',
        source: 'codex',
      },
    ]
    vi.mocked(client.post).mockResolvedValueOnce({
      success: true,
      stdout: JSON.stringify(skills),
      stderr: '',
    })

    await expect(createDeviceApi(client).listSkills('device-1')).resolves.toEqual(skills)
  })
})
