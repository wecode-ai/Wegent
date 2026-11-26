import { test, expect } from '@playwright/test'
import { createApiClient, ApiClient } from '../../utils/api-client'
import { DataBuilders } from '../../fixtures/data-builders'
import { ADMIN_USER } from '../../config/test-users'

test.describe('Admin - Public Model API Tests', () => {
  let apiClient: ApiClient
  const createdModelIds: number[] = []

  test.beforeEach(async ({ request }) => {
    apiClient = createApiClient(request)
    await apiClient.login(ADMIN_USER.username, ADMIN_USER.password)
  })

  test.afterEach(async () => {
    for (const modelId of createdModelIds.splice(0)) {
      await apiClient.adminDeletePublicModel(modelId).catch(() => {})
    }
  })

  test('GET /api/admin/public-models - should list public models', async () => {
    const response = await apiClient.adminListPublicModels()
    expect(response.status).toBe(200)
    expect(response.data).toHaveProperty('total')
    expect(response.data).toHaveProperty('items')
    expect(Array.isArray((response.data as { items: unknown[] }).items)).toBe(true)
  })

  test('POST /api/admin/public-models - should create public model', async () => {
    const modelName = DataBuilders.uniqueName('api-test-model')
    const response = await apiClient.adminCreatePublicModel({
      name: modelName,
      json: {
        apiVersion: 'agent.wecode.io/v1',
        kind: 'Model',
        metadata: {
          name: modelName,
          displayName: 'API Test Model',
          namespace: 'default',
        },
        spec: {
          modelConfig: {
            provider: 'openai',
            modelId: 'gpt-4',
            apiKey: 'test-key',
            baseUrl: 'https://api.openai.com/v1',
          },
        },
      },
    })

    expect([200, 201]).toContain(response.status)
    if (response.data) {
      const createdModel = response.data as { id: number; is_visible: boolean }
      createdModelIds.push(createdModel.id)
      expect(createdModel.is_visible).toBe(true)
    }
  })

  test('PUT /api/admin/public-models/:id - should update public model', async () => {
    // Create model first
    const modelName = DataBuilders.uniqueName('api-update-model')
    const createResponse = await apiClient.adminCreatePublicModel({
      name: modelName,
      json: {
        apiVersion: 'agent.wecode.io/v1',
        kind: 'Model',
        metadata: {
          name: modelName,
          displayName: 'API Update Test Model',
          namespace: 'default',
        },
        spec: {
          modelConfig: {
            provider: 'openai',
            modelId: 'gpt-4',
            apiKey: 'test-key',
            baseUrl: 'https://api.openai.com/v1',
          },
        },
      },
    })

    expect([200, 201]).toContain(createResponse.status)
    const createdModelId = (createResponse.data as { id: number }).id
    createdModelIds.push(createdModelId)

    // Update model
    const updateResponse = await apiClient.adminUpdatePublicModel(createdModelId, {
      is_visible: false,
    })

    expect(updateResponse.status).toBe(200)
    expect((updateResponse.data as { is_active: boolean }).is_active).toBe(true)
    expect((updateResponse.data as { is_visible: boolean }).is_visible).toBe(false)

    const deactivateResponse = await apiClient.adminUpdatePublicModel(createdModelId, {
      is_active: false,
    })

    expect(deactivateResponse.status).toBe(200)
    expect((deactivateResponse.data as { is_active: boolean }).is_active).toBe(false)
    expect((deactivateResponse.data as { is_visible: boolean }).is_visible).toBe(false)
  })

  test('DELETE /api/admin/public-models/:id - should delete public model', async () => {
    // Create model first
    const modelName = DataBuilders.uniqueName('api-delete-model')
    const createResponse = await apiClient.adminCreatePublicModel({
      name: modelName,
      json: {
        apiVersion: 'agent.wecode.io/v1',
        kind: 'Model',
        metadata: {
          name: modelName,
          displayName: 'API Delete Test Model',
          namespace: 'default',
        },
        spec: {
          modelConfig: {
            provider: 'openai',
            modelId: 'gpt-4',
            apiKey: 'test-key',
            baseUrl: 'https://api.openai.com/v1',
          },
        },
      },
    })

    const modelId = (createResponse.data as { id: number }).id

    // Delete model
    const deleteResponse = await apiClient.adminDeletePublicModel(modelId)
    expect([200, 204]).toContain(deleteResponse.status)
  })

  test('GET /api/admin/public-models - should filter and paginate', async () => {
    const unique = DataBuilders.uniqueName('api-search-model')
    const modelNames = [`${unique}-a`, `${unique}-b`, `${unique}-c`]

    for (const [index, name] of modelNames.entries()) {
      const response = await apiClient.adminCreatePublicModel({
        name,
        json: {
          apiVersion: 'agent.wecode.io/v1',
          kind: 'Model',
          metadata: {
            name,
            displayName: `Qwen Search ${index} ${unique}`,
            namespace: 'default',
          },
          spec: {
            modelConfig: {
              provider: 'openai',
              modelId: 'gpt-4',
              apiKey: 'test-key',
              baseUrl: 'https://api.openai.com/v1',
            },
          },
        },
      })
      expect([200, 201]).toContain(response.status)
      createdModelIds.push((response.data as { id: number }).id)
    }

    const firstPage = await apiClient.adminListPublicModels({
      search: unique.toUpperCase(),
      page: 1,
      limit: 2,
    })
    expect(firstPage.status).toBe(200)
    const firstPageData = firstPage.data as { total: number; items: { name: string }[] }
    expect(firstPageData.total).toBe(3)
    expect(firstPageData.items.map(item => item.name)).toEqual(modelNames.slice(0, 2))

    const secondPage = await apiClient.adminListPublicModels({
      search: unique,
      page: 2,
      limit: 2,
    })
    expect(secondPage.status).toBe(200)
    const secondPageData = secondPage.data as { total: number; items: { name: string }[] }
    expect(secondPageData.total).toBe(3)
    expect(secondPageData.items.map(item => item.name)).toEqual([modelNames[2]])
  })
})
