import { defineConfig, devices } from '@playwright/test'

const port = Number(process.env.WEWORK_E2E_PORT ?? 4174)
const baseURL = process.env.WEWORK_E2E_BASE_URL ?? `http://127.0.0.1:${port}`
const responseApiMockPort = Number(process.env.WEWORK_RESPONSE_API_MOCK_PORT ?? 9998)
const responseApiMockURL =
  process.env.WEWORK_RESPONSE_API_MOCK_URL ?? `http://127.0.0.1:${responseApiMockPort}`
const sitesUpstreamMockPort = Number(process.env.WEWORK_SITES_UPSTREAM_MOCK_PORT ?? 9997)
const sitesUpstreamMockURL =
  process.env.WEWORK_SITES_UPSTREAM_MOCK_URL ?? `http://127.0.0.1:${sitesUpstreamMockPort}`
const connectorUpstreamMockPort = Number(process.env.WEWORK_CONNECTOR_UPSTREAM_MOCK_PORT ?? 9996)
const connectorUpstreamMockURL =
  process.env.WEWORK_CONNECTOR_UPSTREAM_MOCK_URL ?? `http://127.0.0.1:${connectorUpstreamMockPort}`

export default defineConfig({
  testDir: './e2e/tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  outputDir: 'test-results',
  use: {
    baseURL,
    testIdAttribute: 'data-testid',
    trace: process.env.CI ? 'retain-on-failure' : 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
    viewport: { width: 1280, height: 800 },
    actionTimeout: 15000,
    navigationTimeout: 30000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: 'node e2e/utils/mock-response-api-server.mjs',
      url: `${responseApiMockURL}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 30000,
      env: {
        WEWORK_RESPONSE_API_MOCK_PORT: String(responseApiMockPort),
      },
    },
    {
      command: 'node e2e/utils/mock-sites-upstream-server.mjs',
      url: `${sitesUpstreamMockURL}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 30000,
      env: {
        WEWORK_SITES_UPSTREAM_MOCK_PORT: String(sitesUpstreamMockPort),
      },
    },
    {
      command: 'node e2e/utils/mock-connector-upstream-server.mjs',
      url: `${connectorUpstreamMockURL}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 30000,
      env: {
        WEWORK_CONNECTOR_UPSTREAM_MOCK_PORT: String(connectorUpstreamMockPort),
      },
    },
    {
      command: `pnpm exec vite --host 127.0.0.1 --port ${port} --mode e2e`,
      url: baseURL,
      reuseExistingServer: !process.env.CI,
      timeout: 120000,
      env: {
        VITE_WEWORK_E2E: 'true',
        VITE_WEWORK_RUNTIME_MODE: 'backend',
        VITE_LOGIN_MODE: 'password',
        WEWORK_RESPONSE_API_MOCK_URL: responseApiMockURL,
        WEWORK_SITES_UPSTREAM_MOCK_URL: sitesUpstreamMockURL,
        WEWORK_CONNECTOR_UPSTREAM_MOCK_URL: connectorUpstreamMockURL,
      },
    },
  ],
  timeout: 60000,
  expect: {
    timeout: 10000,
  },
})
