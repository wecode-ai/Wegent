import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import type { InstalledPlugin } from '@/types/api'
import type { InstalledPluginItem } from '../PluginManagementRows'
import { toMarketplaceInstalledPluginItem } from '../workspace/marketplaceWorkspaceHelpers'
import { useMarketplacePluginDetail } from './useMarketplacePluginDetail'

function base(name: string) {
  return toMarketplaceInstalledPluginItem({
    id: name,
    name,
    displayName: name,
    description: 'summary',
    installed: false,
    visibility: 'public',
    sourceType: 'marketplace',
    ownerUserId: 0,
    featured: false,
    enabled: false,
    components: {
      skills: [],
      commands: [],
      agents: [],
      hooks: [],
      mcps: [],
      lsps: [],
      monitors: [],
      bins: [],
    },
  })
}
function deferred() {
  let resolve!: (value: InstalledPlugin) => void
  const promise = new Promise<InstalledPlugin>(done => {
    resolve = done
  })
  return { promise, resolve }
}

test('publishes complete detail atomically while installation settings stay authoritative', async () => {
  const held = deferred()
  const initial = base('A')
  const read = vi.fn(() => held.promise)
  const { result, rerender } = renderHook(
    ({ plugin }: { plugin: InstalledPluginItem }) =>
      useMarketplacePluginDetail({
        selectionKey: 'A',
        revision: 0,
        base: plugin,
        read,
        errorMessage: 'failed',
      }),
    { initialProps: { plugin: initial } }
  )
  expect(result.current.loading).toBe(true)
  await act(async () =>
    held.resolve({ ...initial.raw, spec: { ...initial.raw.spec, description: 'full' } })
  )
  expect(result.current.loading).toBe(false)
  expect(result.current.detail?.raw.spec.description).toBe('full')
  const resolved = result.current.detail
  rerender({ plugin: initial })
  expect(result.current.detail).toBe(resolved)
  rerender({
    plugin: { ...initial, raw: { ...initial.raw, spec: { ...initial.raw.spec, enabled: true } } },
  })
  expect(result.current.detail?.raw.spec.enabled).toBe(true)
  expect(read).toHaveBeenCalledOnce()
})

test('changing selection or account never paints an older response', async () => {
  const old = deferred()
  const fresh = deferred()
  const first = base('A')
  const second = base('B')
  const { result, rerender } = renderHook(
    ({ key, plugin, read }) =>
      useMarketplacePluginDetail({
        selectionKey: key,
        revision: 0,
        base: plugin,
        read,
        errorMessage: 'failed',
      }),
    { initialProps: { key: 'account-a/A', plugin: first, read: () => old.promise } }
  )
  rerender({ key: 'account-b/B', plugin: second, read: () => fresh.promise })
  await act(async () => old.resolve(first.raw))
  expect(result.current.loading).toBe(true)
  expect(result.current.detail?.name).toBe('B')
  await act(async () => fresh.resolve(second.raw))
  expect(result.current.loading).toBe(false)
})

test('a failed read stops loading and a retry revision recovers', async () => {
  const plugin = base('A')
  const read = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(plugin.raw)
  const { result, rerender } = renderHook(
    ({ revision }) =>
      useMarketplacePluginDetail({
        selectionKey: 'A',
        revision,
        base: plugin,
        read,
        errorMessage: 'failed',
      }),
    { initialProps: { revision: 0 } }
  )
  await waitFor(() => expect(result.current.error).toBe('failed'))
  expect(result.current.loading).toBe(false)
  rerender({ revision: 1 })
  await waitFor(() => expect(result.current.loading).toBe(false))
  expect(result.current.error).toBeNull()
})

test('a confirmed inventory mutation refreshes completed detail without a version change', async () => {
  const plugin = base('A')
  const fresh = deferred()
  const read = vi.fn().mockResolvedValueOnce(plugin.raw).mockReturnValueOnce(fresh.promise)
  const { result, rerender } = renderHook(
    ({ mutation }) =>
      useMarketplacePluginDetail({
        selectionKey: JSON.stringify(['account/A', mutation]),
        revision: 0,
        base: plugin,
        read,
        errorMessage: 'failed',
      }),
    { initialProps: { mutation: 0 } }
  )
  await waitFor(() => expect(result.current.loading).toBe(false))
  rerender({ mutation: 0 })
  expect(read).toHaveBeenCalledOnce()
  rerender({ mutation: 1 })
  expect(result.current.loading).toBe(true)
  await act(async () =>
    fresh.resolve({
      ...plugin.raw,
      spec: { ...plugin.raw.spec, description: 'same-version replacement' },
    })
  )
  expect(result.current.detail?.raw.spec.description).toBe('same-version replacement')
  expect(read).toHaveBeenCalledTimes(2)
})

test('returning to a selection waits for its new read instead of painting a previous visit', async () => {
  const first = base('A')
  const second = base('B')
  const held = deferred()
  const { result, rerender } = renderHook(
    ({ key, plugin, read }) =>
      useMarketplacePluginDetail({
        selectionKey: key,
        revision: 0,
        base: plugin,
        read,
        errorMessage: 'failed',
      }),
    {
      initialProps: {
        key: 'account-a/A',
        plugin: first,
        read: () =>
          Promise.resolve({ ...first.raw, spec: { ...first.raw.spec, description: 'old A' } }),
      },
    }
  )
  await waitFor(() => expect(result.current.loading).toBe(false))
  expect(result.current.detail?.raw.spec.description).toBe('old A')
  rerender({ key: 'account-b/B', plugin: second, read: () => new Promise(() => {}) })
  rerender({ key: 'account-a/A', plugin: first, read: () => held.promise })
  expect(result.current.loading).toBe(true)
  expect(result.current.detail?.raw.spec.description).toBe('summary')
  await act(async () => held.resolve(first.raw))
  expect(result.current.loading).toBe(false)
})
