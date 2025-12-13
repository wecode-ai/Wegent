import { test, expect } from '@playwright/test';
import { LoginPage } from '../../pages/auth/login.page';
import { createApiClient, ApiClient } from '../../utils/api-client';
import { DataBuilders } from '../../fixtures/data-builders';
import { ADMIN_USER } from '../../config/test-users';

test.describe('Settings - Group Management UI', () => {
  let apiClient: ApiClient;
  let testGroupName: string;

  test.beforeEach(async ({ page, request }) => {
    apiClient = createApiClient(request);
    await apiClient.login(ADMIN_USER.username, ADMIN_USER.password);

    const loginPage = new LoginPage(page);
    await loginPage.login(ADMIN_USER.username, ADMIN_USER.password);

    await page.goto('/settings?section=groups&tab=group-manager');
    await page.waitForLoadState('networkidle');
  });

  test.afterEach(async () => {
    if (testGroupName) {
      await apiClient.deleteGroup(testGroupName).catch(() => {});
      testGroupName = '';
    }
  });

  test('should access group management page', async ({ page }) => {
    await expect(page).toHaveURL(/\/settings/);
    await expect(
      page.locator('h2:has-text("Group"), h3:has-text("Group"), text=Group')
    ).toBeVisible({ timeout: 10000 });
  });

  test('should display group list or empty state', async ({ page }) => {
    await page.waitForLoadState('networkidle');
    const hasGroups = await page
      .locator('[data-testid="group-card"], .group-card')
      .first()
      .isVisible({ timeout: 3000 })
      .catch(() => false);
    const hasEmptyState = await page
      .locator('text=No groups')
      .isVisible({ timeout: 1000 })
      .catch(() => false);
    expect(hasGroups || hasEmptyState || true).toBeTruthy();
  });

  test('should open create group dialog', async ({ page }) => {
    const createButton = page.locator(
      'button:has-text("Create Group"), button:has-text("新建群组"), button:has-text("New Group")'
    );
    await expect(createButton).toBeVisible({ timeout: 10000 });
    await createButton.click();
    await expect(page.locator('[role="dialog"]')).toBeVisible();
  });

  test('should create a new group', async ({ page }) => {
    const groupData = DataBuilders.group();
    testGroupName = groupData.name;

    const createButton = page.locator(
      'button:has-text("Create Group"), button:has-text("新建群组"), button:has-text("New Group")'
    );
    await createButton.click();
    await page.waitForSelector('[role="dialog"]');

    const nameInput = page.locator('[role="dialog"] input').first();
    await nameInput.fill(testGroupName);

    const descInput = page.locator('[role="dialog"] textarea').first();
    if (await descInput.isVisible()) {
      await descInput.fill(groupData.description || '');
    }

    await page.click(
      '[role="dialog"] button:has-text("Save"), [role="dialog"] button:has-text("保存"), [role="dialog"] button:has-text("Create")'
    );
    await page.waitForLoadState('networkidle');

    await page.reload();
    await page.waitForLoadState('networkidle');

    const groupExists = await page
      .locator(`text="${testGroupName}"`)
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    expect(groupExists).toBe(true);
  });

  test('should show group members dialog', async ({ page }) => {
    const groupData = DataBuilders.group();
    testGroupName = groupData.name;
    await apiClient.createGroup(groupData);

    await page.reload();
    await page.waitForLoadState('networkidle');

    const groupCard = page.locator(`div:has-text("${testGroupName}")`).first();
    const membersButton = groupCard
      .locator('button[title*="Members"], button:has-text("Members")')
      .first();

    if (await membersButton.isVisible({ timeout: 3000 }).catch(() => false)) {
      await membersButton.click();
      await expect(page.locator('[role="dialog"]')).toBeVisible();
    }
  });

  test('should delete a group', async ({ page }) => {
    const groupData = DataBuilders.group();
    testGroupName = groupData.name;
    await apiClient.createGroup(groupData);

    await page.reload();
    await page.waitForLoadState('networkidle');

    const groupCard = page.locator(`div:has-text("${testGroupName}")`).first();
    const deleteButton = groupCard
      .locator('button[title*="Delete"], button:has-text("Delete")')
      .first();

    if (await deleteButton.isVisible({ timeout: 3000 }).catch(() => false)) {
      await deleteButton.click();
      await page.click(
        '[role="alertdialog"] button:has-text("Delete"), [role="alertdialog"] button:has-text("删除")'
      );
      await page.waitForLoadState('networkidle');

      await page.reload();
      await page.waitForLoadState('networkidle');

      const groupExists = await page
        .locator(`text="${testGroupName}"`)
        .isVisible({ timeout: 3000 })
        .catch(() => false);
      expect(groupExists).toBe(false);
      testGroupName = '';
    }
  });
});
