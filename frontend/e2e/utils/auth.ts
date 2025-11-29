import { Page } from '@playwright/test'

/**
 * Test credentials for E2E testing
 */
export const TEST_USER = {
  username: 'admin',
  password: 'Wegent2025!',
}

/**
 * Login to the application
 * @param page Playwright page object
 * @param username Username to login with
 * @param password Password to login with
 */
export async function login(
  page: Page,
  username: string = TEST_USER.username,
  password: string = TEST_USER.password
): Promise<void> {
  await page.goto('/login')

  // Wait for the login form to be visible (field name is user_name)
  await page.waitForSelector(
    'input[name="user_name"], input[name="username"], input[type="text"]',
    {
      state: 'visible',
      timeout: 30000,
    }
  )

  // Fill in credentials - the form field name is user_name
  const usernameInput = page
    .locator('input[name="user_name"], input[name="username"], input[type="text"]')
    .first()
  const passwordInput = page
    .locator('input[name="password"], input[type="password"]')
    .first()

  // Clear and fill username
  await usernameInput.clear()
  await usernameInput.fill(username)

  // Clear and fill password
  await passwordInput.clear()
  await passwordInput.fill(password)

  // Click login button
  const loginButton = page.locator('button[type="submit"]')
  await loginButton.click()

  // Wait for login to complete - redirect away from /login page
  // The app redirects to /chat after successful login
  try {
    await page.waitForURL((url) => !url.pathname.includes('/login'), {
      timeout: 30000,
    })
  } catch (error) {
    // Check if there's an error message on the page
    const errorMessage = await page
      .locator('.error, [data-error], [role="alert"]:not([data-sonner-toaster])')
      .textContent()
      .catch(() => null)
    if (errorMessage) {
      throw new Error(`Login failed: ${errorMessage}`)
    }
    throw error
  }
}

/**
 * Logout from the application
 * @param page Playwright page object
 */
export async function logout(page: Page): Promise<void> {
  // Navigate to settings or find logout button
  await page.goto('/settings')

  // Look for logout button and click
  const logoutButton = page.locator(
    'button:has-text("Logout"), button:has-text("退出登录"), button:has-text("Sign out")'
  )
  if (await logoutButton.isVisible({ timeout: 5000 }).catch(() => false)) {
    await logoutButton.click()
    await page.waitForURL(/\/login/, { timeout: 10000 })
  }
}

/**
 * Check if user is logged in
 * @param page Playwright page object
 */
export async function isLoggedIn(page: Page): Promise<boolean> {
  try {
    await page.goto('/')
    // Wait for either redirect to login or content load
    await Promise.race([
      page.waitForURL(/\/login/, { timeout: 5000 }),
      page.waitForSelector('main, [data-testid="app-content"]', {
        state: 'visible',
        timeout: 5000,
      }),
    ])
    const currentUrl = page.url()
    return !currentUrl.includes('/login')
  } catch {
    return false
  }
}
