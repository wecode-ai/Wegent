/**
 * Environment configuration for E2E tests
 */

export interface E2EEnvironment {
  baseUrl: string
  apiUrl: string
  timeout: number
  retries: number
  isCI: boolean
}

/**
 * Get current environment configuration
 */
export function getEnvironment(): E2EEnvironment {
  const isCI = !!process.env.CI

  return {
    baseUrl: process.env.E2E_BASE_URL || 'http://localhost:3000',
    apiUrl: process.env.E2E_API_URL || 'http://localhost:8000',
    timeout: parseInt(process.env.E2E_TIMEOUT || '30000', 10),
    retries: isCI ? 2 : 0,
    isCI,
  }
}

/**
 * Default test timeouts
 */
export const Timeouts = {
  /** Default page load timeout */
  pageLoad: 30000,
  /** Default element wait timeout */
  element: 10000,
  /** Default API response timeout */
  api: 15000,
  /** Default toast notification timeout */
  toast: 10000,
  /** Default animation timeout */
  animation: 1000,
  /** Default navigation timeout */
  navigation: 30000,
  /** Long running operation timeout */
  longOperation: 60000,
}

/**
 * Test data prefixes
 */
export const TestPrefixes = {
  bot: 'e2e-bot',
  team: 'e2e-team',
  model: 'e2e-model',
  group: 'e2e-group',
  user: 'e2e-user',
  task: 'e2e-task',
  shell: 'e2e-shell',
}

/**
 * Feature flags for tests
 */
export const FeatureFlags = {
  /** Enable visual regression tests */
  visualRegression: process.env.E2E_VISUAL_REGRESSION === 'true',
  /** Enable performance tests */
  performanceTests: process.env.E2E_PERFORMANCE === 'true',
  /** Enable API tests */
  apiTests: process.env.E2E_API_TESTS !== 'false',
  /** Skip cleanup after tests */
  skipCleanup: process.env.E2E_SKIP_CLEANUP === 'true',
}

/**
 * Performance thresholds
 */
export const PerformanceLimits = {
  pageLoad: {
    login: 2000,
    settings: 3000,
    chat: 3000,
    admin: 3000,
  },
  apiResponse: {
    list: 1000,
    create: 2000,
    update: 2000,
    delete: 1000,
  },
}

/**
 * Routes used in tests
 */
export const Routes = {
  login: '/login',
  chat: '/chat',
  code: '/code',
  settings: '/settings',
  settingsBots: '/settings?tab=bots',
  settingsTeams: '/settings?tab=team',
  settingsModels: '/settings?tab=models',
  settingsShells: '/settings?tab=shells',
  settingsSkills: '/settings?tab=skills',
  settingsIntegrations: '/settings?tab=integrations',
  admin: '/admin',
  adminUsers: '/admin/users',
  adminModels: '/admin/models',
  sharedTask: '/shared/task',
}
