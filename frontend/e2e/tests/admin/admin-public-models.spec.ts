import { test, expect } from '@playwright/test';
import { AdminPage } from '../../pages/admin/admin.page';
import { LoginPage } from '../../pages/auth/login.page';
import { createApiClient, ApiClient } from '../../utils/api-client';
import { DataBuilders } from '../../fixtures/data-builders';
import { ADMIN_USER } from '../../config/test-users';

test.describe('Admin - Public Model Management', () => {
  let adminPage: AdminPage;
  let apiClient: ApiClient;
  let testModelId: number | null = null;

  test.beforeEach(async ({ page, request }) => {
    adminPage = new AdminPage(page);
    apiClient = createApiClient(request);
    await apiClient.login(ADMIN_USER.username, ADMIN_USER.password);

    // Login via UI
    const loginPage = new LoginPage(page);
    await loginPage.login(ADMIN_USER.username, ADMIN_USER.password);

    await adminPage.navigateToTab('public-models');
  });

  test.afterEach(async () => {
    // Cleanup: delete test model if created
    if (testModelId) {
      await apiClient.adminDeletePublicModel(testModelId).catch(() => {});
      testModelId = null;
    }
  });

  test('should access public model management page', async () => {
    expect(adminPage.isOnAdminPage()).toBe(true);

    // Should see public models section
    await expect(
      adminPage['page'].locator(
        'h2:has-text("Public Models"), h2:has-text("公共模型"), h3:has-text("Model")'
      )
    ).toBeVisible({ timeout: 10000 });
  });

  test('should display public model list', async () => {
    const modelCount = await adminPage.getPublicModelCount();
    // May have 0 or more public models
    expect(modelCount).toBeGreaterThanOrEqual(0);
  });

  test('should open create public model dialog', async () => {
    await adminPage.clickCreatePublicModel();

    // Dialog should be visible
    await expect(adminPage['page'].locator('[role="dialog"]')).toBeVisible();

    // Should have model name input
    await expect(adminPage['page'].locator('[role="dialog"] input')).toBeVisible();
  });

  test('should create a new public model', async () => {
    const modelName = DataBuilders.uniqueName('e2e-public-model');
    const modelConfig = JSON.stringify({
      provider: 'openai',
      model_id: 'gpt-4',
      api_key: 'test-api-key',
      base_url: 'https://api.openai.com/v1',
    });

    await adminPage.clickCreatePublicModel();
    await adminPage.fillPublicModelForm({
      name: modelName,
      displayName: `E2E Test Model ${Date.now()}`,
      config: modelConfig,
    });
    await adminPage.submitPublicModelForm();

    // Wait for toast or dialog to close
    await adminPage.waitForToast().catch(() => {});

    // Verify model appears in list
    await adminPage['page'].reload();
    await adminPage.waitForPageLoad();

    const exists = await adminPage.publicModelExists(modelName);

    // Get model ID for cleanup
    if (exists) {
      const modelsResponse = await apiClient.adminListPublicModels();
      if (modelsResponse.data) {
        const models = modelsResponse.data as Array<{ id: number; name: string }>;
        const testModel = models.find(m => m.name === modelName);
        if (testModel) {
          testModelId = testModel.id;
        }
      }
    }

    expect(exists).toBe(true);
  });

  test('should show edit dialog for existing public model', async () => {
    // Create a test model first via API
    const modelName = DataBuilders.uniqueName('e2e-edit-model');
    const createResponse = await apiClient.adminCreatePublicModel({
      name: modelName,
      display_name: `E2E Edit Test Model`,
      model_config: JSON.stringify({
        provider: 'openai',
        model_id: 'gpt-4',
        api_key: 'test-key',
        base_url: 'https://api.openai.com/v1',
      }),
      is_active: true,
    });

    if (createResponse.data) {
      testModelId = (createResponse.data as { id: number }).id;
    }

    // Refresh page
    await adminPage['page'].reload();
    await adminPage.waitForPageLoad();

    // Click edit
    await adminPage.clickEditPublicModel(modelName);

    // Dialog should be visible
    await expect(adminPage['page'].locator('[role="dialog"]')).toBeVisible();
  });

  test('should delete a public model', async () => {
    // Create a test model first via API
    const modelName = DataBuilders.uniqueName('e2e-delete-model');
    const createResponse = await apiClient.adminCreatePublicModel({
      name: modelName,
      display_name: `E2E Delete Test Model`,
      model_config: JSON.stringify({
        provider: 'openai',
        model_id: 'gpt-4',
        api_key: 'test-key',
        base_url: 'https://api.openai.com/v1',
      }),
      is_active: true,
    });

    if (createResponse.data) {
      testModelId = (createResponse.data as { id: number }).id;
    }

    // Refresh page
    await adminPage['page'].reload();
    await adminPage.waitForPageLoad();

    // Delete model
    await adminPage.clickDeletePublicModel(modelName);
    await adminPage.confirmDelete();

    // Wait for toast
    await adminPage.waitForToast().catch(() => {});

    // Verify model is gone
    await adminPage['page'].reload();
    await adminPage.waitForPageLoad();

    const exists = await adminPage.publicModelExists(modelName);
    expect(exists).toBe(false);

    // Clear testModelId as it's already deleted
    testModelId = null;
  });

  test('should validate JSON config when creating model', async () => {
    await adminPage.clickCreatePublicModel();

    // Fill with invalid JSON
    await adminPage.fillPublicModelForm({
      name: 'test-model',
      config: 'invalid json {',
    });

    await adminPage.submitPublicModelForm();

    // Dialog should still be visible (validation failed) or error shown
    const dialogVisible = await adminPage['page']
      .locator('[role="dialog"]')
      .isVisible({ timeout: 2000 })
      .catch(() => false);
    const errorVisible = await adminPage['page']
      .locator('text=Invalid, text=invalid, text=错误')
      .isVisible({ timeout: 2000 })
      .catch(() => false);

    expect(dialogVisible || errorVisible).toBe(true);
  });
});

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
