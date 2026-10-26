import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { expect, test } from '../../fixtures/test-fixtures'
import { ADMIN_USER } from '../../config/test-users'
import { createApiClient } from '../../utils/api-client'

type TaskSource = 'api' | 'dingtalk'
type Project = {
  id: number
  name: string
  is_expanded: boolean
  config: { taskSource: TaskSource } | null
}

const routesFile = resolve(__dirname, '../../../../backend-rs/config/routes.toml')

for (const source of ['api', 'dingtalk'] as const) {
  test(`Rust project update preserves and validates ${source} taskSource`, async ({
    request,
    testPrefix,
  }) => {
    // CI starts the hybrid gateway with this route table. Keep this regression
    // bound to the Rust PUT instead of silently passing through Python.
    const routes = readFileSync(routesFile, 'utf8')
    expect(routes).toMatch(
      /^\[\[routes\]\]\s*\nmethods = \["PUT"\]\s*\npath = "\/api\/projects\/:project_id"/m
    )

    const api = createApiClient(request)
    expect((await api.login(ADMIN_USER.username, ADMIN_USER.password, 1)).status).toBe(200)

    const name = `${testPrefix}-${source}-project`
    const created = await api.post<Project>('/api/projects', {
      name,
      client_origin: 'frontend',
      config: { taskSource: source },
    })
    expect(created.status, JSON.stringify(created.data)).toBe(201)
    expect(created.data?.config?.taskSource).toBe(source)
    const projectId = created.data!.id
    const projectPath = `/api/projects/${projectId}`

    async function readPersistedProject(): Promise<Project> {
      // GET /api/projects still falls back to Python and reads the committed MySQL row.
      const listed = await api.get<{ items: Project[] }>('/api/projects?include_tasks=false')
      expect(listed.status, JSON.stringify(listed.data)).toBe(200)
      const project = listed.data?.items.find(item => item.id === projectId)
      expect(project).toBeTruthy()
      return project!
    }

    try {
      const renamed = `${name}-updated`
      const updated = await api.put<Project>(projectPath, {
        name: renamed,
        is_expanded: false,
      })
      expect(updated.status, JSON.stringify(updated.data)).toBe(200)
      expect(updated.data).toMatchObject({
        id: projectId,
        name: renamed,
        is_expanded: false,
        config: { taskSource: source },
      })
      expect(await readPersistedProject()).toMatchObject({
        name: renamed,
        is_expanded: false,
        config: { taskSource: source },
      })

      const nextSource: TaskSource = source === 'api' ? 'dingtalk' : 'api'
      const changed = await api.put<Project>(projectPath, {
        config: { taskSource: nextSource },
      })
      expect(changed.status, JSON.stringify(changed.data)).toBe(200)
      expect(changed.data?.config?.taskSource).toBe(nextSource)
      expect((await readPersistedProject()).config?.taskSource).toBe(nextSource)

      const rejected = await api.put(projectPath, {
        config: { taskSource: 'unsupported' },
      })
      expect(rejected.status, JSON.stringify(rejected.data)).toBe(422)
      expect((await readPersistedProject()).config?.taskSource).toBe(nextSource)
    } finally {
      const deleted = await api.delete(projectPath)
      expect(deleted.status, JSON.stringify(deleted.data)).toBe(204)
    }
  })
}
