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

  // Save storage state (cookies, localStorage)
  await page.context().storageState({ path: authFile })

  console.log('Authentication successful, storage state saved')
})
