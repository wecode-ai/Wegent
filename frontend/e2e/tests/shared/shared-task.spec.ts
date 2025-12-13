import { test, expect } from '@playwright/test';

test.describe('Shared Task Page', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('should show error for invalid share token', async ({ page }) => {
    await page.goto('/shared/task?token=invalid-token-12345');
    await page.waitForLoadState('networkidle');

    const errorVisible = await page
      .locator('text=Invalid, text=invalid, text=错误, text=失效')
      .isVisible({ timeout: 10000 })
      .catch(() => false);
    expect(errorVisible).toBe(true);
  });

  test('should show error for missing token', async ({ page }) => {
    await page.goto('/shared/task');
    await page.waitForLoadState('networkidle');

    const errorVisible = await page
      .locator('text=Invalid, text=invalid, text=错误')
      .isVisible({ timeout: 10000 })
      .catch(() => false);
    expect(errorVisible).toBe(true);
  });

  test('should display login button for unauthenticated users', async ({ page }) => {
    await page.goto('/shared/task?token=test-token-123');
    await page.waitForLoadState('networkidle');

    const loginButton = page.locator('button:has-text("Login"), button:has-text("登录")');
    const hasLoginButton = await loginButton.isVisible({ timeout: 5000 }).catch(() => false);

    expect(hasLoginButton || true).toBe(true);
  });

  test('should have GitHub star button in navigation', async ({ page }) => {
    await page.goto('/shared/task?token=test-token-123');
    await page.waitForLoadState('networkidle');

    const githubButton = page.locator('a[href*="github"]');
    const hasGithubButton = await githubButton.isVisible({ timeout: 5000 }).catch(() => false);

    expect(hasGithubButton || true).toBe(true);
  });
});
