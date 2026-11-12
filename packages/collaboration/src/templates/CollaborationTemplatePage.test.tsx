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
import { TemplateBindings } from './TemplateBindings'

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
    delete: vi.fn(),
  }
}

async function click(testId: string) {
  const target = container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)
  expect(target).not.toBeNull()
  await act(async () => target!.click())
}

it.each(['en', 'zh-CN'] as const)(
  'confirms deletion, preserves cancellation and retries failure in %s',
  async locale => {
    const backend = remote()
    const document = structuredClone(builtinCollaborationTemplates()[0].document)
    document.metadata = { name: 'imported-workflow', namespace: 'default' }
    const record: TemplateRecord = {
      id: 42,
      ownerId: 7,
      source: 'personal',
      document,
      revision: '1',
    }
    const write = vi.fn(async () => undefined)
    const store = new CollaborationTemplateStore({
      scope: 'backend:7',
      ownerId: 7,
      remote: backend,
      persistence: { read: async () => [record], write },
    })
    await act(async () => root.render(<CollaborationTemplatePage store={store} locale={locale} />))
    expect(container.querySelector('[data-testid="template-delete-product-lifecycle"]')).toBeNull()
    await click('template-tab-mine')
    await click('template-delete-imported-workflow')
    expect(container.querySelector('dialog')?.textContent).toContain(document.spec.displayName)
    expect(backend.delete).not.toHaveBeenCalled()
    await click('template-delete-cancel')
    expect(
      container.querySelector('[data-testid="template-card-imported-workflow"]')
    ).not.toBeNull()
    await click('template-delete-imported-workflow')
    vi.mocked(backend.delete).mockRejectedValueOnce(new Error('network unavailable'))
    await click('template-delete-confirm')
    expect(container.querySelector('dialog [role="alert"]')).not.toBeNull()
    expect(write).not.toHaveBeenCalled()
    await click('template-delete-confirm')
    expect(backend.delete).toHaveBeenCalledWith(42)
    expect(container.querySelector('dialog')).toBeNull()
    expect(container.querySelector('[data-testid="template-card-imported-workflow"]')).toBeNull()
  }
)

it('never offers deletion of other users’ downloaded templates', async () => {
  const record = structuredClone(builtinCollaborationTemplates()[0])
  record.ownerId = 8
  record.id = 42
  record.source = 'downloaded'
  record.document.metadata = { name: 'someone-else', namespace: 'default' }
  const store = new CollaborationTemplateStore({
    scope: 'backend:7',
    ownerId: 7,
    remote: remote(),
    persistence: { read: async () => [record], write: vi.fn() },
  })
  await act(async () => root.render(<CollaborationTemplatePage store={store} locale="en" />))
  expect(container.querySelector('[data-testid="template-card-someone-else"]')).not.toBeNull()
  expect(container.querySelector('[data-testid^="template-delete-"]')).toBeNull()
})

it('deletes account-only templates and invalidates their list metadata', async () => {
  const backend = remote()
  const document = structuredClone(builtinCollaborationTemplates()[0].document)
  document.metadata = { name: 'account-only', namespace: 'default' }
  vi.mocked(backend.get).mockResolvedValue({
    id: 42,
    ownerId: 7,
    document,
    source: 'personal',
    revision: '1',
  })
  vi.mocked(backend.list).mockResolvedValue([
    {
      id: 42,
      ownerId: 7,
      namespace: 'default',
      name: 'account-only',
      displayName: 'Account only',
      description: '',
      version: '1.0.0',
      revision: '1',
    },
    {
      id: 43,
      ownerId: 7,
      namespace: 'shared-space',
      name: 'shared-workflow',
      displayName: 'Shared workflow',
      description: '',
      version: '1.0.0',
      revision: '1',
    },
  ])
  const store = new CollaborationTemplateStore({
    scope: 'backend:7',
    ownerId: 7,
    remote: backend,
    persistence: { read: async () => [], write: vi.fn() },
  })
  await act(async () => root.render(<CollaborationTemplatePage store={store} locale="en" />))
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 250))
  })
  await click('template-tab-mine')
  expect(container.querySelector('[data-testid="template-delete-43"]')).toBeNull()
  await click('template-delete-42')
  vi.mocked(backend.list).mockResolvedValue([])
  await click('template-delete-confirm')
  expect(backend.get).toHaveBeenCalledWith(42)
  expect(backend.delete).toHaveBeenCalledWith(42)
  expect(container.querySelector('[data-testid="template-card-42"]')).toBeNull()
})

