import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

import { buildStorageState, getJwtExpiryMs } from '../../utils/auth-state'
import { createApiClient } from '../../utils/api-client'
import {
  createAuthenticatedSocketClient,
  type AuthenticatedSocketClient,
} from '../../../../packages/chat-core/src/socket/authenticatedSocketClient'

const API_URL = process.env.E2E_API_URL || 'http://localhost:8000'
const APP_URL = process.env.E2E_BASE_URL || 'http://localhost:3000'
type Ack = { success?: boolean; device_id?: string; error?: string }
type Device = {
  id: number
  device_id: string
  device_type: string
  runtime_instance_id: string
  app_device_id: string
  status: string
  execution_target_id: string
}

async function emitAck(
  client: AuthenticatedSocketClient,
  event: string,
  payload: Record<string, unknown>
) {
  return new Promise<Ack>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${event} timed out`)), 10_000)
    client.socket.emit(event, payload, (ack: Ack) => {
      clearTimeout(timeout)
      resolve(ack)
    })
  })
}

async function register(client: AuthenticatedSocketClient, deviceId: string, suffix: string) {
  return emitAck(client, 'device:register', {
    device_id: deviceId,
    name: 'E2E Wework',
    device_type: 'app',
    bind_shell: 'claudecode',
    executor_version: 'e2e',
    runtime_instance_id: `runtime-${suffix}`,
    app_device_id: `electron-${suffix}`,
  })
}

test('keeps app identity unique across concurrent registration and reconnect without merging installations', async ({
  browser,
  page: adminPage,
  request,
}) => {
  test.setTimeout(120_000)
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const routeId = `e2e-app-${runId}`
  const secondId = `e2e-second-app-${runId}`
  const userName = `e2e-app-identity-${runId}`
  const password = 'E2E-app-identity-123!'
  const storage = await adminPage.context().storageState()
  const adminToken =
    storage.origins.flatMap(origin => origin.localStorage).find(item => item.name === 'auth_token')
      ?.value || storage.cookies.find(cookie => cookie.name === 'auth_token')?.value
  if (!adminToken) throw new Error('Missing authenticated admin token')
  const admin = createApiClient(request, API_URL, adminToken)
  const api = createApiClient(request, API_URL)
  const clients: AuthenticatedSocketClient[] = []
  let userId: number | undefined
  let context: Awaited<ReturnType<typeof browser.newContext>> | undefined

  try {
    const created = await admin.adminCreateUser({
      user_name: userName,
      password,
      role: 'user',
      auth_source: 'password',
    })
    expect(created.status).toBe(201)
    userId = (created.data as { id: number }).id
    const login = await api.login(userName, password)
    expect(login.status).toBe(200)
    const token = login.data?.access_token
    if (!token) throw new Error('Missing isolated user token')
    const connect = async () => {
      const client = createAuthenticatedSocketClient({
        socketBaseUrl: () => API_URL,
        getToken: () => token,
        namespace: '/local-executor',
      })
      clients.push(client)
      await client.connect(token)
      await expect.poll(() => client.getState().isConnected).toBe(true)
      return client
    }
    const devices = async () => {
      const response = await api.get<{ items: Device[] }>('/api/devices')
      expect(response.status).toBe(200)
      return response.data?.items || []
    }

    const firstClients = await Promise.all([connect(), connect(), connect()])
    const replies = await Promise.all(firstClients.map(client => register(client, routeId, runId)))
    replies.forEach(reply => expect(reply).toEqual({ success: true, device_id: routeId }))
    const initial = await devices()
    expect(initial).toHaveLength(1)
    const recordId = initial[0].id
    expect(initial[0]).toMatchObject({ status: 'online', device_type: 'app' })
    const initialIdentity = {
      id: initial[0].id,
      device_id: initial[0].device_id,
      execution_target_id: initial[0].execution_target_id,
      runtime_instance_id: initial[0].runtime_instance_id,
      app_device_id: initial[0].app_device_id,
    }

    await test.step('reject a different Runtime before it changes the existing route', async () => {
      const rejected = await register(await connect(), routeId, `other-${runId}`)
      expect(rejected.success).not.toBe(true)
      expect(rejected.error).toContain('Runtime instance ID mismatch')
      const afterRejectedRegistration = await devices()
      expect(afterRejectedRegistration).toHaveLength(1)
      expect(afterRejectedRegistration[0]).toMatchObject({
        ...initialIdentity,
        status: 'online',
      })
    })

    await test.step('reconnect the same installation without changing its database record', async () => {
      firstClients.forEach(client => client.dispose())
      await expect.poll(async () => (await devices())[0]?.status).toBe('offline')
      expect(await register(await connect(), routeId, runId)).toEqual({
        success: true,
        device_id: routeId,
      })
      expect(await devices()).toEqual([expect.objectContaining({ id: recordId, status: 'online' })])
    })

    await test.step('show distinct installations separately even when display names match', async () => {
      expect(await register(await connect(), secondId, `second-${runId}`)).toEqual({
        success: true,
        device_id: secondId,
      })
      const expiry = getJwtExpiryMs(token)
      if (!expiry) throw new Error('Missing isolated token expiry')
      const state = buildStorageState(APP_URL, token, expiry)
      state.origins[0]?.localStorage.push({ name: 'user_onboarding_completed', value: 'true' })
      context = await browser.newContext({ storageState: state })
      const page = await context.newPage()
      await page.goto(`${APP_URL}/devices`)
      await expect(page.getByText('E2E Wework', { exact: true })).toHaveCount(2)
      const current = await devices()
      expect(current).toHaveLength(2)
      expect(current.map(device => device.device_id).sort()).toEqual([routeId, secondId].sort())
      await page.reload()
      await expect(page.getByText('E2E Wework', { exact: true })).toHaveCount(2)
    })

    await test.step('only cloud devices can be removed online through the menu or either API', async () => {
      const page = await context!.newPage()
      const registerType = async (type: 'remote' | 'local' | 'cloud') => {
        const client = await connect()
        const deviceId = `e2e-delete-${type}-${runId}`
        expect(
          await emitAck(client, 'device:register', {
            device_id: deviceId,
            name: `E2E ${type}`,
            device_type: type,
            runtime_instance_id: `runtime-delete-${type}-${runId}`,
          })
        ).toMatchObject({ success: true })
        const device = (await devices()).find(item => item.device_id === deviceId)
        expect(device).toMatchObject({ device_type: type, status: 'online' })
        return { client, device: device! }
      }
      const local = await registerType('local')
      const remote = await registerType('remote')
      const cloud = await registerType('cloud')
      const app = (await devices()).find(device => device.id === recordId)!
      await page.goto(`${APP_URL}/devices`)

      for (const device of [app, local.device, remote.device]) {
        expect((await api.delete(`/api/devices/records/${device.id}`)).status).toBe(409)
        expect((await api.delete(`/api/devices/${device.device_id}`)).status).toBe(409)
        await page.getByTestId(`device-menu-${device.id}`).click()
        await expect(page.getByTestId(`delete-device-${device.id}`)).toBeDisabled()
        await page.keyboard.press('Escape')
      }

      expect((await admin.delete(`/api/devices/records/${cloud.device.id}`)).status).toBe(404)
      await page.getByTestId(`device-menu-${cloud.device.id}`).click()
      await expect(page.getByTestId(`delete-device-${cloud.device.id}`)).toBeEnabled()
      await page.getByTestId(`delete-device-${cloud.device.id}`).click()
      await page.getByTestId('cancel-delete-device').click()
      expect((await devices()).some(device => device.id === cloud.device.id)).toBe(true)
      await page.getByTestId(`device-menu-${cloud.device.id}`).click()
      await page.getByTestId(`delete-device-${cloud.device.id}`).click()
      const deleted = page.waitForResponse(
        response =>
          response.url().endsWith(`/api/devices/records/${cloud.device.id}`) &&
          response.request().method() === 'DELETE'
      )
      await page.getByTestId('confirm-delete-device').click()
      expect((await deleted).status()).toBe(200)
      await expect(page.getByTestId(`device-record-${cloud.device.id}`)).toHaveCount(0)
      cloud.client.dispose()

      local.client.dispose()
      remote.client.dispose()
      for (const { device } of [local, remote]) {
        await expect
          .poll(async () => (await devices()).find(item => item.id === device.id)?.status)
          .toBe('offline')
      }
      await page.reload()
      await page.getByTestId(`device-menu-${local.device.id}`).click()
      await page.getByTestId(`delete-device-${local.device.id}`).click()
      await expect(page.getByTestId('confirm-delete-device')).toBeEnabled()
      const reconnected = await registerType('local')
      expect(reconnected.device.id).toBe(local.device.id)
      await expect(page.getByTestId('confirm-delete-device')).toBeDisabled()
      await page.getByTestId('cancel-delete-device').click()
      reconnected.client.dispose()
      await expect
        .poll(async () => (await devices()).find(item => item.id === local.device.id)?.status)
        .toBe('offline')
      expect((await api.delete(`/api/devices/records/${local.device.id}`)).status).toBe(200)
      expect((await api.delete(`/api/devices/${remote.device.device_id}`)).status).toBe(200)
      await page.reload()
      for (const { device } of [local, remote, cloud]) {
        await expect(page.getByTestId(`device-record-${device.id}`)).toHaveCount(0)
      }
    })

    await test.step('upgrade legacy duplicates without a migration and remove only the clicked offline record', async () => {
      if (!process.env.DATABASE_URL)
        throw new Error('Legacy E2E fixture requires an explicit isolated DATABASE_URL')
      const seeded = JSON.parse(
        execFileSync('uv', ['run', 'python', '-m', 'tests.e2e_seed_legacy_app_devices'], {
          cwd: resolve(process.cwd(), '../backend'),
          encoding: 'utf8',
          timeout: 30_000,
          input: JSON.stringify({
            user_id: userId,
            record_id: recordId,
            device_id: routeId,
            other_suffix: `legacy-${runId}`,
          }),
        })
      ) as { duplicate_id: number; other_id: number }
      const original = await connect()
      expect(await register(original, routeId, runId)).toMatchObject({ success: true })
      const list = await devices()
      expect(list.filter(device => device.device_id === routeId)).toHaveLength(3)
      expect(list.find(device => device.id === recordId)?.status).toBe('online')
      expect(list.find(device => device.id === seeded.duplicate_id)?.status).toBe('offline')
      expect((await api.delete(`/api/devices/records/${recordId}`)).status).toBe(409)
      expect((await admin.delete(`/api/devices/records/${seeded.duplicate_id}`)).status).toBe(404)

      const page = await context!.newPage()
      await page.goto(`${APP_URL}/devices`)
      await page.getByTestId(`device-menu-${seeded.duplicate_id}`).click()
      await page.getByTestId(`delete-device-${seeded.duplicate_id}`).click()
      await expect(page.getByRole('alertdialog')).toBeVisible()
      await page.getByTestId('confirm-delete-device').click()
      await expect(page.getByTestId(`device-record-${seeded.duplicate_id}`)).toHaveCount(0)
      await expect(page.getByTestId(`device-record-${recordId}`)).toBeVisible()
      await page.reload()
      await expect(page.getByTestId(`device-record-${seeded.duplicate_id}`)).toHaveCount(0)

      const other = await connect()
      expect(await register(other, routeId, `legacy-${runId}`)).toMatchObject({ success: true })
      const heartbeat = (client: AuthenticatedSocketClient, suffix: string) =>
        emitAck(client, 'device:heartbeat', {
          device_id: routeId,
          runtime_instance_id: `runtime-${suffix}`,
          running_task_ids: [],
        })
      expect(await heartbeat(original, runId)).toMatchObject({ success: true })
      expect(await heartbeat(other, `legacy-${runId}`)).toMatchObject({ success: true })
      expect(
        (await devices())
          .filter(device => [recordId, seeded.other_id].includes(device.id))
          .map(device => device.status)
      ).toEqual(['online', 'online'])
      const firstSettings = await api.get<{ detail: string }>(
        `/api/devices/app-record-${recordId}/runtime-settings`
      )
      const otherSettings = await api.get<{ detail: string }>(
        `/api/devices/app-record-${seeded.other_id}/runtime-settings`
      )
      // Registration and chat support must not bypass the app remote-control policy.
      for (const settings of [firstSettings, otherSettings]) {
        expect(settings.status).toBe(503)
        expect(settings.data?.detail).toBe('Remote control is disabled for this app device')
      }
      other.dispose()
      await expect
        .poll(async () => (await devices()).find(device => device.id === seeded.other_id)?.status)
        .toBe('offline')
      expect((await devices()).find(device => device.id === recordId)?.status).toBe('online')
      expect((await api.delete(`/api/devices/records/${seeded.other_id}`)).status).toBe(200)
      expect(await register(await connect(), routeId, `legacy-${runId}`)).toMatchObject({
        success: true,
      })
      expect((await devices()).find(device => device.id === seeded.other_id)?.status).toBe('online')
    })
  } finally {
    await context?.close()
    clients.forEach(client => client.dispose())
    if (userId) {
      expect((await admin.adminDeleteUser(userId)).status).toBe(204)
    }
  }
})
