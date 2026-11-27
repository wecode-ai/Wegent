import { act, cleanup, renderHook } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import type { PluginMarketplaceItem } from '@/types/api'
import { mergeMarketplaceCatalog } from '../marketplaceCatalogMerge'
import { usePluginDetailSelection } from './usePluginDetailSelection'

vi.mock('@/api/local/codexPlugins', () => ({
  applyInstalledPluginsToMarketplaceItems: (items: PluginMarketplaceItem[]) => items,
}))
vi.mock('@/desktop/localExecutor', () => ({ getInitializedBundledPluginMarketplace: () => null }))
vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }))

afterEach(cleanup)

const name = 'author-install-private-e2e'
const local = {
  id: `${name}@wework-personal`,
  name,
  version: '1.2.0',
  visibility: 'personal',
  latestReleaseId: null,
  manifest: { marketplaceId: 'wework-personal', marketplacePath: '/author/wework-personal' },
} as PluginMarketplaceItem
const cloud = {
  id: 2,
  name,
  version: '1.2.0',
  visibility: 'personal',
  accessRole: 'owner',
  latestReleaseId: 2,
  installed: true,
  manifest: { name },
} as PluginMarketplaceItem
const [linked] = mergeMarketplaceCatalog([cloud], [local], [])

function selectionFixture() {
  return renderHook(
    ({ items, scopeKey }: { items: PluginMarketplaceItem[]; scopeKey: string }) => {
      const [selectedPluginId, setSelectedPluginId] = useState<string | number | null>(null)
      const [selectedMarketplacePluginId, setSelectedMarketplacePluginId] = useState<
        string | number | null
      >(local.id)
      return {
        ...usePluginDetailSelection({
          scopeKey,
          pluginReference: null,
          pluginMarketplaceState: { items, isLoading: false, error: null },
          installedPlugins: [],
          selectedPluginId,
          selectedMarketplacePluginId,
          setSelectedPluginId,
          setSelectedMarketplacePluginId,
        }),
        select: setSelectedMarketplacePluginId,
      }
    },
    { initialProps: { items: [local], scopeKey: 'author:device' } }
  )
}

test('keeps the installed author detail selected after cloud publication precedes the local source join', () => {
  const view = selectionFixture()
  expect(view.result.current.selectedMarketplacePlugin).toBe(local)

  // The cloud read can replace the local row before disk-source metadata is joined.
  view.rerender({ items: [cloud], scopeKey: 'author:device' })
  expect(view.result.current.selectedMarketplacePlugin).toBeNull()
  view.rerender({ items: [linked], scopeKey: 'author:device' })
  expect(view.result.current.selectedMarketplacePlugin).toBe(linked)
})

test('recovers the author detail after an empty intermediate inventory', () => {
  const view = selectionFixture()
  view.rerender({ items: [], scopeKey: 'author:device' })
  expect(view.result.current.selectedMarketplacePlugin).toBeNull()
  view.rerender({ items: [linked], scopeKey: 'author:device' })
  expect(view.result.current.selectedMarketplacePlugin).toBe(linked)
})

test('keeps the same author source selected when the joined catalog arrives directly', () => {
  const view = selectionFixture()
  view.rerender({ items: [linked], scopeKey: 'author:device' })
  expect(view.result.current.selectedMarketplacePlugin).toBe(linked)
})

test.each(['recipient:device', 'author:other-device'])(
  'does not carry the source selection into another scope %s',
  scopeKey => {
    const view = selectionFixture()
    view.rerender({ items: [cloud], scopeKey: 'author:device' })
    view.rerender({ items: [linked], scopeKey })
    expect(view.result.current.selectedMarketplacePlugin).toBeNull()
  }
)

test('does not reopen a detail the user dismissed while publication was pending', () => {
  const view = selectionFixture()
  view.rerender({ items: [cloud], scopeKey: 'author:device' })
  act(() => view.result.current.dismissPluginReferenceDetail())
  view.rerender({ items: [linked], scopeKey: 'author:device' })
  expect(view.result.current.selectedMarketplacePlugin).toBeNull()
})

test('does not select another plugin after the user changes selection', () => {
  const view = selectionFixture()
  view.rerender({ items: [cloud], scopeKey: 'author:device' })
  act(() => view.result.current.select(99))
  view.rerender({ items: [linked], scopeKey: 'author:device' })
  expect(view.result.current.selectedMarketplacePlugin).toBeNull()
})

test('requires a unique linked owner source and rejects recipients with the same name', () => {
  const view = selectionFixture()
  view.rerender({ items: [cloud], scopeKey: 'author:device' })
  view.rerender({
    items: [{ ...linked, accessRole: 'recipient' }],
    scopeKey: 'author:device',
  })
  expect(view.result.current.selectedMarketplacePlugin).toBeNull()
  view.rerender({ items: [linked, { ...linked, id: 3 }], scopeKey: 'author:device' })
  expect(view.result.current.selectedMarketplacePlugin).toBeNull()
  view.rerender({ items: [linked], scopeKey: 'author:device' })
  expect(view.result.current.selectedMarketplacePlugin).toBe(linked)
})
