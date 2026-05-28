import { describe, expect, test, vi } from 'vitest'
import { createProjectApi } from './projects'
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

    expect(client.get).toHaveBeenCalledWith('/projects?include_tasks=true')
  })

  test('loads recent personal chat and code tasks', async () => {
    const client = mockClient()
    vi.mocked(client.get).mockResolvedValueOnce({ total: 0, items: [] })

    await createTaskApi(client).listRecentTasks({ limit: 20 })

    expect(client.get).toHaveBeenCalledWith('/tasks/lite/personal?limit=20&page=1&types=online%2Coffline')
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
    await createTaskApi(client).archiveAllChats()
    await createTaskApi(client).archiveTask(8)
    await createTaskApi(client).listArchivedTasks()
    await createTaskApi(client).unarchiveTask(8)
    await createTaskApi(client).deleteArchivedTasks()

    expect(client.post).toHaveBeenNthCalledWith(1, '/projects/7/archive-chats')
    expect(client.post).toHaveBeenNthCalledWith(2, '/tasks/archive')
    expect(client.post).toHaveBeenNthCalledWith(3, '/tasks/8/archive')
    expect(client.get).toHaveBeenCalledWith('/tasks/archived?limit=200&page=1')
    expect(client.post).toHaveBeenNthCalledWith(4, '/tasks/8/unarchive')
    expect(client.delete).toHaveBeenCalledWith('/tasks/archived')
  })
})
