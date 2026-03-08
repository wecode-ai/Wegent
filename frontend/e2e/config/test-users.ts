/**
 * Test users configuration
 */

export interface TestUser {
  username: string
  password: string
  role: 'admin' | 'user'
  description: string
}

/**
 * Default admin password (before change) - used only for initial login in global-setup
 */
export const DEFAULT_ADMIN_Password = 'Wegent2025!'

/**
 * E2E admin password (after change) - used for all API calls after setup
 */
export const E2E_ADMIN_Password = 'WegentE2E2025!'

/**
 * Default admin user for E2E tests
 * Note: password is the E2E password (changed during global-setup), not the default
 */
export const ADMIN_USER: TestUser = {
  username: 'admin',
  password: E2E_ADMIN_Password,
  role: 'admin',
  description: 'Default admin user with full access',
}

/**
 * Default regular user for E2E tests
 * Note: This user should be created during test setup if it does not exist
 */
export const REGULAR_USER: TestUser = {
  username: 'e2e-user',
  password: 'Test@12345',
  role: 'user',
  description: 'Regular user with limited access',
}

/**
 * Get test user by role
 */
export function getTestUser(role: 'admin' | 'user'): TestUser {
  return role === 'admin' ? ADMIN_USER : REGULAR_USER
}

/**
 * Test credentials from environment variables (override defaults)
 */
export function getEnvTestUser(): TestUser {
  return {
    username: process.env.E2E_TEST_USER || ADMIN_USER.username,
    password: process.env.E2E_TEST_password || ADMIN_USER.password,
    role: (process.env.E2E_TEST_ROLE as 'admin' | 'user') || 'admin',
    description: 'User from environment variables',
  }
}
