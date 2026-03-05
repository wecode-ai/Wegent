/**
 * Authentication Setup Script
 *
 * This script opens a browser for QR code login, detects successful login,
 * and saves the browser state for reuse in tests.
 *
 * Usage: npm run setup-auth
 */

import { chromium } from '@playwright/test'
import * as path from 'path'
import * as fs from 'fs'

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000'

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

async function setupAuth() {
  console.log('Starting authentication setup...')
  console.log(`Target URL: ${BASE_URL}`)

  // Ensure .auth directory exists
  const authDir = path.dirname(AUTH_FILE)
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true })
  }

  // Launch browser in headed mode for QR code scanning
  const browser = await chromium.launch({
    headless: false,
    slowMo: 100,
  })

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  })

  const page = await context.newPage()

  try {
    // Navigate to the target URL
    console.log('Opening login page...')
    await page.goto(BASE_URL, { waitUntil: 'networkidle' })

    console.log('')
    console.log('='.repeat(50))
    console.log('Please scan the QR code to login.')
    console.log('Waiting for sidebar to appear (login success)...')
    console.log('='.repeat(50))
    console.log('')

    // Wait for sidebar to appear (indicates successful login)
    // Timeout: 5 minutes for user to scan QR code
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
