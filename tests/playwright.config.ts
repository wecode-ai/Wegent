import { defineConfig, devices } from '@playwright/test'
import * as path from 'path'

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000'

// Determine auth file path
// 1. Use PLAYWRIGHT_AUTH_FILE if set (from run-tests.sh)
// 2. Fall back to TEST_BASE_URL to generate filename
// 3. Default to localhost
function getAuthFilePath(): string {
  if (process.env.PLAYWRIGHT_AUTH_FILE) {
    return process.env.PLAYWRIGHT_AUTH_FILE
  }

  // Extract domain from URL
  const url = process.env.TEST_BASE_URL || 'http://localhost:3000'
  const domain = url
    .replace(/^https?:\/\//, '')
    .replace(/[:\/].*$/, '')
    .replace(/[^a-zA-Z0-9.-]/g, '_') || 'localhost'

  return path.join(__dirname, '.auth', `user_${domain}.json`)
}

const authFile = getAuthFilePath()

export default defineConfig({
  testDir: './specs',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'html',

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',

    // Use saved authentication state (domain-specific)
    storageState: authFile,
  },

  // Timeout settings
  timeout: 120000, // 2 minutes for each test
  expect: {
    timeout: 30000, // 30 seconds for assertions
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
