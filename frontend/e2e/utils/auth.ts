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

  // Wait for the login form to be visible
  await page.waitForSelector('input[name="username"], input[type="text"]', {
    state: 'visible',
  })

  // Fill in credentials
  const usernameInput = page.locator(
    'input[name="username"], input[type="text"]'
  )
  const passwordInput = page.locator(
    'input[name="password"], input[type="password"]'
  )

  await usernameInput.fill(username)
  await passwordInput.fill(password)

  // Click login button
  const loginButton = page.locator('button[type="submit"]')
  await loginButton.click()

  // Wait for navigation to complete (redirect to /chat or dashboard)
  await page.waitForURL(/\/(chat|$)/, { timeout: 15000 })
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
  if (await logoutButton.isVisible()) {
    await logoutButton.click()
    await page.waitForURL(/\/login/)
  }
}

/**
 * Check if user is logged in
 * @param page Playwright page object
 */
export async function isLoggedIn(page: Page): Promise<boolean> {
  try {
    await page.goto('/')
    await page.waitForTimeout(1000)
    const currentUrl = page.url()
    return !currentUrl.includes('/login')
  } catch {
    return false
  }
}
