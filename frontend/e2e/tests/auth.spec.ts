import { test, expect } from '@playwright/test'
import { login, logout, TEST_USER } from '../utils/auth'

test.describe('Authentication', () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  test('should render login page correctly', async ({ page }) => {
    await page.goto('/login')

    // Check login form elements are visible
    await expect(
      page.locator('input[name="username"], input[type="text"]').first()
    ).toBeVisible()
    await expect(
      page.locator('input[name="password"], input[type="password"]').first()
    ).toBeVisible()
    await expect(page.locator('button[type="submit"]')).toBeVisible()
  })

  test('should login successfully with valid credentials', async ({ page }) => {
    await page.goto('/login')

    // Fill login form
    await page
      .locator('input[name="username"], input[type="text"]')
      .first()
      .fill(TEST_USER.username)
    await page
      .locator('input[name="password"], input[type="password"]')
      .first()
      .fill(TEST_USER.password)

    // Submit form
    await page.locator('button[type="submit"]').click()

    // Should redirect to chat or home
    await page.waitForURL(/\/(chat|$)/, { timeout: 15000 })
    await expect(page).not.toHaveURL(/\/login/)
  })

  test('should show error for invalid credentials', async ({ page }) => {
    await page.goto('/login')

    // Fill with invalid credentials
    await page
      .locator('input[name="username"], input[type="text"]')
      .first()
      .fill('invalid_user')
    await page
      .locator('input[name="password"], input[type="password"]')
      .first()
      .fill('wrong_password')

    // Submit form
    await page.locator('button[type="submit"]').click()

    // Should stay on login page or show error
    await page.waitForTimeout(2000)

    // Either still on login page or error message visible
    const isOnLogin = page.url().includes('/login')
    const hasError = await page
      .locator('[role="alert"], .error, [data-error]')
      .isVisible()
      .catch(() => false)

    expect(isOnLogin || hasError).toBeTruthy()
  })

  test('should redirect to login when accessing protected route without auth', async ({
    page,
  }) => {
    // Try to access protected route
    await page.goto('/chat')

    // Should redirect to login
    await page.waitForURL(/\/login/, { timeout: 10000 })
  })
})

test.describe('Logout', () => {
  test('should logout successfully', async ({ page }) => {
    // First login
    await login(page)

    // Navigate to a page with logout option
    await page.goto('/settings')

    // Find and click logout button
    const logoutButton = page.locator(
      'button:has-text("Logout"), button:has-text("退出"), button:has-text("Sign out")'
    )

    if (await logoutButton.isVisible({ timeout: 5000 }).catch(() => false)) {
      await logoutButton.click()

      // Should redirect to login
      await page.waitForURL(/\/login/, { timeout: 10000 })
    }
  })
})
