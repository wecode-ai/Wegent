// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { createAuthenticatedSocketClient } from '../../../../packages/chat-core/src/socket/authenticatedSocketClient'
import { ADMIN_USER, REGULAR_USER } from '../../config/test-users'
import { createApiClient } from '../../utils/api-client'

const API_URL = process.env.E2E_API_URL || 'http://localhost:8000'
const ADMIN_DEVICES = '/api/admin/device-monitor/devices'

test('an admin can remove another user’s offline device registration', async ({
  page,
  request,
}) => {
  const admin = createApiClient(request, API_URL)
  const owner = createApiClient(request, API_URL)
  expect((await admin.login(ADMIN_USER.username, ADMIN_USER.password)).status).toBe(200)
  const login = await owner.login(REGULAR_USER.username, REGULAR_USER.password)
  expect(login.status).toBe(200)
  const token = login.data?.access_token
  if (!token) throw new Error('Missing device owner token')

  const suffix = randomUUID()
  const deviceId = `e2e-admin-delete-${suffix}`
  const name = `E2E admin deletion ${suffix}`
  const client = createAuthenticatedSocketClient({
    socketBaseUrl: () => API_URL,
    getToken: () => token,
    namespace: '/local-executor',
  })
  let recordId: number | undefined
  const findDevice = async () => {
    const response = await admin.get<{ items: { id: number; status: string }[] }>(
      `${ADMIN_DEVICES}?search=${deviceId}`
    )
    expect(response.status).toBe(200)
    return response.data?.items[0]
  }

  try {
    await client.connect(token)
    await expect.poll(() => client.getState().isConnected).toBe(true)
    const socket = client.getRawSocket()
    if (!socket) throw new Error('Missing connected device socket')
    const ack = await new Promise(resolve => {
      socket.timeout(10_000).emit(
        'device:register',
        {
          device_id: deviceId,
          name,
          device_type: 'app',
          bind_shell: 'claudecode',
          runtime_instance_id: `runtime-${suffix}`,
          app_device_id: `electron-${suffix}`,
        },
        (error: Error | null, result: unknown) => resolve(error ?? result)
      )
    })
    expect(ack).toMatchObject({ success: true })
    const device = await findDevice()
    if (!device) throw new Error('Missing registered device')
    recordId = device.id
    expect(device.status).toBe('online')
    const deletionPath = `${ADMIN_DEVICES}/records/${recordId}`
    expect((await owner.delete(deletionPath)).status).toBe(403)
    expect((await admin.delete(deletionPath)).status).toBe(409)

    client.dispose()
    await expect.poll(async () => (await findDevice())?.status).toBe('offline')
    await page.goto('/admin?tab=device-monitor')
    await page.getByTestId('device-search-input').fill(deviceId)
    const deleteButton = page.getByTestId(`admin-delete-device-${recordId}`)
    await deleteButton.click()
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toContainText(name)
    await expect(dialog).toContainText(REGULAR_USER.username)
    await page.getByTestId('cancel-admin-delete-device').click()
    await expect(dialog).toBeHidden()
    expect((await findDevice())?.id).toBe(recordId)

    await deleteButton.click()
    const deleted = page.waitForResponse(
      response => response.url().endsWith(deletionPath) && response.request().method() === 'DELETE'
    )
    await page.getByTestId('confirm-admin-delete-device').click()
    expect((await deleted).status()).toBe(200)
    await expect(page.getByTestId(`device-card-${deviceId}`)).toHaveCount(0)
    expect(await findDevice()).toBeUndefined()
    expect((await admin.delete(deletionPath)).status).toBe(404)
    recordId = undefined
  } finally {
    client.dispose()
    if (recordId !== undefined) {
      await expect.poll(async () => (await findDevice())?.status).not.toBe('online')
      await owner.delete(`/api/devices/records/${recordId}`)
    }
  }
})
