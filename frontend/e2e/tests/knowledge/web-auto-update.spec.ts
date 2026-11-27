// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from '@playwright/test'
import { ADMIN_USER, REGULAR_USER } from '../../config/test-users'
import { createApiClient, createBackendRequestHeaders } from '../../utils/api-client'

// Reuses the existing hybrid Backend and Chromium CI shards. No extra service
// or provider is needed; this does not enable the deployment scheduler.
test('web auto update persists through the real settings UI and enforces KB roles', async ({
  page,
  request,
}) => {
  const admin = createApiClient(request)
  const regular = createApiClient(request)
  const adminLogin = await admin.login(ADMIN_USER.username, ADMIN_USER.password)
  const regularLogin = await regular.login(REGULAR_USER.username, REGULAR_USER.password)
  expect(adminLogin.status).toBe(200)
  expect(regularLogin.status).toBe(200)
  const identity = await regular.getCurrentUser()
  expect(identity.status).toBe(200)
  const regularId = (identity.data as { id: number }).id
  const headers = createBackendRequestHeaders(adminLogin.data!.access_token)
  const memberHeaders = createBackendRequestHeaders(regularLogin.data!.access_token)
  const base = process.env.E2E_API_URL || 'http://localhost:8000'
  const namespace = `web-update-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  expect((await admin.createGroup({ name: namespace })).status).toBe(201)
  let kbId: number | undefined
  try {
    expect(
      (await admin.addGroupMember(namespace, { user_id: regularId, role: 'Developer' })).status
    ).toBe(201)
    const created = await request.post(`${base}/api/knowledge-bases`, {
      headers,
      data: { name: namespace, namespace, kb_type: 'classic', summary_enabled: false },
    })
    expect(created.ok(), await created.text()).toBeTruthy()
    kbId = (await created.json()).id
    const endpoint = `${base}/api/knowledge-bases/${kbId}/web-auto-update`
    const initial = await request.get(endpoint, { headers: memberHeaders })
    expect(initial.status()).toBe(200)
    expect(await initial.json()).toEqual({ enabled: false })
    expect(
      (await request.put(endpoint, { headers: memberHeaders, data: { enabled: true } })).status()
    ).toBe(403)
    expect((await request.put(endpoint, { headers, data: { enabled: 'true' } })).status()).toBe(422)
    expect(
      (await admin.updateGroupMember(namespace, regularId, { role: 'Maintainer' })).status
    ).toBe(200)
    const enabled = await request.put(endpoint, { headers: memberHeaders, data: { enabled: true } })
    expect(enabled.status()).toBe(200)
    expect(await enabled.json()).toEqual({ enabled: true })

    await page.goto('/knowledge?type=document', { waitUntil: 'domcontentloaded' })
    await page.getByTestId('nav-all-item').click()
    await page.getByTestId(`edit-kb-${kbId}`).click()
    await page.getByTestId('knowledge-data-sync-section-trigger').click()
    const toggle = page.getByTestId('knowledge-web-auto-update')
    await expect(toggle, 'Load web auto-update setting').toBeEnabled({ timeout: 10_000 })
    await expect(toggle, 'Read persisted enabled value').toBeChecked({ timeout: 5_000 })
    await test.step('Save web auto-update setting', async () => {
      const saved = page.waitForResponse(
        response =>
          new URL(response.url()).pathname === new URL(endpoint).pathname &&
          response.request().method() === 'PUT',
        { timeout: 10_000 }
      )
      await toggle.click()
      expect((await saved).status()).toBe(200)
    })
    await expect(toggle).not.toBeChecked()
    await page.reload()
    await page.getByTestId(`edit-kb-${kbId}`).click()
    await page.getByTestId('knowledge-data-sync-section-trigger').click()
    await expect(toggle).toBeEnabled()
    await expect(toggle).not.toBeChecked()
    expect(await (await request.get(endpoint, { headers })).json()).toEqual({ enabled: false })
  } finally {
    if (kbId !== undefined) {
      const removed = await request.delete(`${base}/api/knowledge-bases/${kbId}`, { headers })
      expect(removed.ok(), await removed.text()).toBeTruthy()
    }
    expect((await admin.deleteGroup(namespace)).status).toBe(204)
  }
})
