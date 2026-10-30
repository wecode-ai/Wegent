// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CollaborationTemplatePage } from './CollaborationTemplatePage'
import { CollaborationTemplateStore } from './store'
import { builtinCollaborationTemplates } from './builtins'
import type { CollaborationTemplateRemote, TemplateRecord } from './types'

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true
    },
  })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = false
    },
  })
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

function remote(): CollaborationTemplateRemote {
  return {
    discover: vi.fn(async () => ({
      items: [],
      hasMore: false,
      nextCursor: null,
    })),
    list: vi.fn(async () => []),
    get: vi.fn(),
    save: vi.fn(),
    install: vi.fn(),
    publish: vi.fn(),
  }
}

async function click(testId: string) {
  const target = container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)
  expect(target).not.toBeNull()
  await act(async () => target!.click())
}

it('downloads the version shown in preview instead of using an older cached definition', async () => {
  const backend = remote()
  const old: TemplateRecord = {
    ...builtinCollaborationTemplates()[0],
    id: 42,
    ownerId: 8,
    source: 'downloaded',
  }
  old.document = structuredClone(old.document)
  old.document.metadata = { name: 'shared-product', namespace: 'default' }
  const updated = structuredClone(old)
  updated.document.spec.version = '2.0.0'
  updated.document.spec.resources.collaboration.groups[0].instructions = 'New workflow'
  vi.mocked(backend.get).mockResolvedValue(updated)
  vi.mocked(backend.discover).mockResolvedValue({
    items: [
      {
        id: 42,
        resource_type: 'template',
        name: 'shared-product',
        display_name: 'Shared product',
        publisher_user_id: 8,
        publisher_namespace: 'default',
        is_installed: true,
        current_version: { version: '2.0.0' },
      },
    ],
    hasMore: false,
    nextCursor: null,
  })
  const store = new CollaborationTemplateStore({
    scope: 'backend:7',
    ownerId: 7,
    remote: backend,
    persistence: {
      read: async () => [old],
      write: vi.fn(async () => undefined),
    },
  })
  const onUse = vi.fn()
  await act(async () =>
    root.render(<CollaborationTemplatePage store={store} locale="en" onUse={onUse} />)
  )
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 250))
  })
  await click('template-details-42')
  await click('template-use')
  expect(onUse).toHaveBeenCalledWith(expect.objectContaining({ document: updated.document }))
  expect(backend.install).toHaveBeenCalledWith(42)
  expect(store.getSnapshot().records.find(record => record.id === 42)?.document.spec.version).toBe(
    '2.0.0'
  )
})

it('keeps cached templates usable when independent discovery requests fail', async () => {
  const backend = remote()
  vi.mocked(backend.discover).mockRejectedValue(new Error('discovery unavailable'))
  const store = new CollaborationTemplateStore({
    scope: 'backend:7',
    ownerId: 7,
    remote: backend,
    persistence: { read: async () => [], write: async () => undefined },
  })
  const onUse = vi.fn()
  await act(async () =>
    root.render(<CollaborationTemplatePage store={store} locale="en" onUse={onUse} />)
  )
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 250))
  })
  expect(container.querySelector('[role="alert"]')).not.toBeNull()
  await click('template-details-product-lifecycle')
  await click('template-use')
  expect(onUse).toHaveBeenCalledOnce()
  expect(backend.get).not.toHaveBeenCalled()
})

it('shows server-installed templates under marketplace capabilities without downloading them', async () => {
  const backend = remote()
  vi.mocked(backend.list).mockResolvedValue([
    {
      id: 42,
      ownerId: 8,
      name: 'shared-product',
      namespace: 'default',
      displayName: 'Shared product',
      description: 'Team workflow',
      version: '1.0.0',
      revision: '1',
    },
  ])
  const store = new CollaborationTemplateStore({
    scope: 'backend:7',
    ownerId: 7,
    remote: backend,
    persistence: { read: async () => [], write: async () => undefined },
  })
  await act(async () =>
    root.render(<CollaborationTemplatePage store={store} locale="en" mode="marketplace" />)
  )
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 250))
  })
  await click('template-tab-available')
  expect(container.textContent).toContain('My capabilities')
  expect(container.textContent).toContain('Shared product')
  expect(backend.get).not.toHaveBeenCalled()
})
