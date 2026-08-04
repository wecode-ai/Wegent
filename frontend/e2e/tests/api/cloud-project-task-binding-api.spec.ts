import { expect, test } from '@playwright/test'
import { ADMIN_USER } from '../../config/test-users'

const API_BASE_URL = process.env.E2E_API_URL || 'http://localhost:8000'

interface CloudProjectResponse {
  id: string
  name: string
  version: number
}

test.describe('API - Cloud project task binding', () => {
  let authorization: { Authorization: string }
  let project: CloudProjectResponse | null = null
  let runtimeTask: { deviceId: string; taskId: string } | null = null

  test.beforeEach(async ({ request }) => {
    const loginResponse = await request.post(`${API_BASE_URL}/api/auth/login`, {
      data: {
        user_name: ADMIN_USER.username,
        password: ADMIN_USER.password,
      },
    })
    expect(loginResponse.status()).toBe(200)
    const login = (await loginResponse.json()) as { access_token: string }
    authorization = { Authorization: `Bearer ${login.access_token}` }
  })

  test.afterEach(async ({ request }) => {
    if (runtimeTask) {
      const unbindResponse = await request.delete(
        `${API_BASE_URL}/api/v1/runtime-tasks/cloud-context`,
        {
          headers: authorization,
          data: runtimeTask,
        }
      )
      expect(unbindResponse.status()).toBe(204)
      runtimeTask = null
    }
    if (project) {
      const archiveResponse = await request.delete(
        `${API_BASE_URL}/api/v1/cloud-projects/${project.id}?version=${project.version}`,
        { headers: authorization }
      )
      expect(archiveResponse.status()).toBe(204)
      project = null
    }
  })

  test('preserves a null TODO when binding a task to a project', async ({ request }) => {
    const unique = `${Date.now().toString(36)}${test.info().workerIndex.toString(36)}`
    const createResponse = await request.post(`${API_BASE_URL}/api/v1/cloud-projects`, {
      headers: authorization,
      data: {
        project_key: `E${unique}`.slice(0, 16),
        name: `MySQL project binding ${unique}`,
      },
    })
    expect(createResponse.status()).toBe(201)
    project = (await createResponse.json()) as CloudProjectResponse

    runtimeTask = {
      deviceId: `mysql-e2e-device-${unique}`,
      taskId: `mysql-e2e-task-${unique}`,
    }
    const bindResponse = await request.post(
      `${API_BASE_URL}/api/v1/cloud-projects/${project.id}/tasks`,
      {
        headers: authorization,
        data: runtimeTask,
      }
    )
    expect(bindResponse.status()).toBe(201)
    const binding = (await bindResponse.json()) as {
      cloud_project_id: string
      loop_item_id: string | null
    }
    expect(binding.cloud_project_id).toBe(project.id)
    expect(binding.loop_item_id).toBeNull()

    const query = new URLSearchParams({
      device_id: runtimeTask.deviceId,
      task_id: runtimeTask.taskId,
    })
    const contextResponse = await request.get(
      `${API_BASE_URL}/api/v1/runtime-tasks/cloud-context?${query}`,
      { headers: authorization }
    )
    expect(contextResponse.status()).toBe(200)
    const context = (await contextResponse.json()) as {
      loop_item: unknown | null
      project: CloudProjectResponse
    }
    expect(context.project.id).toBe(project.id)
    expect(context.loop_item).toBeNull()

    const itemResponse = await request.post(
      `${API_BASE_URL}/api/v1/cloud-projects/${project.id}/loop-items`,
      {
        headers: authorization,
        data: { title: `MySQL TODO ${unique}` },
      }
    )
    expect(itemResponse.status()).toBe(201)
    const item = (await itemResponse.json()) as { id: string }

    const todoBindingResponse = await request.post(
      `${API_BASE_URL}/api/v1/loop-items/${item.id}/tasks`,
      {
        headers: authorization,
        data: runtimeTask,
      }
    )
    expect(todoBindingResponse.status()).toBe(201)

    const narrowedResponse = await request.get(
      `${API_BASE_URL}/api/v1/runtime-tasks/cloud-context?${query}`,
      { headers: authorization }
    )
    expect(narrowedResponse.status()).toBe(200)
    const narrowed = (await narrowedResponse.json()) as {
      loop_item: { id: string } | null
      project: CloudProjectResponse
    }
    expect(narrowed.project.id).toBe(project.id)
    expect(narrowed.loop_item?.id).toBe(item.id)
  })
})
