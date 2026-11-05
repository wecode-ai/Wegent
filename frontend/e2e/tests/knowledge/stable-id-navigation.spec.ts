// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from '@playwright/test'
import { ADMIN_USER, REGULAR_USER } from '../../config/test-users'
import { createApiClient, createBackendRequestHeaders } from '../../utils/api-client'

// Included by the existing Chromium CI project. All APIs and persistence are real.
test('a clicked same-name group KB keeps its ID through reload, sharing and rename', async ({
  page,
  request,
}) => {
  const admin = createApiClient(request)
  const regular = createApiClient(request)
  const adminLogin = await admin.login(ADMIN_USER.username, ADMIN_USER.password)
  const regularLogin = await regular.login(REGULAR_USER.username, REGULAR_USER.password)
  expect(adminLogin.status).toBe(200)
  expect(regularLogin.status).toBe(200)
  const user = await regular.getCurrentUser()
  expect(user.status).toBe(200)
  const regularId = (user.data as { id: number }).id
  const adminHeaders = createBackendRequestHeaders(adminLogin.data!.access_token)
  const regularHeaders = createBackendRequestHeaders(regularLogin.data!.access_token)
  const base = process.env.E2E_API_URL || 'http://localhost:8000'
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const namespace = `stable-url-${suffix}`
  const name = `Same name ${suffix}`
  const created: Array<{ id: number; headers: Record<string, string> }> = []
  const group = await admin.createGroup({ name: namespace })
  expect(group.status).toBe(201)
  const requestedDocumentIds: number[] = []
  page.on('request', req => {
    const match = new URL(req.url()).pathname.match(/\/api\/knowledge-bases\/(\d+)\/documents$/)
    if (match) requestedDocumentIds.push(Number(match[1]))
  })

  try {
    expect(
      (await admin.addGroupMember(namespace, { user_id: regularId, role: 'Maintainer' })).status
    ).toBe(201)
    for (const headers of [adminHeaders, regularHeaders]) {
      const response = await request.post(`${base}/api/knowledge-bases`, {
        headers,
        data: { name, namespace, kb_type: 'classic', summary_enabled: false },
      })
      expect(response.ok(), await response.text()).toBeTruthy()
      created.push({ id: (await response.json()).id, headers })
    }
    const selected = created[1].id
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto(`/knowledge?type=document&group=group-${namespace}`)
    await expect(page.getByTestId(`kb-row-${created[0].id}`)).toBeVisible()
    await page.getByTestId(`kb-row-${selected}`).click()
    await expect(page.getByTestId('knowledge-detail-classic')).toBeVisible()
    await expect(page).toHaveURL(url => url.searchParams.get('kb') === String(selected))
    const copiedUrl = page.url()

    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 })
      requestedDocumentIds.length = 0
      const listed = page.waitForResponse(
        response =>
          new URL(response.url()).pathname === `/api/knowledge-bases/${selected}/documents` &&
          response.ok()
      )
      await page.goto(copiedUrl)
      await listed
      await expect(page.getByTestId('knowledge-detail-classic')).toBeVisible()
      await page.reload()
      await expect(page.getByTestId('knowledge-detail-classic')).toBeVisible()
      expect(requestedDocumentIds.length).toBeGreaterThan(0)
      expect(requestedDocumentIds.every(id => id === selected)).toBe(true)
    }

    const renamed = await request.put(`${base}/api/knowledge-bases/${selected}`, {
      headers: regularHeaders,
      data: { name: `${name} renamed` },
    })
    expect(renamed.ok(), await renamed.text()).toBeTruthy()
    await page.goto(copiedUrl)
    await expect(page.getByTestId('knowledge-detail-classic')).toBeVisible()
    await expect(page).toHaveURL(
      url =>
        url.searchParams.get('kb') === String(selected) &&
        decodeURIComponent(url.pathname).endsWith(`${name} renamed`)
    )

    await page.goto(`/knowledge/document/${selected}?kb=${created[0].id}&documentId=7`)
    await expect(page).toHaveURL(
      url =>
        url.searchParams.get('kb') === String(selected) &&
        url.searchParams.get('documentId') === '7' &&
        !url.pathname.includes('/knowledge/document/')
    )
    await expect(page.getByTestId('knowledge-detail-classic')).toBeVisible()
  } finally {
    for (const resource of created.reverse()) {
      const response = await request.delete(`${base}/api/knowledge-bases/${resource.id}`, {
        headers: resource.headers,
      })
      expect(response.ok(), await response.text()).toBeTruthy()
    }
    expect((await admin.deleteGroup(namespace)).status).toBe(204)
  }
})
