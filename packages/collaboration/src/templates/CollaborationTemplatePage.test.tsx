// @vitest-environment jsdom
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CollaborationTemplatePage } from './CollaborationTemplatePage'
import { createTemplatePageNavigation, templatePageDetail } from './templatePageNavigation'
import { CollaborationTemplateStore } from './store'
import { builtinCollaborationTemplates } from './builtins'
import type { CollaborationTemplateRemote, TemplateRecord } from './types'
import { TemplateBindings } from './TemplateBindings'
import { TemplateDialog } from './TemplateDialog'

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

it('cancels only the nested template dialog and restores its trigger', async () => {
  const parentClosed = vi.fn()
  const childClosed = vi.fn()
  const render = (nested: boolean) => (
    <TemplateDialog title="Template library" closeLabel="Close" onClose={parentClosed}>
      <button data-testid="import-trigger">Import YAML</button>
      {nested && (
        <TemplateDialog title="Import YAML" closeLabel="Close" onClose={childClosed}>
          <textarea aria-label="YAML" />
        </TemplateDialog>
      )}
    </TemplateDialog>
  )
  await act(async () => root.render(render(false)))
  const trigger = container.querySelector<HTMLButtonElement>('[data-testid="import-trigger"]')!
  trigger.focus()
  await act(async () => root.render(render(true)))
  const nested = container.querySelectorAll('dialog')[1]
  await act(async () => nested.dispatchEvent(new Event('cancel', { cancelable: true })))
  expect(childClosed).toHaveBeenCalledOnce()
  expect(parentClosed).not.toHaveBeenCalled()
  await act(async () => root.render(render(false)))
  expect(document.activeElement).toBe(trigger)
  expect(container.querySelector('dialog')!.open).toBe(true)
})

async function click(testId: string) {
  const target = container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)
  expect(target).not.toBeNull()
  await act(async () => target!.click())
}

it('browses template details within the existing picker dialog and returns without losing the library', async () => {
  const store = new CollaborationTemplateStore({
    scope: 'local:7',
    ownerId: 7,
    persistence: { read: async () => [], write: async () => undefined },
  })
  const navigation = createTemplatePageNavigation(store)
  await act(async () =>
    root.render(
      <TemplateDialog title="Choose template" closeLabel="Close" onClose={vi.fn()}>
        <CollaborationTemplatePage
          embedded
          store={store}
          locale="en"
          onUse={vi.fn()}
          navigation={navigation}
        />
      </TemplateDialog>
    )
  )
  await click('template-details-product-lifecycle')
  expect(container.querySelectorAll('dialog[open]')).toHaveLength(1)
  expect(container.querySelector('[data-testid="template-inline-detail"]')).not.toBeNull()
  expect(container.querySelector('[data-testid="template-detail-cancel"]')).toBeNull()
  await act(async () => templatePageDetail(navigation, 'en')?.onBack())
  expect(container.querySelector('[data-testid="template-inline-detail"]')).toBeNull()
  expect(container.querySelector('[data-testid="template-search"]')).not.toBeNull()
  expect(container.querySelectorAll('dialog[open]')).toHaveLength(1)
})

it('retains its own Back action when the inline picker has no host navigation', async () => {
  const store = new CollaborationTemplateStore({
    scope: 'local:7',
    ownerId: 7,
    persistence: { read: async () => [], write: async () => undefined },
  })
  await act(async () =>
    root.render(
      <TemplateDialog title="Choose template" closeLabel="Close" onClose={vi.fn()}>
        <CollaborationTemplatePage embedded store={store} locale="en" onUse={vi.fn()} />
      </TemplateDialog>
    )
  )
  await click('template-details-product-lifecycle')
  expect(container.querySelectorAll('dialog[open]')).toHaveLength(1)
  expect(container.querySelector('[data-testid="template-inline-detail"]')).not.toBeNull()
  await click('template-detail-cancel')
  expect(container.querySelector('[data-testid="template-inline-detail"]')).toBeNull()
  expect(container.querySelector('[data-testid="template-search"]')).not.toBeNull()
  expect(container.querySelectorAll('dialog[open]')).toHaveLength(1)
})

