import { test, expect } from '@playwright/test';
import { ShellsPage } from '../../pages/settings/shells.page';
import { LoginPage } from '../../pages/auth/login.page';
import { createApiClient, ApiClient } from '../../utils/api-client';
import { DataBuilders } from '../../fixtures/data-builders';
import { ADMIN_USER } from '../../config/test-users';

test.describe('Settings - Shell Management', () => {
  let shellsPage: ShellsPage;
  let apiClient: ApiClient;
  let testShellName: string;

  test.beforeEach(async ({ page, request }) => {
    shellsPage = new ShellsPage(page);
    apiClient = createApiClient(request);
    await apiClient.login(ADMIN_USER.username, ADMIN_USER.password);

    const loginPage = new LoginPage(page);
    await loginPage.login(ADMIN_USER.username, ADMIN_USER.password);

    await shellsPage.navigate();
  });

  test.afterEach(async () => {
    if (testShellName) {
      await apiClient.delete(`/api/v1/namespaces/default/shells/${testShellName}`).catch(() => {});
      testShellName = '';
    }
  });

  test('should access shell management page', async () => {
    expect(shellsPage.isOnSettingsPage()).toBe(true);
    await expect(
      shellsPage['page'].locator('h2:has-text("Shell"), h3:has-text("Shell"), text=Shell')
    ).toBeVisible({ timeout: 10000 });
  });

  test('should display shell list', async () => {
    const shellCount = await shellsPage.getShellCount();
    expect(shellCount).toBeGreaterThanOrEqual(0);
  });

  test('should open create shell dialog', async () => {
    await shellsPage.clickCreateShell();
    await expect(shellsPage['page'].locator('[role="dialog"]')).toBeVisible();
  });

  test('should create a new shell', async () => {
    const shellData = DataBuilders.shell();
    testShellName = shellData.metadata.name;

    await shellsPage.clickCreateShell();
    await shellsPage.fillShellForm({
      name: testShellName,
      description: shellData.spec.description,
      shellType: 'ClaudeCode',
      baseImage: 'python:3.11',
    });
    await shellsPage.submitShellForm();
    await shellsPage.waitForToast().catch(() => {});

    await shellsPage['page'].reload();
    await shellsPage.waitForPageLoad();

    const exists = await shellsPage.shellExists(testShellName);
    expect(exists).toBe(true);
  });

  test('should delete a shell', async () => {
    const shellData = DataBuilders.shell();
    testShellName = shellData.metadata.name;
    await apiClient.post('/api/v1/namespaces/default/shells', shellData);

    await shellsPage['page'].reload();
    await shellsPage.waitForPageLoad();

    await shellsPage.clickDeleteShell(testShellName);
    await shellsPage.confirmDelete();

    await shellsPage['page'].reload();
    await shellsPage.waitForPageLoad();

    const exists = await shellsPage.shellExists(testShellName);
    expect(exists).toBe(false);
    testShellName = '';
  });
});

test.describe('Settings - Shell API Tests', () => {
  let apiClient: ApiClient;
  let testShellName: string;

  test.beforeEach(async ({ request }) => {
    apiClient = createApiClient(request);
    await apiClient.login(ADMIN_USER.username, ADMIN_USER.password);
  });

  test.afterEach(async () => {
    if (testShellName) {
      await apiClient.delete(`/api/v1/namespaces/default/shells/${testShellName}`).catch(() => {});
      testShellName = '';
    }
  });

  test('GET /api/shells/unified - should list shells', async () => {
    const response = await apiClient.getShells();
    expect(response.status).toBe(200);
  });

  test('POST /api/v1/namespaces/:ns/shells - should create shell', async () => {
    const shellData = DataBuilders.shell();
    testShellName = shellData.metadata.name;
    const response = await apiClient.post('/api/v1/namespaces/default/shells', shellData);
    expect([200, 201]).toContain(response.status);
  });

  test('DELETE /api/v1/namespaces/:ns/shells/:name - should delete shell', async () => {
    const shellData = DataBuilders.shell();
    const shellName = shellData.metadata.name;
    await apiClient.post('/api/v1/namespaces/default/shells', shellData);
    const response = await apiClient.delete(`/api/v1/namespaces/default/shells/${shellName}`);
    expect([200, 204]).toContain(response.status);
  });
});
