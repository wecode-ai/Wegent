import { randomUUID } from 'node:crypto'
import { test as base, expect, type APIRequestContext } from '@playwright/test'
import { ADMIN_USER } from '../config/test-users'
import { createApiClient } from '../utils/api-client'
import { buildStorageState, getJwtExpiryMs } from '../utils/auth-state'

type RuntimeAccount = { request: APIRequestContext; token: string }

// Other suites mutate the shared admin's catalog while this serial suite paginates it.
export const test = base.extend<object, { runtimeAccount: RuntimeAccount }>({
  runtimeAccount: [
    async ({ playwright }, use) => {
      const request = await playwright.request.newContext()
      const admin = createApiClient(request)
      let userId: number | undefined
      try {
        expect((await admin.login(ADMIN_USER.username, ADMIN_USER.password, 1)).status).toBe(200)
        const username = `e2e-runtime-${randomUUID()}`
        const password = `E2e!${randomUUID()}`
        const created = await admin.post<{ id: number }>('/api/admin/users', {
          user_name: username,
          password,
          role: 'user',
          auth_source: 'password',
        })
        expect(created.status).toBe(201)
        userId = created.data!.id
        const login = await createApiClient(request).login(username, password, 1)
        expect(login.status).toBe(200)
        expect(login.data?.access_token).toBeTruthy()
        await use({ request, token: login.data!.access_token })
      } finally {
        try {
          if (userId) expect((await admin.delete(`/api/admin/users/${userId}`)).status).toBe(204)
        } finally {
          await request.dispose()
        }
      }
    },
    { scope: 'worker' },
  ],
  storageState: async ({ runtimeAccount, baseURL }, use) => {
    await use(
      buildStorageState(baseURL!, runtimeAccount.token, getJwtExpiryMs(runtimeAccount.token))
    )
  },
})