function pendingRemoteDetail() {
  const backend = remote()
  const record = structuredClone(builtinCollaborationTemplates()[0])
  record.id = 42
  record.ownerId = 8
  record.source = 'downloaded'
  record.document.metadata = {
    name: 'remote-only-workflow',
    namespace: 'default',
  }
  let resolve!: (record: TemplateRecord) => void
  let reject!: (reason: Error) => void
  const pending = new Promise<TemplateRecord>((complete, fail) => {
    resolve = complete
    reject = fail
  })
  vi.mocked(backend.get).mockReturnValue(pending)
  vi.mocked(backend.discover).mockResolvedValue({
    items: [
      {
        id: 42,
        resource_type: 'template',
        name: record.document.metadata.name,
        display_name: record.document.spec.displayName,
        publisher_user_id: 8,
        publisher_namespace: 'default',
        current_version: { version: record.document.spec.version },
        is_installed: false,
      },
    ],
    hasMore: false,
    nextCursor: null,
  })
  const store = new CollaborationTemplateStore({
    scope: 'backend:7',
    ownerId: 7,
    remote: backend,
    persistence: { read: async () => [], write: vi.fn(async () => undefined) },
  })
  return { backend, record, store, resolve, reject }
}

it('prevents overlapping import and remote detail panels while a detail request is pending', async () => {
  vi.useFakeTimers()
  const fixture = pendingRemoteDetail()
  const footer = document.createElement('footer')
  document.body.append(footer)
  try {
    await act(async () =>
      root.render(
        <CollaborationTemplatePage
          store={fixture.store}
          locale="en"
          embedded
          footerTarget={footer}
        />
      )
    )
    await act(async () => vi.advanceTimersByTimeAsync(200))
    await click('template-details-42')
    expect(fixture.backend.get).toHaveBeenCalledWith(42)
    const importButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="template-import-open"]'
    )!
    const importBlocked = importButton.disabled
    await click('template-import-open')
    const importedWhilePending = Boolean(
      container.querySelector('[data-testid="template-import-file"]')
    )
    await act(async () => fixture.resolve(fixture.record))
    expect(container.querySelectorAll('[data-testid="template-inline-detail"]')).toHaveLength(1)
    expect(importBlocked).toBe(true)
    expect(importedWhilePending).toBe(false)
    expect(container.querySelector('[data-testid="template-import-file"]')).toBeNull()
    expect(footer.querySelectorAll('button')).toHaveLength(2)
    expect(footer.querySelector('[data-testid="template-detail-cancel"]')).not.toBeNull()
    expect(footer.querySelector('[data-testid="template-use"]')).not.toBeNull()
    expect(footer.querySelector('[data-testid="template-import-save"]')).toBeNull()
  } finally {
    footer.remove()
    vi.useRealTimers()
  }
})

