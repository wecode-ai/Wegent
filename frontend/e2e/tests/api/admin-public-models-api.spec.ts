import { test, expect } from '@playwright/test';
import { createApiClient, ApiClient } from '../../utils/api-client';
import { DataBuilders } from '../../fixtures/data-builders';
import { ADMIN_USER } from '../../config/test-users';

test.describe('Admin - Public Model API Tests', () => {
  let apiClient: ApiClient;
  let testModelId: number | null = null;

  test.beforeEach(async ({ request }) => {
    apiClient = createApiClient(request);
    await apiClient.login(ADMIN_USER.username, ADMIN_USER.password);
  });

  test.afterEach(async () => {
    if (testModelId) {
      await apiClient.adminDeletePublicModel(testModelId).catch(() => {});
      testModelId = null;
    }
  });

  test('GET /api/admin/public-models - should list public models', async () => {
    const response = await apiClient.adminListPublicModels();
    expect(response.status).toBe(200);
    expect(Array.isArray(response.data)).toBe(true);
  });

  test('POST /api/admin/public-models - should create public model', async () => {
    const modelName = DataBuilders.uniqueName('api-test-model');
    const response = await apiClient.adminCreatePublicModel({
      name: modelName,
      display_name: 'API Test Model',
      model_config: JSON.stringify({
        provider: 'openai',
        model_id: 'gpt-4',
        api_key: 'test-key',
        base_url: 'https://api.openai.com/v1',
      }),
      is_active: true,
    });

    expect([200, 201]).toContain(response.status);
    if (response.data) {
      testModelId = (response.data as { id: number }).id;
    }
  });

  test('PUT /api/admin/public-models/:id - should update public model', async () => {
    // Create model first
    const modelName = DataBuilders.uniqueName('api-update-model');
    const createResponse = await apiClient.adminCreatePublicModel({
      name: modelName,
      display_name: 'API Update Test Model',
      model_config: JSON.stringify({
        provider: 'openai',
        model_id: 'gpt-4',
        api_key: 'test-key',
        base_url: 'https://api.openai.com/v1',
      }),
      is_active: true,
    });

    expect([200, 201]).toContain(createResponse.status);
    testModelId = (createResponse.data as { id: number }).id;

    // Update model
    const updateResponse = await apiClient.adminUpdatePublicModel(testModelId, {
      display_name: 'Updated Display Name',
      is_active: false,
    });

    expect(updateResponse.status).toBe(200);
  });

  test('DELETE /api/admin/public-models/:id - should delete public model', async () => {
    // Create model first
    const modelName = DataBuilders.uniqueName('api-delete-model');
    const createResponse = await apiClient.adminCreatePublicModel({
      name: modelName,
      display_name: 'API Delete Test Model',
      model_config: JSON.stringify({
        provider: 'openai',
        model_id: 'gpt-4',
        api_key: 'test-key',
        base_url: 'https://api.openai.com/v1',
      }),
      is_active: true,
    });

    const modelId = (createResponse.data as { id: number }).id;

    // Delete model
    const deleteResponse = await apiClient.adminDeletePublicModel(modelId);
    expect([200, 204]).toContain(deleteResponse.status);
  });
});
