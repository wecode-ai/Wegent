import { APIRequestContext, expect, test as setup } from '@playwright/test'
import * as path from 'path'
import { promises as fsPromises } from 'fs'
import { ADMIN_USER, BOOTSTRAP_ADMIN_USER, REGULAR_USER } from '../config/test-users'
import type { TestUser } from '../config/test-users'
import { ensureE2EUser, configurePetVisibility } from '../utils/e2e-account'
import { buildStorageState, getJwtExpiryMs } from '../utils/auth-state'
import { ensureBootstrapAdminPasswordInitialized } from '../utils/bootstrap-admin'

const authFile = path.join(__dirname, '../.auth/user.json')
const apiBaseUrl = process.env.E2E_API_URL || 'http://localhost:8000'
const appBaseUrl = process.env.E2E_BASE_URL || 'http://localhost:3000'
const loginMaxAttempts = 3
const loginRetryDelayMs = 1000

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function loginViaApi(request: APIRequestContext, user: TestUser): Promise<string> {
  let lastError: Error | undefined

  for (let attempt = 1; attempt <= loginMaxAttempts; attempt += 1) {
    try {
      const response = await request.post(`${apiBaseUrl}/api/auth/login`, {
        data: {
          user_name: user.username,
          password: user.password,
        },
      })

      if (!response.ok()) {
        lastError = new Error(
          `Login failed for ${user.username} on attempt ${attempt}/${loginMaxAttempts}: ${response.status()} ${await response.text()}`
        )
      } else {
        const body = (await response.json()) as { access_token?: string }
        if (typeof body.access_token === 'string' && body.access_token.length > 0) {
          return body.access_token
        }
        lastError = new Error(
          `Login response did not include access_token for ${user.username} on attempt ${attempt}/${loginMaxAttempts}`
        )
      }
    } catch (error) {
      lastError =
        error instanceof Error
          ? new Error(
              `Login failed for ${user.username} on attempt ${attempt}/${loginMaxAttempts}: ${error.message}`
            )
          : new Error(`Login failed for ${user.username} on attempt ${attempt}/${loginMaxAttempts}`)
    }

    if (attempt < loginMaxAttempts) {
      console.log(
        `Retrying login for ${user.username} after attempt ${attempt}/${loginMaxAttempts}`
      )
      await delay(loginRetryDelayMs * attempt)
    }
  }

  throw lastError || new Error(`Login failed for ${user.username}`)
}

async function markAdminSetupComplete(request: APIRequestContext, token: string): Promise<void> {
  const response = await request.post(`${apiBaseUrl}/api/admin/setup-complete`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  })

  if (response.ok()) {
    console.log('Admin setup marked as complete')
    return
  }

  console.log(`Admin setup API returned ${response.status()} - may already be complete`)
}

/**
 * Global setup - run once before all tests
 * Authenticates and saves storage state for reuse
 */
setup('authenticate', async ({ request }) => {
  // Ensure .auth directory exists using async operations
  const authDir = path.dirname(authFile)
  try {
    await fsPromises.access(authDir)
  } catch {
    await fsPromises.mkdir(authDir, { recursive: true })
  }

  await ensureBootstrapAdminPasswordInitialized(request, apiBaseUrl, BOOTSTRAP_ADMIN_USER.password)

  const bootstrapToken = await loginViaApi(request, BOOTSTRAP_ADMIN_USER)
  await ensureE2EUser(
    request,
    bootstrapToken,
    ADMIN_USER,
    apiBaseUrl,
    BOOTSTRAP_ADMIN_USER.username
  )
  await ensureE2EUser(
    request,
    bootstrapToken,
    REGULAR_USER,
    apiBaseUrl,
    BOOTSTRAP_ADMIN_USER.username
  )

  const authToken = await loginViaApi(request, ADMIN_USER)
  const tokenExpiryMs = getJwtExpiryMs(authToken)
  expect(tokenExpiryMs, `E2E auth token for ${ADMIN_USER.username} must include exp`).toEqual(
    expect.any(Number)
  )

  await markAdminSetupComplete(request, authToken)
  await configurePetVisibility(request, authToken, apiBaseUrl)

  const storageState = buildStorageState(appBaseUrl, authToken, tokenExpiryMs)
  await fsPromises.writeFile(authFile, JSON.stringify(storageState, null, 2))

  console.log(`Authentication successful for ${ADMIN_USER.username}, storage state saved`)
})
