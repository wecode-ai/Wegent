import { expect, test } from '@playwright/test'

import { ADMIN_USER, REGULAR_USER } from '../../config/test-users'
import { ApiClient, createApiClient } from '../../utils/api-client'

type PublicModel = {
  id: number
  name: string
}

function modelConfig(): { env: Record<string, string> } {
  return {
    env: {
      model: 'openai',
      model_id: 'public-model-auth-e2e',
      api_key: 'e2e-public-model-key',
      base_url: 'http://localhost:9999/v1',
    },
  }
}

test.describe('Public model write authorization', () => {
  let adminApi: ApiClient
  let regularApi: ApiClient
  let createdModelId: number | null = null

  test.beforeEach(async ({ request }) => {
    adminApi = createApiClient(request)
    regularApi = createApiClient(request)

    expect((await adminApi.login(ADMIN_USER.username, ADMIN_USER.password)).status).toBe(200)
    expect((await regularApi.login(REGULAR_USER.username, REGULAR_USER.password)).status).toBe(200)
  })

  test.afterEach(async () => {
    if (createdModelId !== null) {
      await adminApi.delete(`/api/models/${createdModelId}`).catch(() => {})
      createdModelId = null
    }
  })

  test('denies all public model writes for a regular user', async () => {
    const createResponse = await regularApi.post<PublicModel>('/api/models', {
      name: `e2e-unauthorized-model-${Date.now()}`,
      config: modelConfig(),
    })
    expect(createResponse.status).toBe(403)

    const batchResponse = await regularApi.post('/api/models/batch', [
      {
        name: `e2e-unauthorized-batch-${Date.now()}`,
        env: modelConfig().env,
      },
    ])
    expect(batchResponse.status).toBe(403)

    const models = await adminApi.post<{ created: PublicModel[] }>('/api/models/batch', [
      {
        name: `e2e-auth-guard-${Date.now()}`,
        env: modelConfig().env,
      },
    ])
    expect(models.status).toBe(201)
    expect(models.data?.created).toHaveLength(1)
    createdModelId = models.data?.created[0]?.id ?? null
    expect(createdModelId).toBeTruthy()

    const updateResponse = await regularApi.put(`/api/models/${createdModelId}`, {
      config: {
        env: {
          ...modelConfig().env,
          base_url: 'https://attacker.invalid/v1',
        },
      },
    })
    expect(updateResponse.status).toBe(403)

    const deleteResponse = await regularApi.delete(`/api/models/${createdModelId}`)
    expect(deleteResponse.status).toBe(403)

    const unchanged = await adminApi.get(`/api/models/${createdModelId}`)
    expect(unchanged.status).toBe(200)
    expect(
      (unchanged.data as { config?: { env?: { base_url?: string } } }).config?.env
    ).toMatchObject({ base_url: 'http://localhost:9999/v1' })
  })

  test('allows an admin to create and clean up a public model', async () => {
    const createResponse = await adminApi.post<PublicModel>('/api/models', {
      name: `e2e-admin-model-${Date.now()}`,
      config: modelConfig(),
    })
    expect(createResponse.status).toBe(201)
    createdModelId = createResponse.data?.id ?? null
    expect(createdModelId).toBeTruthy()

    const deleteResponse = await adminApi.delete(`/api/models/${createdModelId}`)
    expect([200, 204]).toContain(deleteResponse.status)
    createdModelId = null
  })
})
