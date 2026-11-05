// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from '@playwright/test'
import { ADMIN_USER } from '../../config/test-users'
import { createApiClient, createBackendRequestHeaders } from '../../utils/api-client'

// The default Chromium project runs this scenario in the existing CI shards.
// All application APIs and persistence are real; no provider or model is needed.
test('company URL keeps its document requests scoped despite same-name personal and team KBs', async ({
  page,
  request,
}) => {
  const client = createApiClient(request)
  const login = await client.login(ADMIN_USER.username, ADMIN_USER.password)
  expect(login.status).toBe(200)
  const headers = createBackendRequestHeaders(login.data!.access_token)
  const base = process.env.E2E_API_URL || 'http://localhost:8000'
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const name = `Scoped KB ${suffix}`
  const companyNamespace = `company-url-${suffix}`
  const teamNamespace = `team-url-${suffix}`
  const namespaces: string[] = []
  const ids: number[] = []
  const documentRequests: number[] = []
  page.on('request', req => {
    const match = new URL(req.url()).pathname.match(/\/api\/knowledge-bases\/(\d+)\/documents$/)
    if (match) documentRequests.push(Number(match[1]))
  })

  try {
    for (const [namespace, level] of [
      [companyNamespace, 'organization'],
      [teamNamespace, 'group'],
    ]) {
      const response = await client.createGroup({ name: namespace, level })
      expect(response.status).toBe(201)
      namespaces.push(namespace)
    }
    // The company KB is older; the team KB comes first in the sidebar's global list.
    for (const namespace of [companyNamespace, 'default', teamNamespace]) {
      const response = await request.post(`${base}/api/knowledge-bases`, {
        headers,
        data: { name, namespace, kb_type: 'classic', summary_enabled: false },
      })
      expect(response.ok(), await response.text()).toBeTruthy()
      ids.push((await response.json()).id)
    }
    const companyId = ids[0]
    const teamId = ids[2]
    const url = `/knowledge/public/${encodeURIComponent(name)}`
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 })
      documentRequests.length = 0
      const listed = page.waitForResponse(
        response =>
          new URL(response.url()).pathname === `/api/knowledge-bases/${companyId}/documents` &&
          response.ok()
      )
      await page.goto(url)
      await listed
      await expect(page.getByTestId('knowledge-detail-classic')).toBeVisible()
      expect(documentRequests.length).toBeGreaterThan(0)
      expect(documentRequests.every(id => id === companyId)).toBe(true)
    }
    const renamed = await request.put(`${base}/api/knowledge-bases/${teamId}`, {
      headers,
      data: { name: `${name} renamed` },
    })
    expect(renamed.ok(), await renamed.text()).toBeTruthy()
    documentRequests.length = 0
    const listed = page.waitForResponse(
      response =>
        new URL(response.url()).pathname === `/api/knowledge-bases/${companyId}/documents` &&
        response.ok()
    )
    await page.goto(url)
    await listed
    await expect(page.getByTestId('knowledge-detail-classic')).toBeVisible()
    expect(documentRequests.every(id => id === companyId)).toBe(true)
  } finally {
    for (const id of ids.reverse()) {
      const response = await request.delete(`${base}/api/knowledge-bases/${id}`, { headers })
      expect(response.ok(), await response.text()).toBeTruthy()
    }
    for (const namespace of namespaces.reverse()) {
      expect((await client.deleteGroup(namespace)).status).toBe(204)
    }
  }
})
