import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for Wegent E2E testing
 * @see https://playwright.dev/docs/test-configuration
 */
export default defineConfig({
  testDir: './e2e/tests',

  /* Run tests in parallel within same file, but limit workers to avoid data conflicts */
  fullyParallel: false,
  workers: process.env.CI ? 2 : 3,

  /* Fail the build on CI if you accidentally left test.only in the source code */
  forbidOnly: !!process.env.CI,

  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,

  /* Reporter to use */
  reporter: process.env.CI
    ? [
        ['list'],
        ['json', { outputFile: 'e2e-results.json' }],
        ['html', { open: 'never' }],
        ['junit', { outputFile: 'e2e-results.xml' }],
      ]
    : [['html', { open: 'never' }], ['list']],

  /* Output directory for test artifacts */
  outputDir: 'test-results',

  /* Shared settings for all the projects below */
  use: {
    /* Base URL to use in actions like `await page.goto('/')` */
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:3000',

    /* Collect trace when retrying the failed test */
    trace: {
      mode: 'retain-on-failure',
      snapshots: true,
      screenshots: true,
      sources: true,
    },

    /* Capture screenshot only on failure */
    screenshot: 'only-on-failure',

    /* Record video only on failure */
    video: 'retain-on-failure',

    /* Test ID attribute for locators */
    testIdAttribute: 'data-testid',

    /* Viewport size */
    viewport: { width: 1280, height: 720 },

    /* Action timeout */
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

  /* Timeout for each test */
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
});
