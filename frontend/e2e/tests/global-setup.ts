import { test as setup, expect } from '@playwright/test'
import { login, TEST_USER } from '../utils/auth'
import * as path from 'path'
import { promises as fsPromises } from 'fs'

const authFile = path.join(__dirname, '../.auth/user.json')

/**
 * Global setup - run once before all tests
 * Authenticates and saves storage state for reuse
 */
setup('authenticate', async ({ page, request }) => {
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
      // First, change the admin password via API to satisfy the password change requirement
      // We change it to the same value - bcrypt will generate a different hash due to random salt,
      // so admin_password_changed will become true while keeping the same login credentials
      const passwordResponse = await page.request.put(`${apiBaseUrl}/api/users/me/password`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        data: {
          new_password: TEST_USER.password,
          confirm_password: TEST_USER.password,
        },
      })
      if (passwordResponse.ok()) {
        console.log('Admin password changed successfully (same credentials, different hash)')
      } else {
        throw new Error(
          `Failed to change admin password: ${passwordResponse.status()} - ${await passwordResponse.text()}`
        )
      }

      // Now mark setup as complete
      const response = await page.request.post(`${apiBaseUrl}/api/admin/setup-complete`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      })
      if (response.ok()) {
        console.log('Admin setup marked as complete')
      } else {
        throw new Error(
          `Failed to mark admin setup as complete: ${response.status()} - ${await response.text()}`
        )
      }
    }
  } catch (error) {
    throw new Error(`Admin setup failed during global-setup: ${error}`)
  }

  // Save storage state (cookies, localStorage)
  await page.context().storageState({ path: authFile })

  console.log('Authentication successful, storage state saved')

  // Double-check: Mark admin setup as complete using request context
  // This is a backup in case the first attempt failed
  try {
    const authToken = await page.evaluate(() => {
      return localStorage.getItem('auth_token')
    })

    if (authToken) {
      const baseURL = process.env.E2E_API_URL || 'http://localhost:8000'

      // Ensure password is changed first (idempotent - safe to call again)
      await request
        .put(`${baseURL}/api/users/me/password`, {
          headers: {
            Authorization: `Bearer ${authToken}`,
            'Content-Type': 'application/json',
          },
          data: {
            new_password: TEST_USER.password,
            confirm_password: TEST_USER.password,
          },
        })
        .catch(() => {
          // Ignore - may already be done
        })

      const response = await request.post(`${baseURL}/api/admin/setup-complete`, {
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
      })
      if (response.ok()) {
        console.log('Admin setup marked as complete')
      } else {
        console.log('Admin setup API returned:', response.status(), '- may already be complete')
      }
    }
  } catch (error) {
    // Ignore errors - setup may already be complete or user may not be admin
    console.log('Note: Could not mark admin setup as complete:', error)
  }
})
