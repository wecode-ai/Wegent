import { expect, test, type APIRequestContext } from '@playwright/test'

import { buildStorageState, getJwtExpiryMs } from '../../utils/auth-state'
import { createApiClient, type ApiClient } from '../../utils/api-client'
import {
  createAuthenticatedSocketClient,
  type AuthenticatedSocketClient,
} from '../../../../packages/chat-core/src/socket/authenticatedSocketClient'

const API_BASE_URL = process.env.E2E_API_URL || 'http://localhost:8000'
const APP_BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:3000'

type BindShell = 'claudecode' | 'openclaw'
type RegisterAck = { success?: boolean; device_id?: string; error?: string }

async function registerDevice(
  token: string,
  deviceId: string,
  name: string,
  bindShell: BindShell
): Promise<AuthenticatedSocketClient> {
  const client = createAuthenticatedSocketClient({
    socketBaseUrl: () => API_BASE_URL,
    getToken: () => token,
    namespace: '/local-executor',
  })

  await client.connect(token)
  await expect.poll(() => client.getState().isConnected).toBe(true)

  const acknowledgement = await new Promise<RegisterAck>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out registering ${deviceId}`)), 10_000)
    client.socket.emit(
      'device:register',
      {
        device_id: deviceId,
        name,
        device_type: 'local',
        bind_shell: bindShell,
        executor_version: 'e2e',
      },
      (response: RegisterAck) => {
        clearTimeout(timeout)
        resolve(response)
      }
    )
  })

  expect(acknowledgement).toEqual({ success: true, device_id: deviceId })
  return client
}

async function waitForDevices(
  apiClient: ApiClient,
  expectedDevices: Array<{ deviceId: string; bindShell: BindShell }>
): Promise<void> {
  await expect
    .poll(async () => {
      const response = await apiClient.get<{
        items?: Array<{ device_id: string; status: string; bind_shell?: string }>
      }>('/api/devices')
      expect(response.status).toBe(200)
      const devices = response.data?.items || []
      return expectedDevices.every(expected =>
        devices.some(
          device =>
            device.device_id === expected.deviceId &&
            device.bind_shell === expected.bindShell &&
            device.status === 'online'
        )
      )
    })
    .toBe(true)
}

async function deleteDevice(request: APIRequestContext, token: string, deviceId: string) {
  // Disposing a socket does not synchronously complete backend disconnection.
  await expect
    .poll(async () => {
      const response = await request.get(`${API_BASE_URL}/api/devices`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(response.status()).toBe(200)
      const { items } = (await response.json()) as {
        items: Array<{ device_id: string; status: string }>
      }
      return items.find(device => device.device_id === deviceId)?.status ?? 'offline'
    })
    .toBe('offline')
  const response = await request.delete(
    `${API_BASE_URL}/api/devices/${encodeURIComponent(deviceId)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  expect([200, 404]).toContain(response.status())
}

test('gates OpenClaw behind advanced mode and keeps ordinary chat on Executor', async ({
  browser,
  page: authenticatedAdminPage,
  request,
}) => {
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const userName = `e2e-device-visibility-${runId}`
  const userPassword = 'E2E-device-visibility-123!'
  const executorId = `e2e-executor-${runId}`
  const openClawId = `e2e-openclaw-${runId}`
  const executorName = `E2E Executor ${runId}`
  const openClawName = `E2E OpenClaw ${runId}`
  const deviceClients: AuthenticatedSocketClient[] = []
  let browserContext: Awaited<ReturnType<typeof browser.newContext>> | null = null
  let userId: number | null = null
  let token: string | null = null
  let apiClient: ApiClient | null = null

  const adminStorageState = await authenticatedAdminPage.context().storageState()
  const adminToken =
    adminStorageState.origins
      .flatMap(origin => origin.localStorage)
      .find(item => item.name === 'auth_token')?.value ||
    adminStorageState.cookies.find(cookie => cookie.name === 'auth_token')?.value
  expect(adminToken).toBeTruthy()
  if (!adminToken) throw new Error('Authenticated E2E admin storage did not include a token')
  const adminClient = createApiClient(request, API_BASE_URL, adminToken)

  try {
    const createdUser = await adminClient.adminCreateUser({
      user_name: userName,
      password: userPassword,
      role: 'user',
      auth_source: 'password',
    })
    expect(createdUser.status).toBe(201)
    userId = (createdUser.data as { id?: number } | null)?.id ?? null
    expect(userId).toEqual(expect.any(Number))

    apiClient = createApiClient(request)
    const login = await apiClient.login(userName, userPassword)
    expect(login.status).toBe(200)
    token = login.data?.access_token || null
    expect(token).toBeTruthy()
    if (!token) throw new Error('Isolated E2E login did not return an access token')

    deviceClients.push(await registerDevice(token, executorId, executorName, 'claudecode'))
    deviceClients.push(await registerDevice(token, openClawId, openClawName, 'openclaw'))
    await waitForDevices(apiClient, [
      { deviceId: executorId, bindShell: 'claudecode' },
      { deviceId: openClawId, bindShell: 'openclaw' },
    ])

    const updateDefault = await apiClient.put('/api/users/me', {
      preferences: { default_execution_target: openClawId },
    })
    expect(updateDefault.status).toBe(200)

    const tokenExpiryMs = getJwtExpiryMs(token)
    expect(tokenExpiryMs).not.toBeNull()
    if (!tokenExpiryMs) throw new Error('Regular E2E token does not include an expiry')
    const storageState = buildStorageState(APP_BASE_URL, token, tokenExpiryMs)
    storageState.origins[0]?.localStorage.push({
      name: 'user_onboarding_completed',
      value: 'true',
    })
    browserContext = await browser.newContext({ storageState })
    const page = await browserContext.newPage()

    await test.step('hide OpenClaw by default and persist the advanced-mode opt in', async () => {
      await page.goto(`${APP_BASE_URL}/devices`)
      await expect(page.getByText(executorName, { exact: true })).toBeVisible()
      await expect(page.getByText(openClawName, { exact: true })).toHaveCount(0)

      const advancedModeToggle = page.getByTestId('show-advanced-devices-toggle')
      await expect(advancedModeToggle).toHaveAttribute('data-state', 'unchecked')
      await advancedModeToggle.click()
      await expect(advancedModeToggle).toHaveAttribute('data-state', 'checked')
      await expect(page.getByText(openClawName, { exact: true })).toBeVisible()

      await page.reload()
      await expect(page.getByTestId('show-advanced-devices-toggle')).toHaveAttribute(
        'data-state',
        'checked'
      )
      await expect(page.getByText(openClawName, { exact: true })).toBeVisible()
    })

    await test.step('ignore an OpenClaw account default for an ordinary device chat', async () => {
      await page.goto(`${APP_BASE_URL}/devices/chat`)
      const targetSelect = page.getByTestId('device-chat-target-select')
      await expect(targetSelect).toHaveValue(executorId)
      await expect(targetSelect.locator(`option[value="${openClawId}"]`)).toHaveCount(1)
    })

    await test.step('preserve an explicit OpenClaw conversation when advanced mode is off', async () => {
      await page.evaluate(() => localStorage.setItem('wegent_show_advanced_devices', 'false'))
      await page.goto(`${APP_BASE_URL}/devices/chat?deviceId=${encodeURIComponent(openClawId)}`)
      const targetSelect = page.getByTestId('device-chat-target-select')
      await expect(targetSelect).toHaveValue(openClawId)
      await expect(targetSelect.locator(`option[value="${openClawId}"]`)).toHaveCount(1)

      await page.goto(`${APP_BASE_URL}/devices/chat`)
      await expect(targetSelect).toHaveValue(executorId)
      await expect(targetSelect.locator(`option[value="${openClawId}"]`)).toHaveCount(0)
    })
  } finally {
    await browserContext?.close()
    deviceClients.forEach(client => client.dispose())
    if (token) {
      await Promise.all([
        deleteDevice(request, token, executorId),
        deleteDevice(request, token, openClawId),
      ])
    }
    if (userId) {
      const deletedUser = await adminClient.adminDeleteUser(userId)
      expect(deletedUser.status).toBe(204)
    }
  }
})
