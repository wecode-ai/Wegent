// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { expect } from '@playwright/test'
import type { ApiClient } from './api-client'

export async function deleteDedicatedBotModel(api: ApiClient, name: string): Promise<void> {
  const path = `/api/v1/namespaces/default/models/${name}-model`
  const model = await api.get<{
    metadata: { name: string; namespace: string }
    spec: { isCustomConfig: boolean }
  }>(path)
  expect([200, 404], JSON.stringify(model.data)).toContain(model.status)
  // Selecting a predefined Model already removes the generated dedicated Model.
  if (model.status === 404) return
  expect(model.data?.metadata).toMatchObject({ name: `${name}-model`, namespace: 'default' })
  expect(model.data?.spec.isCustomConfig).toBe(true)
  const removed = await api.delete(path)
  expect(removed.status, JSON.stringify(removed.data)).toBe(200)
}
