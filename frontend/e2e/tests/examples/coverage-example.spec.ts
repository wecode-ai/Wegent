import { test, expect } from '@playwright/test';
import { LoginPage } from '../../pages/auth/login.page';
import { startCoverage, stopCoverage } from '../../helpers/coverage';
import { ADMIN_USER } from '../../config/test-users';

/**
 * Example test demonstrating code coverage collection
 *
 * This test shows how to:
 * 1. Start coverage collection before navigation
 * 2. Perform test actions
 * 3. Stop coverage and save results
 */
test.describe('Coverage Example', () => {
  test('should collect coverage during login flow', async ({ page }) => {
    // Start coverage collection
    await startCoverage(page);

    // Perform login
    const loginPage = new LoginPage(page);
    await loginPage.navigate();
    await loginPage.login(ADMIN_USER.username, ADMIN_USER.password);

    // Verify login success
    await expect(page).toHaveURL(/\/(chat|tasks|code)/);

    // Stop coverage and save results
    await stopCoverage(page, 'login-flow');
  });

  test('should collect coverage during navigation', async ({ page }) => {
    // Start coverage
    await startCoverage(page);

    // Login first
    const loginPage = new LoginPage(page);
    await loginPage.login(ADMIN_USER.username, ADMIN_USER.password);

    // Navigate to different pages
    await page.goto('/settings');
    await page.waitForLoadState('networkidle');

    await page.goto('/tasks');
    await page.waitForLoadState('networkidle');

    // Stop coverage
    await stopCoverage(page, 'navigation-flow');
  });
});