it.each(['resolved', 'rejected'] as const)(
  'restores an enabled remote detail trigger after its pending request is %s',
  async outcome => {
    vi.useFakeTimers()
    const fixture = pendingRemoteDetail()
    const navigation = createTemplatePageNavigation(fixture.store)
    try {
      await act(async () =>
        root.render(
          <CollaborationTemplatePage
            store={fixture.store}
            locale="en"
            embedded
            navigation={navigation}
          />
        )
      )
      await act(async () => vi.advanceTimersByTimeAsync(200))
      const trigger = container.querySelector<HTMLButtonElement>(
        '[data-testid="template-details-42"]'
      )!
      trigger.focus()
      const focusWhileDisabled: boolean[] = []
      const focus = trigger.focus.bind(trigger)
      vi.spyOn(trigger, 'focus').mockImplementation(() => {
        focusWhileDisabled.push(trigger.disabled)
        focus()
      })
      await click('template-details-42')
      expect(trigger.disabled).toBe(true)
      container.querySelector<HTMLInputElement>('[data-testid="template-search"]')!.focus()
      expect(document.activeElement).not.toBe(trigger)
      if (outcome === 'resolved') {
        await act(async () => fixture.resolve(fixture.record))
        expect(container.querySelector('[data-testid="template-inline-detail"]')).not.toBeNull()
        await act(async () => templatePageDetail(navigation, 'en')!.onBack())
        expect(container.querySelector('[data-testid="template-inline-detail"]')).toBeNull()
      } else {
        await act(async () => fixture.reject(new Error('detail download failed')))
        expect(container.querySelector('[role="alert"]')).not.toBeNull()
      }
      expect(trigger.disabled).toBe(false)
      expect(document.activeElement).toBe(trigger)
      expect(focusWhileDisabled).not.toContain(true)
    } finally {
      vi.useRealTimers()
    }
  }
)

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
  expect(container.querySelector('[data-testid="template-role-main-role-0"]')).toBeNull()
  const customize = container.querySelector<HTMLDetailsElement>('details')!
  await act(async () => {
    customize.open = true
    customize.dispatchEvent(new Event('toggle'))
  })
  expect(container.querySelector('[data-testid="template-roster-main"]')).toBeNull()
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

it('cancels embedded import in place without writing and restores its trigger', async () => {
  const backend = remote()
  const write = vi.fn(async () => undefined)
  const store = new CollaborationTemplateStore({
    scope: 'backend:7',
    ownerId: 7,
    remote: backend,
    persistence: { read: async () => [], write },
  })
  const navigation = createTemplatePageNavigation(store)
  await act(async () =>
    root.render(
      <CollaborationTemplatePage store={store} locale="en" embedded navigation={navigation} />
    )
  )
  const trigger = container.querySelector<HTMLButtonElement>(
    '[data-testid="template-import-open"]'
  )!
  trigger.focus()
  await click('template-import-open')
  expect(container.querySelectorAll('dialog')).toHaveLength(0)
  expect(container.querySelector('[data-testid="template-import-file"]')).not.toBeNull()
  expect(templatePageDetail(navigation, 'en')?.title).toBe('Import collaboration template')
  expect(container.querySelector('[data-testid="template-import-cancel"]')).toBeNull()
  await act(async () => templatePageDetail(navigation, 'en')!.onBack())
  expect(container.querySelector('[data-testid="template-import-file"]')).toBeNull()
  expect(document.activeElement).toBe(trigger)
  expect(backend.save).not.toHaveBeenCalled()
  expect(write).not.toHaveBeenCalled()
  expect(templatePageDetail(navigation, 'en')).toBeNull()
})

it('cancels embedded deletion in place without deleting and restores its trigger', async () => {
  const backend = remote()
  const record = structuredClone(builtinCollaborationTemplates()[0])
  record.id = 42
  record.ownerId = 7
  record.source = 'personal'
  record.document.metadata = { name: 'owned-template', namespace: 'default' }
  const write = vi.fn(async () => undefined)
  const store = new CollaborationTemplateStore({
    scope: 'backend:7',
    ownerId: 7,
    remote: backend,
    persistence: { read: async () => [record], write },
  })
  const navigation = createTemplatePageNavigation(store)
  await act(async () =>
    root.render(
      <CollaborationTemplatePage store={store} locale="en" embedded navigation={navigation} />
    )
  )
  await click('template-tab-mine')
  const trigger = container.querySelector<HTMLButtonElement>(
    '[data-testid="template-delete-owned-template"]'
  )!
  trigger.focus()
  await click('template-delete-owned-template')
  expect(container.querySelectorAll('dialog')).toHaveLength(0)
  expect(templatePageDetail(navigation, 'en')?.title).toBe('Delete template')
  expect(container.querySelector('[data-testid="template-delete-confirm"]')).not.toBeNull()
  expect(container.querySelector('[data-testid="template-delete-cancel"]')).toBeNull()
  await act(async () => templatePageDetail(navigation, 'en')!.onBack())
  expect(container.querySelector('[data-testid="template-delete-confirm"]')).toBeNull()
  expect(document.activeElement).toBe(trigger)
  expect(backend.delete).not.toHaveBeenCalled()
  expect(write).not.toHaveBeenCalled()
  expect(templatePageDetail(navigation, 'en')).toBeNull()
})

