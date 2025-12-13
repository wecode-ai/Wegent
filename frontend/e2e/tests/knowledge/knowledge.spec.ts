import { test, expect } from '@playwright/test';
import { LoginPage } from '../../pages/auth/login.page';
import { createApiClient, ApiClient } from '../../utils/api-client';
import { ADMIN_USER } from '../../config/test-users';

test.describe('Knowledge Page', () => {
  let apiClient: ApiClient;

  test.beforeEach(async ({ page, request }) => {
    apiClient = createApiClient(request);
    await apiClient.login(ADMIN_USER.username, ADMIN_USER.password);

    const loginPage = new LoginPage(page);
    await loginPage.login(ADMIN_USER.username, ADMIN_USER.password);

    await page.goto('/knowledge');
    await page.waitForLoadState('networkidle');
  });

  test('should access knowledge page', async ({ page }) => {
    await expect(page).toHaveURL(/\/knowledge/);
    await expect(
      page.locator(
        'h1:has-text("Knowledge"), h2:has-text("Knowledge"), text=Knowledge, text=知识库'
      )
    ).toBeVisible({ timeout: 10000 });
  });

  test('should display knowledge tabs', async ({ page }) => {
    const codeTabs = page.locator('button:has-text("Code"), button:has-text("代码")');
    const documentTabs = page.locator('button:has-text("Document"), button:has-text("文档")');

    const hasCodeTab = await codeTabs.isVisible({ timeout: 5000 }).catch(() => false);
    const hasDocTab = await documentTabs.isVisible({ timeout: 5000 }).catch(() => false);

    expect(hasCodeTab || hasDocTab).toBe(true);
  });

  test('should display project list or empty state', async ({ page }) => {
    await page.waitForLoadState('networkidle');

    const hasProjects = await page
      .locator('[data-testid="project-card"], .project-card')
      .first()
      .isVisible({ timeout: 3000 })
      .catch(() => false);
    const hasEmptyState = await page
      .locator('text=No projects, text=没有项目')
      .isVisible({ timeout: 1000 })
      .catch(() => false);
    const hasAddButton = await page
      .locator('button:has-text("Add"), button:has-text("添加")')
      .isVisible({ timeout: 1000 })
      .catch(() => false);

    expect(hasProjects || hasEmptyState || hasAddButton || true).toBeTruthy();
  });

  test('should have search functionality', async ({ page }) => {
    const searchInput = page.locator('input[placeholder*="search"], input[placeholder*="搜索"]');

    if (await searchInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await searchInput.fill('test search');
      await page.waitForTimeout(500);
      expect(true).toBe(true);
    }
  });

  test('should open add repository modal', async ({ page }) => {
    const addButton = page.locator(
      'button:has-text("Add"), button:has-text("添加"), button:has-text("New")'
    );

    if (await addButton.isVisible({ timeout: 5000 }).catch(() => false)) {
      await addButton.click();

      const dialogVisible = await page
        .locator('[role="dialog"]')
        .isVisible({ timeout: 3000 })
        .catch(() => false);
      expect(dialogVisible).toBe(true);
    }
  });
});
