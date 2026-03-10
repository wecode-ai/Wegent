/**
 * Authentication Setup Script
 *
 * This script opens a browser for manual login, detects successful login,
 * and saves the browser state for reuse in tests.
 *
 * Supports two login modes:
 * - Username/password login (local testing environment)
 * - OIDC login with QR code (online environment)
 *
 * Usage: npm run setup-auth
 */

import { chromium, Page } from '@playwright/test'
import * as path from 'path'
import * as fs from 'fs'

const BASE_URL = process.env.TEST_BASE_URL || 'https://wegent.intra.weibo.com'

// Determine auth file path from environment or generate from URL
function getAuthFilePath(): string {
  if (process.env.AUTH_FILE) {
    return process.env.AUTH_FILE
  }

  // Extract domain from URL
  const domain = BASE_URL
    .replace(/^https?:\/\//, '')
    .replace(/[:\/].*$/, '')
    .replace(/[^a-zA-Z0-9.-]/g, '_') || 'localhost'

  return path.join(__dirname, '.auth', `user_${domain}.json`)
}

const AUTH_FILE = getAuthFilePath()

// Detect if the page has username/password login form
async function hasPasswordLoginForm(page: Page): Promise<boolean> {
  try {
    const usernameInput = await page.$('input[name="user_name"], input[name="username"]')
    const passwordInput = await page.$('input[name="password"], input[type="password"]')
    return !!(usernameInput && passwordInput)
  } catch {
    return false
  }
}

// Detect if the page has OIDC login button
async function hasOidcLogin(page: Page): Promise<boolean> {
  try {
    // Look for OIDC login button (usually links to /api/auth/oidc/login)
    const oidcButton = await page.$('a[href*="oidc"], button:has-text("OIDC"), button:has-text("SSO")')
    return !!oidcButton
  } catch {
    return false
  }
}

async function setupAuth() {
  console.log('Starting authentication setup...')
  console.log(`Target URL: ${BASE_URL}`)

  // Ensure .auth directory exists
  const authDir = path.dirname(AUTH_FILE)
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true })
  }

  // Launch browser in headed mode for manual login
  const browser = await chromium.launch({
    headless: false,
    slowMo: 100,
  })

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  })

  const page = await context.newPage()

  try {
    // Navigate to the target URL with longer timeout for slow local servers
    console.log('Opening login page...')
    await page.goto(BASE_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60000, // 60 seconds for slow local servers
    })

    // Wait for page to stabilize
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {
      // Ignore networkidle timeout, page might still be usable
      console.log('Note: Page did not reach networkidle state, continuing anyway...')
    })

    // Detect login mode
    const hasPasswordForm = await hasPasswordLoginForm(page)
    const hasOidc = await hasOidcLogin(page)

    console.log('')
    console.log('='.repeat(50))

    if (hasPasswordForm) {
      console.log('Detected: Username/password login form')
      console.log('')
      console.log('Please enter your credentials in the browser:')
      console.log('  1. Enter your username')
      console.log('  2. Enter your password')
      console.log('  3. Click the login button')
    } else if (hasOidc) {
      console.log('Detected: OIDC/SSO login')
      console.log('')
      console.log('Please complete the OIDC login:')
      console.log('  - Click the OIDC/SSO login button')
      console.log('  - Scan QR code or enter credentials as required')
    } else {
      console.log('Login method not detected automatically.')
      console.log('')
      console.log('Please complete the login manually in the browser.')
    }

    console.log('')
    console.log('Waiting for successful login (sidebar to appear)...')
    console.log('Timeout: 5 minutes')
    console.log('='.repeat(50))
    console.log('')

    // Wait for sidebar to appear (indicates successful login)
    // Timeout: 5 minutes for user to complete login
    await page.waitForSelector('[data-tour="task-sidebar"]', {
      state: 'visible',
      timeout: 300000, // 5 minutes
    })

    console.log('Login successful! Sidebar detected.')

    // Wait a bit for any additional auth cookies/tokens to be set
    await page.waitForTimeout(2000)

    // Save the storage state (cookies, localStorage, etc.)
    await context.storageState({ path: AUTH_FILE })
    console.log(`Authentication state saved to: ${AUTH_FILE}`)

    console.log('')
    console.log('='.repeat(50))
    console.log('Setup complete! You can now run tests with:')
    console.log('  npm test')
    console.log('='.repeat(50))
  } catch (error) {
    console.error('Authentication setup failed:', error)
    process.exit(1)
  } finally {
    await browser.close()
  }
}

setupAuth()
