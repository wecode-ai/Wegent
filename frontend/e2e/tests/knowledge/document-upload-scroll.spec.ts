// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from '@playwright/test'
import { ADMIN_USER } from '../../config/test-users'
import { createApiClient, createBackendRequestHeaders } from '../../utils/api-client'

// The default Chromium CI suite runs this against real Wegent services.
test('add materials keeps its controls visible and scrolls errors in a small window', async ({
  page,
  request,
}) => {
  const api = createApiClient(request)
  const login = await api.login(ADMIN_USER.username, ADMIN_USER.password)
  expect(login.status).toBe(200)
  const headers = createBackendRequestHeaders(login.data!.access_token)
  const base = process.env.E2E_API_URL || 'http://localhost:8000'
  const created = await request.post(`${base}/api/knowledge-bases`, {
    headers,
    data: {
      name: `scroll-${Date.now()}`,
      namespace: 'default',
      kb_type: 'classic',
      summary_enabled: false,
    },
  })
  expect(created.ok(), await created.text()).toBeTruthy()
  const { id } = await created.json()
  try {
    await page.setViewportSize({ width: 390, height: 480 })
    await page.goto(`/knowledge?type=document&kb=${id}`)
    await page.getByTestId('upload-documents-button').click()
    const dialog = page.getByTestId('document-upload-dialog')
    await page.getByTestId('document-source-text').click()
    await page.getByTestId('document-text-content').fill('Retain this draft')
    const body = page.getByTestId('document-text-body')
    await body.hover()
    await page.mouse.wheel(0, 600)
    await expect.poll(() => body.evaluate(el => el.scrollTop)).toBeGreaterThan(0)
    await expect(page.getByTestId('document-text-submit')).toBeInViewport()
    await expect(page.getByTestId('document-source-web')).toBeInViewport()
    await expect(page.getByTestId('document-upload-close')).toBeInViewport()
    await expect
      .poll(() => dialog.evaluate(el => el.getBoundingClientRect().height))
      .toBeLessThanOrEqual(432)
    await page.getByTestId('document-source-web').click()
    // A real security rejection avoids external network dependencies.
    await page.getByTestId('document-web-url').fill('http://127.0.0.1/private')
    await page.getByTestId('document-web-submit').click()
    const alert = dialog.getByRole('alert')
    await expect(alert).toBeVisible()
    await expect(alert).toBeInViewport()
    const webBody = page.getByTestId('document-web-body')
    await page.setViewportSize({ width: 390, height: 360 })
    await webBody.evaluate(el => {
      el.scrollTop = 0
    })
    await webBody.hover()
    await page.mouse.wheel(0, 600)
    await expect.poll(() => webBody.evaluate(el => el.scrollTop)).toBeGreaterThan(0)
    await expect
      .poll(async () => {
        const bodyBox = await webBody.boundingBox()
        const errorBox = await alert.boundingBox()
        return Boolean(
          bodyBox && errorBox && errorBox.y + errorBox.height <= bodyBox.y + bodyBox.height
        )
      })
      .toBe(true)
    await expect(page.getByTestId('document-web-submit')).toBeInViewport({ ratio: 1 })
    const error = await alert.textContent()
    expect(error?.length).toBeGreaterThan(0)
    await page.getByTestId('document-source-text').click()
    await expect(page.getByTestId('document-text-content')).toHaveValue('Retain this draft')
    await page.getByTestId('document-source-web').click()
    await expect(alert).toHaveText(error!)
    await expect(page.getByTestId('document-web-url')).toHaveValue('http://127.0.0.1/private')
    await expect(page.getByTestId('document-web-submit')).toBeEnabled()
    expect(await page.evaluate(() => window.scrollY)).toBe(0)
  } finally {
    const deleted = await request.delete(`${base}/api/knowledge-bases/${id}`, { headers })
    expect(deleted.ok(), await deleted.text()).toBeTruthy()
  }
})
