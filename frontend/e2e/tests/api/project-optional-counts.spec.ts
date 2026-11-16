import { ADMIN_USER } from '../../config/test-users'
import { expect, test } from '../../fixtures/test-fixtures'
import { createApiClient } from '../../utils/api-client'

test('project metadata and task pages can omit counts independently', async ({
  request,
  testPrefix,
}) => {
  const api = createApiClient(request)
  expect((await api.login(ADMIN_USER.username, ADMIN_USER.password, 1)).status).toBe(200)
  const created = await api.post<{ id: number }>('/api/projects', {
    name: `${testPrefix}-optional-counts`,
    client_origin: 'frontend',
  })
  expect(created.status, JSON.stringify(created.data)).toBe(201)
  const projectId = created.data!.id
  const projectPath = `/api/projects/${projectId}`
  const projectsPath = '/api/projects?include_tasks=false'

  try {
    type ProjectList = { items: { id: number; task_count: number | null }[] }
    const metadata = await api.get<ProjectList>(`${projectsPath}&include_task_count=false`)
    expect(metadata.status).toBe(200)
    expect(metadata.data?.items.find(project => project.id === projectId)).toMatchObject({
      task_count: null,
      tasks: [],
    })
    const counted = await api.get<ProjectList>(projectsPath)
    expect(counted.status).toBe(200)
    expect(counted.data?.items.find(project => project.id === projectId)?.task_count).toBe(0)

    const page = await api.get(`${projectPath}/tasks?limit=2&include_total=false`)
    expect(page.status).toBe(200)
    expect(page.data).toEqual({ total: null, items: [], has_more: false, next_cursor: null })
    const countedPage = await api.get(`${projectPath}/tasks?limit=2`)
    expect(countedPage.status).toBe(200)
    expect(countedPage.data).toEqual({ total: 0, items: [], has_more: false, next_cursor: null })
  } finally {
    const deleted = await api.delete(projectPath)
    expect(deleted.status).toBe(204)
  }
})
