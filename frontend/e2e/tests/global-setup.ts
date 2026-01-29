import { test as setup, expect } from '@playwright/test'
import { login, TEST_USER } from '../utils/auth'
import * as path from 'path'
import { promises as fsPromises } from 'fs'

const authFile = path.join(__dirname, '../.auth/user.json')

/**
 * Global setup - run once before all tests
 * Authenticates and saves storage state for reuse
 */
setup('authenticate', async ({ page }) => {
  // Ensure .auth directory exists using async operations
  const authDir = path.dirname(authFile)
  try {
    await fsPromises.access(authDir)
  } catch {
    await fsPromises.mkdir(authDir, { recursive: true })
  }

  // Perform login
  await login(page, TEST_USER.username, TEST_USER.password)

  // Verify login was successful by checking we're on a protected page
  await expect(page).not.toHaveURL(/\/login/)

  // Mark admin setup as complete to prevent the setup wizard dialog from blocking tests
  // This is necessary because the GlobalAdminSetupWizard component shows a modal dialog
  // for admin users when admin_setup_completed is false, which intercepts all pointer events
  const apiBaseUrl = process.env.E2E_API_URL || 'http://localhost:8000'
  try {
    // Get auth token from localStorage
    const token = await page.evaluate(() => localStorage.getItem('auth_token'))
    if (token) {
      const response = await page.request.post(`${apiBaseUrl}/api/admin/setup-complete`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      })
      if (response.ok()) {
        console.log('Admin setup marked as complete')
      } else {
        console.warn(`Failed to mark admin setup as complete: ${response.status()}`)
      }
    }
  } catch (error) {
    console.warn('Warning: Could not mark admin setup as complete:', error)
    // Continue anyway - this is not critical for all tests
  }

  // Save storage state (cookies, localStorage)
  await page.context().storageState({ path: authFile })

  console.log('Authentication successful, storage state saved')
})
