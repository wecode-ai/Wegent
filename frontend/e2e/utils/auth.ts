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
  console.log('Starting login process...')
  await page.goto('/login')
  console.log('Navigated to /login page')

  // Wait for the login form to be visible (field name is user_name)
  await page.waitForSelector(
    'input[name="user_name"], input[name="username"], input[type="text"]',
    {
      state: 'visible',
      timeout: 30000,
    }
  )
  console.log('Login form is visible')

  // Fill in credentials - the form field name is user_name
  const usernameInput = page
    .locator('input[name="user_name"], input[name="username"], input[type="text"]')
    .first()
  const passwordInput = page.locator('input[name="password"], input[type="password"]').first()

  // Clear and fill username
  await usernameInput.clear()
  await usernameInput.fill(username)
  console.log(`Filled username: ${username}`)

  // Clear and fill password
  await passwordInput.clear()
  await passwordInput.fill(password)
  console.log('Filled password')

  // Set up response listener before clicking submit
  const responsePromise = page.waitForResponse(
    response => response.url().includes('/api/auth/login'),
    { timeout: 30000 }
  )

  // Click login button
  const loginButton = page.locator('button[type="submit"]')
  await loginButton.click()
  console.log('Clicked login button')

  // Wait for the login API response
  try {
    const response = await responsePromise
    console.log(`Login API response status: ${response.status()}`)

    if (!response.ok()) {
      const responseBody = await response.text().catch(() => 'Unable to read response body')
      console.error(`Login API failed with status ${response.status()}: ${responseBody}`)
      throw new Error(`Login API returned ${response.status()}: ${responseBody}`)
    }

    const responseBody = await response.json().catch(() => null)
    console.log('Login API response received:', responseBody ? 'success' : 'no body')

    // After successful login, wait for the /users/me API call to complete
    // This ensures the UserContext has loaded the user data
    await page
      .waitForResponse(
        response => response.url().includes('/api/users/me') && response.status() === 200,
        { timeout: 10000 }
      )
      .catch(error => {
        console.warn('Warning: /api/users/me request not detected or timed out:', error)
        // Continue anyway as this might not be critical
      })
    console.log('User data loaded')
  } catch (error) {
    console.error('Login API request failed:', error)
    // Take a screenshot for debugging
    await page.screenshot({ path: 'test-results/login-api-failure.png', fullPage: true })
    throw new Error(`Login API request failed: ${error}`)
  }

  // Wait for login to complete - redirect away from /login page
  // The app redirects to /chat after successful login
  console.log('Waiting for redirect after login...')
  try {
    await page.waitForURL(url => !url.pathname.includes('/login'), {
      timeout: 30000,
    })
    console.log(`Successfully redirected to: ${page.url()}`)
  } catch (_error) {
    console.error('Redirect timeout - still on:', page.url())

    // Check localStorage for token
    const hasToken = await page.evaluate(() => {
      return localStorage.getItem('auth_token') !== null
    })
    console.log('Token in localStorage:', hasToken)

    // Check if there's an error message on the page
    const errorMessage = await page
      .locator('.error, [data-error], [role="alert"]:not([data-sonner-toaster])')
      .textContent()
      .catch(() => null)

    // Capture page HTML for debugging
    const pageContent = await page.content()
    console.log('Page content length:', pageContent.length)

    // Take a screenshot for debugging
    await page.screenshot({ path: 'test-results/login-redirect-failure.png', fullPage: true })

    if (errorMessage) {
      throw new Error(`Login failed: ${errorMessage}`)
    }
    throw new Error(`Login redirect timeout. Token present: ${hasToken}. URL: ${page.url()}`)
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
