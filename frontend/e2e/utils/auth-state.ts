import type { TestUser } from '../config/test-users'

const TOKEN_KEY = 'auth_token'
const TOKEN_EXPIRE_KEY = 'auth_token_expire'
const TOKEN_COOKIE_NAME = 'auth_token'

type EnvMap = Partial<Record<string, string | undefined>>
type StorageState = {
  cookies: Array<{
    name: string
    value: string
    domain: string
    path: string
    expires: number
    httpOnly: boolean
    secure: boolean
    sameSite: 'Strict' | 'Lax' | 'None'
  }>
  origins: Array<{
    origin: string
    localStorage: Array<{ name: string; value: string }>
  }>
}

function sanitizeSuffix(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return normalized || 'local'
}

function getShardSuffix(env: EnvMap = process.env): string {
  if (env.E2E_USER_SUFFIX) {
    return sanitizeSuffix(env.E2E_USER_SUFFIX)
  }

  if (env.E2E_SHARD_INDEX) {
    return `shard-${sanitizeSuffix(env.E2E_SHARD_INDEX)}`
  }

  return 'local'
}

function shouldUseIsolatedUsers(env: EnvMap = process.env): boolean {
  return env.E2E_USE_ISOLATED_USERS !== 'false'
}

function requireEnvPassword(
  env: EnvMap,
  key: 'E2E_BOOTSTRAP_ADMIN_PASSWORD' | 'E2E_ADMIN_PASSWORD'
): string {
  const value = env[key]
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`)
  }
  return value
}

export function buildBootstrapAdminUser(env: EnvMap = process.env): TestUser {
  return {
    username: env.E2E_BOOTSTRAP_ADMIN_USER || 'admin',
    password: requireEnvPassword(env, 'E2E_BOOTSTRAP_ADMIN_PASSWORD'),
    role: 'admin',
    description: 'Bootstrap admin user for E2E account provisioning',
  }
}

export function buildE2EAdminUser(env: EnvMap = process.env): TestUser {
  if (!shouldUseIsolatedUsers(env)) {
    return buildBootstrapAdminUser(env)
  }

  const suffix = getShardSuffix(env)
  const descriptionSuffix = suffix.replace(/-/g, ' ')
  return {
    username: env.E2E_ADMIN_USER || `e2e-admin-${suffix}`,
    password: requireEnvPassword(env, 'E2E_ADMIN_PASSWORD'),
    role: 'admin',
    description: `Isolated admin user for E2E ${descriptionSuffix}`,
  }
}

export function buildE2ERegularUser(env: EnvMap = process.env): TestUser {
  if (!shouldUseIsolatedUsers(env)) {
    return {
      username: env.E2E_REGULAR_USER || 'e2e-user',
      password: env.E2E_REGULAR_PASSWORD || 'Test@12345',
      role: 'user',
      description: 'Regular user with limited access',
    }
  }

  const suffix = getShardSuffix(env)
  return {
    username: env.E2E_REGULAR_USER || `e2e-user-${suffix}`,
    password: env.E2E_REGULAR_PASSWORD || 'Test@12345',
    role: 'user',
    description: `Isolated regular user for E2E ${suffix}`,
  }
}

export function getJwtExpiryMs(token: string): number | null {
  const payload = token.split('.')[1]
  if (!payload) return null

  try {
    const decoded = Buffer.from(payload, 'base64url').toString('utf8')
    const parsed = JSON.parse(decoded) as { exp?: unknown }
    return typeof parsed.exp === 'number' ? parsed.exp * 1000 : null
  } catch {
    return null
  }
}

export function buildStorageState(
  appBaseUrl: string,
  token: string,
  expiryMs: number | null
): StorageState {
  const appUrl = new URL(appBaseUrl)
  const localStorage = [{ name: TOKEN_KEY, value: token }]

  if (expiryMs) {
    localStorage.push({ name: TOKEN_EXPIRE_KEY, value: String(expiryMs) })
  }

  return {
    cookies: [
      {
        name: TOKEN_COOKIE_NAME,
        value: token,
        domain: appUrl.hostname,
        path: '/',
        expires: expiryMs ? Math.floor(expiryMs / 1000) : -1,
        httpOnly: false,
        secure: appUrl.protocol === 'https:',
        sameSite: 'Lax',
      },
    ],
    origins: [
      {
        origin: appUrl.origin,
        localStorage,
      },
    ],
  }
}
