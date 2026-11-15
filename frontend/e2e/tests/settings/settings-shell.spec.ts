import { test, expect } from '@playwright/test'
import { createApiClient, ApiClient } from '../../utils/api-client'
import { DataBuilders } from '../../fixtures/data-builders'
import { ADMIN_USER } from '../../config/test-users'

test.describe('Settings - Shell API Tests', () => {
  test.describe.configure({ mode: 'serial' })

  let apiClient: ApiClient
  let testShellName: string

  test.beforeEach(async ({ request }) => {
    apiClient = createApiClient(request)
    await apiClient.login(ADMIN_USER.username, ADMIN_USER.password)
  })

  test.afterEach(async () => {
    if (testShellName) {
      await apiClient.delete(`/api/v1/namespaces/default/shells/${testShellName}`).catch(() => {})
      testShellName = ''
    }
  })

  test('GET /api/shells/unified - should list shells', async () => {
    const response = await apiClient.getShells()
    expect(response.status).toBe(200)
  })

  test('POST /api/v1/namespaces/:ns/shells - should create shell', async () => {
    const shellData = DataBuilders.shell()
    testShellName = shellData.metadata.name
    const response = await apiClient.post('/api/v1/namespaces/default/shells', shellData)
    expect([200, 201]).toContain(response.status)
  })

  test('DELETE /api/v1/namespaces/:ns/shells/:name - should delete shell', async () => {
    const shellData = DataBuilders.shell()
    const shellName = shellData.metadata.name
    await apiClient.post('/api/v1/namespaces/default/shells', shellData)
    const response = await apiClient.delete(`/api/v1/namespaces/default/shells/${shellName}`)
    expect([200, 204]).toContain(response.status)
  })
})