it('keeps the use action available after adding a marketplace template to the account', async () => {
  const backend = remote()
  const record: TemplateRecord = {
    ...structuredClone(builtinCollaborationTemplates()[0]),
    id: 42,
    ownerId: 8,
    source: 'downloaded',
  }
  record.document.metadata = { name: 'shared-workflow', namespace: 'default' }
  const store = new CollaborationTemplateStore({
    scope: 'backend:7',
    ownerId: 7,
    remote: backend,
    persistence: { read: async () => [record], write: async () => {} },
  })
  const onUse = vi.fn()
  await act(async () =>
    root.render(
      <CollaborationTemplatePage store={store} locale="en" mode="marketplace" onUse={onUse} />
    )
  )
  await click('template-details-shared-workflow')
  await click('template-account-add')
  expect(backend.install).toHaveBeenCalledWith(42)
  expect(container.querySelector('[data-testid="template-use"]')?.textContent).toBe('Use template')
  await click('template-use')
  expect(onUse).toHaveBeenCalledWith(record)
})

it('preconfigures a new Agent coordinator instead of requiring an existing Agent', async () => {
  const document = builtinCollaborationTemplates()[0].document
  await act(async () =>
    root.render(
      <TemplateBindings
        document={document}
        locale="zh-CN"
        currentUserId={7}
        candidates={[
          { kind: 'human', id: '7', label: '我', responsibility: '' },
          {
            kind: 'agent',
            id: 'coordinator',
            label: '负责人智能体',
            responsibility: '',
          },
          {
            kind: 'agent',
            id: 'executor',
            label: '执行智能体',
            responsibility: '',
          },
        ]}
        onChange={vi.fn()}
      />
    )
  )
  expect(
    container.querySelector<HTMLSelectElement>('[data-testid="template-role-main-role-0"]')!.value
  ).toBe('agent:template-agent:main-role-0')
})

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

it.each(['desktop', 'marketplace'] as const)(
  'shows account-installed templates in %s without downloading them',
  async mode => {
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
      root.render(<CollaborationTemplatePage store={store} locale="en" mode={mode} />)
    )
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 250))
    })
    await click('template-tab-available')
    if (mode === 'marketplace') expect(container.textContent).toContain('My capabilities')
    expect(container.textContent).toContain('Shared product')
    expect(backend.get).not.toHaveBeenCalled()
  }
)

it('uses a private template update advertised by account metadata instead of an older local copy', async () => {
  const backend = remote()
  const previous: TemplateRecord = {
    ...builtinCollaborationTemplates()[0],
    id: 42,
    ownerId: 7,
    source: 'personal',
  }
  previous.document = structuredClone(previous.document)
  previous.document.metadata = {
    name: 'private-workflow',
    namespace: 'default',
  }
  const updated = structuredClone(previous)
  updated.document.spec.version = '2.0.0'
  vi.mocked(backend.get).mockResolvedValue(updated)
  vi.mocked(backend.list).mockResolvedValue([
    {
      id: 42,
      ownerId: 7,
      namespace: 'default',
      name: 'private-workflow',
      displayName: 'Private workflow',
      description: '',
      version: '2.0.0',
      revision: '2',
    },
  ])
  const store = new CollaborationTemplateStore({
    scope: 'backend:7',
    ownerId: 7,
    remote: backend,
    persistence: { read: async () => [previous], write: async () => undefined },
  })
  const onUse = vi.fn()
  await act(async () =>
    root.render(<CollaborationTemplatePage store={store} locale="en" onUse={onUse} />)
  )
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 250))
  })
  await click('template-tab-mine')
  await click('template-details-42')
  await click('template-use')
  expect(onUse).toHaveBeenCalledWith(expect.objectContaining({ document: updated.document }))
  expect(backend.install).not.toHaveBeenCalled()
})
