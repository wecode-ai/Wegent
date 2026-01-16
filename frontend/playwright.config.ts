import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright configuration for Wegent E2E testing
 * Optimized for faster execution while maintaining test reliability
 * @see https://playwright.dev/docs/test-configuration
 */
export default defineConfig({
  testDir: './e2e/tests',

  /* Enable full parallelization for faster execution */
  fullyParallel: true,
  /* Increase workers: CI uses more workers per shard, local uses available CPUs */
  workers: process.env.CI ? 4 : '50%',

  /* Fail the build on CI if you accidentally left test.only in the source code */
  forbidOnly: !!process.env.CI,

  /* Retry once on CI to handle flaky tests, reduce from 2 to 1 for speed */
  retries: process.env.CI ? 1 : 0,

  /* Reporter to use - use blob reporter for sharded runs */
  reporter: process.env.CI
    ? [['list'], ['blob', { outputDir: 'blob-report' }], ['html', { open: 'never' }]]
    : [['html', { open: 'never' }], ['list']],

  /* Output directory for test artifacts */
  outputDir: 'test-results',

  /* Shared settings for all the projects below */
  use: {
    /* Base URL to use in actions like `await page.goto('/')` */
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:3000',

    /* Collect trace only on first retry to save time */
    trace: 'on-first-retry',

    /* Capture screenshot only on failure */
    screenshot: 'only-on-failure',

    /* Disable video recording for speed (enable only when debugging) */
    video: 'off',

    /* Test ID attribute for locators */
    testIdAttribute: 'data-testid',

    /* Viewport size */
    viewport: { width: 1280, height: 720 },

    /* Action timeout - keep at 15s for API calls that may take longer */
    actionTimeout: 15000,

    /* Navigation timeout */
    navigationTimeout: 30000,
  },

  /* Configure projects for major browsers */
  projects: [
    /* Setup project - runs once to authenticate */
    {
      name: 'setup',
      testMatch: /global-setup\.ts/,
      teardown: 'cleanup',
    },
    {
      name: 'cleanup',
      testMatch: /global-teardown\.ts/,
    },
    {
      name: 'chromium',
      testIgnore: /api\/.*\.spec\.ts/, // Exclude API tests from chromium project
      use: {
        ...devices['Desktop Chrome'],
        storageState: './e2e/.auth/user.json',
      },
      dependencies: ['setup'],
    },
    /* API tests - no browser needed, no setup dependency */
    {
      name: 'api',
      testMatch: /api\/.*\.spec\.ts/,
      use: {
        // API tests don't need a browser
        baseURL: process.env.E2E_API_URL || 'http://localhost:8000',
      },
    },
    /* Performance tests */
    {
      name: 'performance',
      testMatch: /performance\/.*\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        storageState: './e2e/.auth/user.json',
      },
      dependencies: ['setup'],
    },
    /* Visual regression tests */
    {
      name: 'visual',
      testMatch: /visual\/.*\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        storageState: './e2e/.auth/user.json',
      },
      dependencies: ['setup'],
    },
  ],

  /* Test timeout - keep at 60s for complex tests */
  timeout: 60000,

  /* Timeout for each expect assertion */
  expect: {
    timeout: 10000,
    /* Visual comparison options */
    toHaveScreenshot: {
      maxDiffPixels: 100,
      threshold: 0.2,
    },
    toMatchSnapshot: {
      maxDiffPixelRatio: 0.1,
    },
  },

  /* Snapshot path template */
  snapshotPathTemplate: '{testDir}/__snapshots__/{testFilePath}/{arg}{ext}',

  /* Run local dev server before starting the tests (optional for CI) */
  // webServer: {
  //   command: 'npm run dev',
  //   url: 'http://localhost:3000',
  //   reuseExistingServer: !process.env.CI,
  // },
})
