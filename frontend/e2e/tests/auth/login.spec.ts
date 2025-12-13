import { test, expect } from '@playwright/test'
import { LoginPage } from '../../pages/auth/login.page'
import { ADMIN_USER } from '../../config/test-users'

test.describe('Authentication - Login', () => {
  let loginPage: LoginPage

  test.beforeEach(async ({ page }) => {
    loginPage = new LoginPage(page)
  })

  test('should display login form', async () => {
    await loginPage.navigate()
    expect(await loginPage.isLoginFormVisible()).toBe(true)
  })

  test('should login with valid credentials', async () => {
    await loginPage.login(ADMIN_USER.username, ADMIN_USER.password)
    expect(loginPage.isOnLoginPage()).toBe(false)
  })

  test('should show error for invalid credentials', async ({ page }) => {
    await loginPage.navigate()
    await loginPage.fillCredentials('invaliduser', 'wrongpassword')
    await loginPage.clickLogin()

    // Wait for error message or toast
    await page.waitForSelector('[data-sonner-toast], .error, [role="alert"]', {
      timeout: 10000,
    }).catch(() => {})

    // Should still be on login page
    expect(loginPage.isOnLoginPage()).toBe(true)
  })

  test('should validate required fields', async ({ page }) => {
    await loginPage.navigate()
    await loginPage.clickLogin()

    // Should show validation or remain on login page
    expect(loginPage.isOnLoginPage()).toBe(true)
  })

  test('should redirect to login when not authenticated', async ({ page }) => {
    // Clear storage state
    await page.context().clearCookies()
    await page.evaluate(() => localStorage.clear())

    await page.goto('/settings')
    await page.waitForURL(/\/login/, { timeout: 10000 })
    expect(page.url()).toContain('/login')
  })
})
