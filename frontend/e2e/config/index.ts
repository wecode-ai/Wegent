/**
 * E2E Test Configuration Index
 * Export all configuration for easy importing
 */

// Test Users
export { ADMIN_USER, REGULAR_USER, getTestUser, getEnvTestUser } from './test-users'
export type { TestUser } from './test-users'

// Environment
export {
  getEnvironment,
  Timeouts,
  TestPrefixes,
  FeatureFlags,
  PerformanceLimits,
  Routes,
} from './environment'
export type { E2EEnvironment } from './environment'