it('keeps embedded deletion open while its write is in progress', async () => {
  const backend = remote()
  let finish!: () => void
  vi.mocked(backend.delete).mockImplementation(
    () =>
      new Promise<void>(resolve => {
        finish = resolve
      })
  )
  const record = structuredClone(builtinCollaborationTemplates()[0])
  record.id = 42
  record.ownerId = 7
  record.source = 'personal'
  record.document.metadata = { name: 'owned-template', namespace: 'default' }
  const store = new CollaborationTemplateStore({
    scope: 'backend:7',
    ownerId: 7,
    remote: backend,
    persistence: { read: async () => [record], write: async () => {} },
  })
  const navigation = createTemplatePageNavigation(store)
  await act(async () =>
    root.render(
      <CollaborationTemplatePage store={store} locale="en" embedded navigation={navigation} />
    )
  )
  await click('template-tab-mine')
  await click('template-delete-owned-template')
  await click('template-delete-confirm')
  await act(async () => templatePageDetail(navigation, 'en')!.onBack())
  expect(container.querySelector('[data-testid="template-delete-confirm"]')).not.toBeNull()
  expect(container.querySelectorAll('dialog')).toHaveLength(0)
  await act(async () => finish())
  expect(container.querySelector('[data-testid="template-delete-confirm"]')).toBeNull()
  expect(document.activeElement).toBe(container.querySelector('[data-testid="template-search"]'))
})

it('uses localized builtin content and keeps raw records when switching the detail language', async () => {
  const write = vi.fn(async () => undefined)
  const store = new CollaborationTemplateStore({
    scope: 'local:translation',
    ownerId: 7,
    persistence: { read: async () => [], write },
  })
  const onUse = vi.fn()
  await act(async () =>
    root.render(<CollaborationTemplatePage store={store} locale="en" onUse={onUse} />)
  )
  await click('template-details-product-lifecycle')
  expect(container.textContent).toContain('Product lifecycle')
  await act(async () =>
    root.render(<CollaborationTemplatePage store={store} locale="zh-CN" onUse={onUse} />)
  )
  expect(container.textContent).toContain('产品全流程')
  await act(async () =>
    root.render(<CollaborationTemplatePage store={store} locale="en" onUse={onUse} />)
  )
  await click('template-use')
  const document = onUse.mock.calls[0][0].document
  expect(document.spec.resources.collaboration.project.name).toBe('Product lifecycle collaboration')
  expect(document.spec.resources.collaboration.groups[0].roles[0].name).toBe('Project lead')
  expect(store.getSnapshot().records[0].document.spec.displayName).toBe('产品全流程')
  expect(write).not.toHaveBeenCalled()
})

it.each([0, 8])(
  'only associates publisher %s with the first-party cached listing',
  async publisher => {
    vi.useFakeTimers()
    try {
      const backend = remote()
      vi.mocked(backend.discover).mockResolvedValue({
        items: [
          {
            id: 42,
            resource_type: 'template',
            name: 'product-lifecycle',
            display_name: 'Server title',
            description: 'Server description',
            publisher_user_id: publisher,
            publisher_namespace: 'system',
            is_installed: false,
            current_version: { version: '1.2.0' },
          },
        ],
        hasMore: false,
        nextCursor: null,
      })
      const store = new CollaborationTemplateStore({
        scope: 'backend:translation',
        ownerId: 7,
        remote: backend,
        persistence: { read: async () => [], write: async () => {} },
      })
      await act(async () => root.render(<CollaborationTemplatePage store={store} locale="en" />))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200)
      })
      const firstParty = container.querySelector('[data-testid="template-card-product-lifecycle"]')!
      expect(firstParty.textContent).toContain('Product lifecycle')
      expect(firstParty.textContent).not.toContain('Server title')
      expect(
        container.querySelector('[data-testid="template-card-42"]')?.textContent ?? ''
      ).toEqual(publisher === 8 ? expect.stringContaining('Server title') : '')
    } finally {
      vi.useRealTimers()
    }
  }
)

