// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { expect } from '@playwright/test'
import { checked, test } from '../../fixtures/recent-team-history'

// Runs in the default CI API suite with real routing, authentication and persistence.
test('internal service authentication protects persisted task preview data', async ({
  history,
  request,
}) => {
  const token = process.env.E2E_INTERNAL_SERVICE_TOKEN || process.env.INTERNAL_SERVICE_TOKEN
  expect(token, 'The E2E Backend internal service token must be configured').toBeTruthy()
  const team = await history.team('services-auth')
  const task = await history.seed(team)
  const headers = { Authorization: `Bearer ${token}` }
  const baseline = { name: 'Generated app', previewUrl: 'https://preview.example.test/app' }
  const updatePath = '/api/internal/services/update'
  const readPath = `/api/internal/services/${task.id}`
  const userReadPath = `/api/tasks/${task.id}/services`

  const initial = await request.post(updatePath, {
    headers,
    data: { task_id: task.id, ...baseline },
  })
  expect(initial.status()).toBe(200)
  expect(await initial.json()).toEqual({ success: true, app: baseline })

  const unauthorizedHeaders: Record<string, string>[] = [
    {},
    { Authorization: 'Bearer invalid-internal-token' },
    { Authorization: `Bearer ${history.token}` },
  ]
  for (const unauthorized of unauthorizedHeaders) {
    const write = await request.post(updatePath, {
      headers: unauthorized,
      data: { task_id: task.id, previewUrl: 'javascript:alert(1)' },
    })
    expect(write.status()).toBe(401)
    expect(write.headers()['www-authenticate']).toBe('Bearer')
    const read = await request.get(readPath, { headers: unauthorized })
    expect(read.status()).toBe(401)
    expect(checked(await history.api.get(userReadPath))).toEqual({ app: baseline })
  }

  const previewUrl = 'https://preview.example.test/updated'
  const updated = await request.post(updatePath, {
    headers,
    data: { task_id: task.id, previewUrl },
  })
  expect(updated.status()).toBe(200)
  expect(await updated.json()).toEqual({ success: true, app: { ...baseline, previewUrl } })
  const persisted = await request.get(readPath, { headers })
  expect(persisted.status()).toBe(200)
  expect(await persisted.json()).toEqual({ success: true, app: { ...baseline, previewUrl } })
  expect(checked(await history.api.get(userReadPath))).toEqual({
    app: { ...baseline, previewUrl },
  })
})
