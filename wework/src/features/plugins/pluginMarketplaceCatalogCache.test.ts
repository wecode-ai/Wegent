import { beforeEach, expect, test, vi } from 'vitest'
import { compressToUTF16 } from 'lz-string'
import type { PluginMarketplaceItem } from '@/types/api'
import { emptyPluginComponents } from './slimPluginComponents'
import {
  decodeMarketplaceCatalog,
  encodeMarketplaceCatalog,
  resetMarketplaceCatalogEncoding,
} from './pluginMarketplaceCatalogCache'

vi.mock('lz-string', async importOriginal => {
  const original = await importOriginal<{ default: typeof import('lz-string') }>()
  return { ...original.default, compressToUTF16: vi.fn(original.default.compressToUTF16) }
})

const slim = (item: PluginMarketplaceItem) => item
const item = (index: number) =>
  ({
    id: index,
    name: `plugin-${index}`,
    description: `Integration ${index}`,
    installed: false,
    installedPluginId: null,
    enabled: false,
    components: emptyPluginComponents(),
    manifest: { marketplaceId: 'openai-curated-remote' },
  }) as PluginMarketplaceItem

beforeEach(() => {
  resetMarketplaceCatalogEncoding()
  vi.mocked(compressToUTF16).mockClear()
})

test('parallel installation transitions never recompress a 14000-item directory', () => {
  let items = Array.from({ length: 14_000 }, (_, index) => item(index))
  const original = encodeMarketplaceCatalog(items, slim, true)
  const initialCompressions = vi.mocked(compressToUTF16).mock.calls.length
  expect(initialCompressions).toBeGreaterThan(0)
  for (const index of [1, 3, 5]) {
    items = items.map((entry, i) =>
      i === index
        ? ({
            ...entry,
            installed: true,
            installedLocally: true,
            installedPluginId: 100 + i,
            enabled: true,
            installedVersion: '1.0.0',
            updateAvailable: false,
            currentDeviceInstallation: { state: 'installed', actualReleaseId: 42 },
          } as PluginMarketplaceItem)
        : entry
    )
    const updated = encodeMarketplaceCatalog(items, slim, true)
    expect(updated.marketplaceItems).toBe(original.marketplaceItems)
    expect(decodeMarketplaceCatalog(updated)).toEqual(items)
  }
  items = items.map((entry, i) =>
    i === 3
      ? {
          ...entry,
          installed: false,
          installedLocally: false,
          installedPluginId: null,
          enabled: false,
          installedVersion: null,
          updateAvailable: false,
          currentDeviceInstallation: null,
        }
      : entry
  )
  const removed = encodeMarketplaceCatalog(items, slim, true)
  expect(decodeMarketplaceCatalog(removed)).toEqual(items)
  expect(compressToUTF16).toHaveBeenCalledTimes(initialCompressions)
})

test('catalog changes and reordered identities replace the compressed directory', () => {
  const items = [item(1), item(2)]
  const original = encodeMarketplaceCatalog(items, slim, true)
  const changed = [
    { ...items[0]!, components: { ...items[0]!.components, skills: [{ name: 'new' }] } },
    items[1]!,
  ] as PluginMarketplaceItem[]
  const updated = encodeMarketplaceCatalog(changed, slim, true)
  expect(updated.marketplaceItems).not.toBe(original.marketplaceItems)
  expect(decodeMarketplaceCatalog(updated)).toEqual(changed)
  expect(
    decodeMarketplaceCatalog(encodeMarketplaceCatalog([...changed].reverse(), slim, true))
  ).toEqual([...changed].reverse())
  expect(compressToUTF16).toHaveBeenCalledTimes(3)
})

test('semantically identical refreshed metadata reuses compression and applies new membership', () => {
  const items = [item(1)]
  encodeMarketplaceCatalog(items, slim, true)
  const next = structuredClone(items)
  next[0]!.installed = true
  next[0]!.enabled = true
  expect(decodeMarketplaceCatalog(encodeMarketplaceCatalog(next, slim))).toEqual(next)
  expect(compressToUTF16).toHaveBeenCalledTimes(1)
})

test('a cold read primes the directory so its first installation does not compress again', () => {
  const encoded = encodeMarketplaceCatalog([item(1)], slim, true)
  resetMarketplaceCatalogEncoding()
  const restored = decodeMarketplaceCatalog(encoded)
  const next = restored.map(entry => ({ ...entry, installed: true, enabled: true }))
  expect(decodeMarketplaceCatalog(encodeMarketplaceCatalog(next, slim))).toEqual(next)
  expect(compressToUTF16).toHaveBeenCalledTimes(1)
})

test('one changed directory entry does not compress the other 13999 entries', () => {
  const items = Array.from({ length: 14_000 }, (_, index) => item(index))
  encodeMarketplaceCatalog(items, slim, true)
  vi.mocked(compressToUTF16).mockClear()
  const next = items.map((entry, index) =>
    index === 50 ? { ...entry, description: 'Updated metadata' } : entry
  )
  const encoded = encodeMarketplaceCatalog(next, slim, true)
  expect(decodeMarketplaceCatalog(encoded)).toEqual(next)
  expect(compressToUTF16).toHaveBeenCalledTimes(1)
  expect(vi.mocked(compressToUTF16).mock.calls[0]![0].length).toBeLessThan(200_000)
})
