import { renderHook } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import type { PluginMarketplaceItem } from '@/types/api'
import { usePluginDetailSelection } from './usePluginDetailSelection'

function item(id: string, marketplace = 'wework-personal', release: number | null = null) {
  return {
    id,
    name: 'documents',
    latestReleaseId: release,
    manifest: { marketplaceId: marketplace },
  } as PluginMarketplaceItem
}

function selection(items: PluginMarketplaceItem[], scopeKey = 'account-a:device') {
  return {
    scopeKey,
    pluginReference: null,
    pluginMarketplaceState: { items, isLoading: false, error: null },
    installedPlugins: [],
    selectedPluginId: null,
    selectedMarketplacePluginId: 'personal-disk:documents',
    setSelectedPluginId: vi.fn(),
    setSelectedMarketplacePluginId: vi.fn(),
  }
}

test('keeps the selected local resource when the native catalog replaces its disk row ID', () => {
  const disk = item('personal-disk:documents')
  const native = item('documents-local-id')
  const { result, rerender } = renderHook(usePluginDetailSelection, {
    initialProps: selection([disk]),
  })
  expect(result.current.selectedMarketplacePlugin).toBe(disk)
  rerender(selection([native]))
  expect(result.current.selectedMarketplacePlugin).toBe(native)
})

test.each([
  [item('other-market-id', 'another-market')],
  [item('cloud-id', 'wework-personal', 42)],
  [item('duplicate-a'), item('duplicate-b')],
  [],
])('rejects other markets, cloud identities, ambiguous rows and removals: %j', (...items) => {
  const { result, rerender } = renderHook(usePluginDetailSelection, {
    initialProps: selection([item('personal-disk:documents')]),
  })
  rerender(selection(items))
  expect(result.current.selectedMarketplacePlugin).toBeNull()
})

test.each(['account-b:device', 'account-a:other-device'])(
  'does not revive a prior local selection after changing scope and back: %s',
  scopeKey => {
    const { result, rerender } = renderHook(usePluginDetailSelection, {
      initialProps: selection([item('personal-disk:documents')]),
    })
    rerender(selection([], scopeKey))
    rerender(selection([item('documents-local-id')]))
    expect(result.current.selectedMarketplacePlugin).toBeNull()
  }
)

test('does not resolve a cloud selection through a same-name local resource', () => {
  const { result, rerender } = renderHook(usePluginDetailSelection, {
    initialProps: selection([item('personal-disk:documents', 'wework-personal', 42)]),
  })
  rerender(selection([item('documents-local-id')]))
  expect(result.current.selectedMarketplacePlugin).toBeNull()
})