it('localizes raw remote detail and download without persisting translated content', async () => {
  vi.useFakeTimers()
  try {
    const backend = remote()
    const record = { ...builtinCollaborationTemplates()[0], id: 42 }
    const old = structuredClone(record)
    old.document.spec.version = '9.0.0'
    vi.mocked(backend.get).mockResolvedValue(record)
    vi.mocked(backend.discover).mockResolvedValue({
      items: [
        {
          id: 42,
          resource_type: 'template',
          name: 'product-lifecycle',
          display_name: 'Server title',
          publisher_user_id: 0,
          publisher_namespace: 'system',
          is_installed: true,
          current_version: { version: '1.2.0' },
        },
      ],
      hasMore: false,
      nextCursor: null,
    })
    const write = vi.fn<(records: TemplateRecord[]) => Promise<void>>(async () => undefined)
    const store = new CollaborationTemplateStore({
      scope: 'backend:remote-translation',
      ownerId: 7,
      remote: backend,
      persistence: { read: async () => [old], write },
    })
    const onUse = vi.fn()
    await act(async () =>
      root.render(<CollaborationTemplatePage store={store} locale="en" onUse={onUse} />)
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    await click('template-details-42')
    expect(container.textContent).toContain('Product lifecycle')
    await click('template-use')
    expect(backend.get).toHaveBeenCalledTimes(2)
    expect(onUse.mock.calls[0][0].document.spec.resources.collaboration.project.name).toBe(
      'Product lifecycle collaboration'
    )
    expect(store.getSnapshot().records.find(item => item.id === 42)?.document).toEqual(
      record.document
    )
    expect(write.mock.calls[0][0][0].document).toEqual(record.document)
  } finally {
    vi.useRealTimers()
  }
})

it('changes language without repeating discovery or account metadata requests', async () => {
  vi.useFakeTimers()
  const backend = remote()
  const store = new CollaborationTemplateStore({
    scope: 'backend:locale',
    ownerId: 7,
    remote: backend,
    persistence: { read: async () => [], write: async () => undefined },
  })
  try {
    await act(async () => root.render(<CollaborationTemplatePage store={store} locale="en" />))
    await act(async () => vi.advanceTimersByTimeAsync(200))
    await act(async () => root.render(<CollaborationTemplatePage store={store} locale="zh-CN" />))
    await act(async () => vi.advanceTimersByTimeAsync(200))
    expect(backend.discover).toHaveBeenCalledTimes(1)
    expect(backend.list).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('产品全流程')
  } finally {
    vi.useRealTimers()
  }
})

it('discards pending details when a new store replaces the same library scope', async () => {
  vi.useFakeTimers()
  const first = pendingRemoteDetail()
  const next = new CollaborationTemplateStore({
    scope: first.store.library.scope,
    ownerId: 7,
    remote: remote(),
    persistence: { read: async () => [], write: async () => undefined },
  })
  try {
    await act(async () =>
      root.render(<CollaborationTemplatePage embedded store={first.store} locale="en" />)
    )
    await act(async () => vi.advanceTimersByTimeAsync(200))
    await click('template-details-42')
    await act(async () =>
      root.render(<CollaborationTemplatePage embedded store={next} locale="en" />)
    )
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="template-import-open"]')?.disabled
    ).toBe(false)
    await act(async () => first.resolve(first.record))
    expect(container.querySelector('[data-testid="template-inline-detail"]')).toBeNull()
  } finally {
    vi.useRealTimers()
  }
})
