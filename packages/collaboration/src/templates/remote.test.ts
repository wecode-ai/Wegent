// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect, it, vi } from 'vitest'
import { builtinCollaborationTemplates } from './builtins'
import { createCollaborationTemplateRemote, type TemplateHttpClient } from './remote'
import { CollaborationTemplateStore } from './store'
import type { TemplateRecord } from './types'

it('keeps the valid pending draft when a save response contains invalid configuration', async () => {
  const document = structuredClone(builtinCollaborationTemplates()[0].document)
  document.metadata = { name: 'personal-workflow', namespace: 'default' }
  const invalid = { ...document, credentials: 'invalid server field' }
  const client = {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(async () => ({ id: 42, ownerId: 7, document: invalid, source: 'personal' })),
  } as unknown as TemplateHttpClient
  let cached: TemplateRecord[] = []
  const store = new CollaborationTemplateStore({
    scope: 'backend:7',
    ownerId: 7,
    remote: createCollaborationTemplateRemote(client),
    persistence: {
      read: async () => structuredClone(cached),
      write: async records => { cached = structuredClone(records) },
    },
  })
  await store.save(document, 7)
  expect(cached).toHaveLength(1)
  expect(cached[0]).toMatchObject({ document, pendingSync: true })
  expect(cached[0].syncError).toBeTruthy()
  expect(cached[0].document).not.toHaveProperty('credentials')
})
