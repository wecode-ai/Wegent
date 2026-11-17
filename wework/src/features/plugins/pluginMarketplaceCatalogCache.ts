import { compressToUTF16, decompressFromUTF16 } from 'lz-string'
import type { PluginMarketplaceItem } from '@/types/api'

// Installation changes must not recompress the static directory on the UI thread.
const membershipKeys = new Set([
  'installed',
  'installedLocally',
  'installedPluginId',
  'installedVersion',
  'enabled',
  'updateAvailable',
  'currentDeviceInstallation',
])
const defaults = { installed: false, installedPluginId: null, enabled: false }
type Membership = Array<[number, Record<string, unknown>]>
export type CachedCatalog = { marketplaceItems: string; marketplaceState: Membership }
const CHUNK_SIZE = 256
type Chunk = { items: PluginMarketplaceItem[]; encoded: string; jsonBytes: number }
let cached: { chunks: Chunk[]; encoded: string; revision: number } | undefined

function sameDirectory(left: PluginMarketplaceItem[], right: PluginMarketplaceItem[]): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => {
      const previous = right[index]!
      if (item === previous) return true
      const keys = new Set([...Object.keys(item), ...Object.keys(previous)])
      return [...keys].every(
        key =>
          membershipKeys.has(key) ||
          Object.is(Reflect.get(item, key), Reflect.get(previous, key)) ||
          JSON.stringify(Reflect.get(item, key)) === JSON.stringify(Reflect.get(previous, key))
      )
    })
  )
}

export function encodeMarketplaceCatalog(
  items: PluginMarketplaceItem[],
  slim: (item: PluginMarketplaceItem) => PluginMarketplaceItem,
  compact = false
): CachedCatalog & { revision: number } {
  const chunks: Chunk[] = []
  let directoryChanged = !cached || Math.ceil(items.length / CHUNK_SIZE) !== cached.chunks.length
  for (let offset = 0; offset < items.length; offset += CHUNK_SIZE) {
    const entries = items.slice(offset, offset + CHUNK_SIZE)
    const previous = cached?.chunks[offset / CHUNK_SIZE]
    if (previous && sameDirectory(entries, previous.items)) {
      // Retain current immutable records so later membership edits compare by reference.
      previous.items = entries
      chunks.push(previous)
    } else {
      const json = JSON.stringify(
        entries.map(item =>
          Object.fromEntries(Object.entries(slim(item)).filter(([key]) => !membershipKeys.has(key)))
        )
      )
      chunks.push({ items: entries, encoded: `json:${json}`, jsonBytes: json.length })
      directoryChanged = true
    }
  }
  if (compact || chunks.reduce((sum, chunk) => sum + chunk.jsonBytes, 0) > 4_000_000) {
    chunks.forEach((chunk, index) => {
      if (chunk.encoded.startsWith('json:')) {
        chunks[index] = { ...chunk, encoded: `lz:${compressToUTF16(chunk.encoded.slice(5))}` }
      }
    })
  }
  const encodingChanged =
    !cached ||
    chunks.length !== cached.chunks.length ||
    chunks.some((chunk, index) => chunk !== cached!.chunks[index])
  if (encodingChanged) {
    cached = {
      chunks,
      encoded: `chunks:${JSON.stringify(chunks.map(chunk => chunk.encoded))}`,
      revision: (cached?.revision ?? 0) + Number(directoryChanged),
    }
  }
  const marketplaceState: Membership = []
  items.forEach((item, index) => {
    const state = Object.fromEntries(
      [...membershipKeys].flatMap(key => {
        const value = Reflect.get(item, key)
        return value !== undefined && value !== Reflect.get(defaults, key) ? [[key, value]] : []
      })
    )
    if (Object.keys(state).length) marketplaceState.push([index, state])
  })
  return { marketplaceItems: cached!.encoded, marketplaceState, revision: cached!.revision }
}

export function decodeMarketplaceCatalog(value: CachedCatalog): PluginMarketplaceItem[] {
  if (!Array.isArray(value.marketplaceState)) throw new Error('Invalid plugin installation cache')
  if (!value.marketplaceItems.startsWith('chunks:'))
    throw new Error('Invalid plugin directory cache')
  const encoded: unknown = JSON.parse(value.marketplaceItems.slice(7))
  if (!Array.isArray(encoded) || encoded.some(chunk => typeof chunk !== 'string')) {
    throw new Error('Invalid plugin directory cache')
  }
  const states = new Map(value.marketplaceState)
  const restored: PluginMarketplaceItem[] = []
  const chunks: Chunk[] = encoded.map((chunk: string, index) => {
    const json = chunk.startsWith('json:')
      ? chunk.slice(5)
      : chunk.startsWith('lz:')
        ? decompressFromUTF16(chunk.slice(3))
        : null
    if (!json) throw new Error('Invalid plugin directory cache')
    const entries = JSON.parse(json) as PluginMarketplaceItem[]
    if (
      !Array.isArray(entries) ||
      entries.length > CHUNK_SIZE ||
      (index < encoded.length - 1 && entries.length !== CHUNK_SIZE)
    ) {
      throw new Error('Invalid plugin directory cache')
    }
    const items = entries.map((item, offset) => ({
      ...item,
      ...defaults,
      ...states.get(index * CHUNK_SIZE + offset),
    }))
    restored.push(...items)
    return { items, encoded: chunk, jsonBytes: json.length }
  })
  // A cold read already has the encoding; the first install must reuse it.
  cached = {
    chunks,
    encoded: value.marketplaceItems,
    revision:
      cached?.encoded === value.marketplaceItems ? cached.revision : (cached?.revision ?? 0) + 1,
  }
  return restored
}

export function resetMarketplaceCatalogEncoding(): void {
  cached = undefined
}
