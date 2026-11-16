import { test as base, expect, type APIRequestContext } from '@playwright/test'
import { ADMIN_USER, BOOTSTRAP_ADMIN_USER } from '../config/test-users'
import { createApiClient } from '../utils/api-client'
import { buildStorageState, getJwtExpiryMs } from '../utils/auth-state'
import { ensureE2EUser, configurePetVisibility } from '../utils/e2e-account'
import { bindExecutorRequest, executorWorkerScope } from '../utils/executor-request-scope'
import { scopedMockUrl } from '../utils/mock-scope'

const apiUrl = process.env.E2E_API_URL || 'http://localhost:8000'
const appUrl = process.env.E2E_BASE_URL || 'http://localhost:3000'
const mockUrl = process.env.MOCK_MODEL_SERVER_URL || 'http://localhost:9999'
const scope = executorWorkerScope(process.env, Number(process.env.TEST_WORKER_INDEX || '0'))
export const EXECUTOR_USER = { ...ADMIN_USER, username: `e2e-${scope}` }
export const executorMockUrl = (base = mockUrl): string => scopedMockUrl(base, scope)

type WorkerAccount = { token: string }

async function fetchCurrentUserWithRetry(request: APIRequestContext, token: string) {
  // The hybrid gateway starts listening before its Python fallback and account
  // provisioning calls settle. Retry only transient upstream response codes.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await request.get(`${apiUrl}/api/users/me`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (response.ok()) return response
    if (![502, 503, 504].includes(response.status()) || attempt === 2) return response
    await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt))
  }
  throw new Error('unreachable')
}

/** Parallel files use distinct accounts and model state; real device specs keep their original fixture. */
export const test = base.extend<object, { executorAccount: WorkerAccount }>({
  executorAccount: [
    async ({ playwright }, use, worker) => {
      expect(scope).toBe(executorWorkerScope(process.env, worker.workerIndex))
      const request = await playwright.request.newContext()
      const client = createApiClient(request)
      const bootstrap = await client.login(
        BOOTSTRAP_ADMIN_USER.username,
        BOOTSTRAP_ADMIN_USER.password,
        1
      )
      expect(bootstrap.data?.access_token).toBeTruthy()
      const bootstrapHeaders = { Authorization: `Bearer ${bootstrap.data!.access_token}` }
      let userId: number | undefined
      try {
        await ensureE2EUser(
          request,
          bootstrap.data!.access_token,
          EXECUTOR_USER,
          apiUrl,
          BOOTSTRAP_ADMIN_USER.username
        )
        const login = await client.login(EXECUTOR_USER.username, EXECUTOR_USER.password, 1)
        expect(login.data?.access_token).toBeTruthy()
        const token = login.data!.access_token
        const me = await fetchCurrentUserWithRetry(request, token)
        expect(me.ok(), await me.text()).toBe(true)
        const user = await me.json()
        expect(user.user_name).toBe(EXECUTOR_USER.username)
        expect(user.role).toBe(ADMIN_USER.role)
        userId = user.id
        await configurePetVisibility(request, token, apiUrl)
        await use({ token })
      } finally {
        for (const [method, path] of [
          ['post', '/clear-requests'],
          ['delete', '/stream-rules'],
          ['delete', '/tool-scenarios'],
          ['post', '/mcp-control/reset'],
        ] as const) {
          const response = await request[method](`${executorMockUrl()}${path}`)
          expect(response.ok(), `Scoped cleanup ${path}: ${await response.text()}`).toBe(true)
        }
        if (userId) {
          const removed = await request.delete(`${apiUrl}/api/admin/users/${userId}`, {
            headers: bootstrapHeaders,
          })
          expect(removed.ok(), await removed.text()).toBe(true)
        }
        await request.dispose()
      }
    },
    { scope: 'worker' },
  ],
  request: async ({ request, executorAccount }, use) => {
    expect(executorAccount.token).toBeTruthy()
    bindExecutorRequest(request, scope, EXECUTOR_USER)
    await use(request)
  },
  storageState: async ({ executorAccount }, use) => {
    const expiry = getJwtExpiryMs(executorAccount.token)
    expect(expiry).toEqual(expect.any(Number))
    await use(buildStorageState(appUrl, executorAccount.token, expiry))
  },
})

export { expect }
