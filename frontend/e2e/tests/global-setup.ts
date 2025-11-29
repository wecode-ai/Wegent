import { test as setup, expect } from '@playwright/test'
import { login, TEST_USER } from '../utils/auth'
import * as fs from 'fs'
import * as path from 'path'

const authFile = path.join(__dirname, '../.auth/user.json')

/**
 * Global setup - run once before all tests
 * Authenticates and saves storage state for reuse
 */
setup('authenticate', async ({ page }) => {
  // Ensure .auth directory exists
  const authDir = path.dirname(authFile)
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true })
  }

  // Perform login
  await login(page, TEST_USER.username, TEST_USER.password)

  // Verify login was successful by checking we're on a protected page
  await expect(page).not.toHaveURL(/\/login/)

  // Save storage state (cookies, localStorage)
  await page.context().storageState({ path: authFile })

  console.log('Authentication successful, storage state saved')
})
