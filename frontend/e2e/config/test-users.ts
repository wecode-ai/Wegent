/**
 * Test users configuration
 */
import {
  buildBootstrapAdminUser,
  buildE2EAdminUser,
  buildE2ERegularUser,
} from '../utils/auth-state'

export interface TestUser {
  username: string
  password: string
  role: 'admin' | 'user'
  description: string
}

/**
 * Bootstrap admin user for provisioning isolated E2E users.
 */
export const BOOTSTRAP_ADMIN_USER: TestUser = buildBootstrapAdminUser()

/**
 * Default admin user for E2E tests
 */
export const ADMIN_USER: TestUser = buildE2EAdminUser()

/**
 * Default regular user for E2E tests
 * Note: This user should be created during test setup if it does not exist
 */
export const REGULAR_USER: TestUser = buildE2ERegularUser()

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
