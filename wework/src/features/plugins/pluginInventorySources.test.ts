import { describe, expect, test } from 'vitest'
import { toInstalledPlugin } from '@wegent/chat-core/codex-installed-plugins'
import type { InstalledPlugin } from '@/types/api'
import {
  indexLocalPluginSources,
  inventoryIdentity,
  resolveLocalPluginInventory,
  type LocalInstalledSources,
  type LocalPluginSourceItems,
} from './pluginInventorySources'

function plugin(name: string, marketplace = 'custom'): InstalledPlugin {
  return toInstalledPlugin(
    { name: marketplace, path: `/plugins/${marketplace}`, plugins: [] },
    { name, id: `${name}@${marketplace}`, installed: true, enabled: true },
    null,
    key => key
  )
}

function storePlugin(name: string): InstalledPlugin {
  const native = plugin(name, 'wegent')
  return {
    ...native,
    metadata: { ...native.metadata, labels: { id: `62-wegent-${name}-1.0.0` } },
    spec: {
      ...native.spec,
      sourcePayload: {
        ...native.spec.sourcePayload,
        pluginId: `62-wegent-${name}-1.0.0`,
        managedByWegent: true,
        cloudPluginId: 42,
        cloudInstalledPluginId: 62,
      },
    },
  }
}

function snapshot(
  installedPlugins: InstalledPlugin[],
  localInstalledSources?: LocalInstalledSources,
  deviceId = 'device'
) {
  return { installedPlugins, localInstalledSources, deviceId }
}

const rejected = { status: 'rejected' as const }
const fulfilled = (items: InstalledPlugin[]) => ({ status: 'fulfilled' as const, items })

describe('source-owned local plugin inventory', () => {
  test('keeps an unread failed source incomplete until that source actually recovers', () => {
    const native = plugin('tool')
    const previous = {
      ...snapshot([native], { codex: [inventoryIdentity(native)], personal: [] }),
      localInstalledSourceStatus: { codex: 'rejected' as const, personal: 'rejected' as const },
    }
    const disk = resolveLocalPluginInventory(
      previous,
      { items: [], sourceReads: { store: fulfilled([]), personal: fulfilled([]) } },
      'device'
    )
    expect(disk.localInstalledSourceStatus.codex).toBe('rejected')
    const recovered = resolveLocalPluginInventory(
      { ...previous, ...disk },
      { items: [native], sourceReads: { codex: fulfilled([native]), store: fulfilled([]) } },
      'device'
    )
    expect(recovered.localInstalledSourceStatus).toEqual({ codex: 'fulfilled', store: 'fulfilled' })
    expect(recovered.localInstalledSources).not.toHaveProperty('personal')
  })

  test('keeps explicit cloud identities separate even when normalized marketplace names match', () => {
    const stored = storePlugin('tool')
    const official = {
      ...plugin('tool', 'wework'),
      spec: { ...plugin('tool', 'wework').spec, pluginId: 42 },
    }
    const enterprise = {
      ...plugin('tool', 'wegent'),
      spec: { ...plugin('tool', 'wegent').spec, pluginId: 43 },
    }
    expect(indexLocalPluginSources([official, enterprise], { store: [stored] }, 'device')).toEqual({
      store: ['cloud:42'],
    })
    expect(
      indexLocalPluginSources([official, enterprise], { codex: [enterprise] }, 'device')
    ).toEqual({ codex: ['cloud:43'] })
  })

  test('keeps failed Codex membership while replacing a successful store source', () => {
    const codex = plugin('codex-tool')
    const stored = storePlugin('stored-tool')
    const updated = { ...stored, spec: { ...stored.spec, version: '2.0.0' } }
    const previous = snapshot([codex, stored], {
      codex: [inventoryIdentity(codex)],
      store: [inventoryIdentity(stored)],
    })
    const resolved = resolveLocalPluginInventory(
      JSON.parse(JSON.stringify(previous)),
      {
        items: [updated],
        partial: true,
        sourceReads: { codex: rejected, store: fulfilled([updated]) },
      },
      'device'
    )
    expect(resolved.items).toEqual([codex, updated])
    expect(resolved.localInstalledSources).toEqual(previous.localInstalledSources)
    expect(resolved.localInstalledSourceStatus).toEqual({ codex: 'rejected', store: 'fulfilled' })
  })

  test.each(['codex', 'store'] as const)(
    'a successful empty %s clears only that source across the next failed refresh',
    successful => {
      const codex = plugin('codex-tool')
      const stored = storePlugin('stored-tool')
      const previous = snapshot([codex, stored], {
        codex: [inventoryIdentity(codex)],
        store: [inventoryIdentity(stored)],
      })
      const resolved = resolveLocalPluginInventory(
        previous,
        {
          items: [],
          partial: true,
          sourceReads: {
            codex: successful === 'codex' ? fulfilled([]) : rejected,
            store: successful === 'store' ? fulfilled([]) : rejected,
          },
        },
        'device'
      )
      expect(resolved.items).toEqual(successful === 'codex' ? [stored] : [codex])
      expect(resolved.localInstalledSources[successful]).toEqual([])
      const restarted = resolveLocalPluginInventory(
        JSON.parse(JSON.stringify(snapshot(resolved.items, resolved.localInstalledSources))),
        { items: [], partial: true, sourceReads: { codex: rejected, store: rejected } },
        'device'
      )
      expect(restarted.items).toEqual(resolved.items)
    }
  )

  test.each(['other-device', ''])(
    'never imports failed-source records from the previous %s scope',
    previousDevice => {
      const old = plugin('old-account-tool')
      const current = storePlugin('current-tool')
      const resolved = resolveLocalPluginInventory(
        snapshot([old], { codex: [inventoryIdentity(old)] }, previousDevice),
        {
          items: [current],
          partial: true,
          sourceReads: { codex: rejected, store: fulfilled([current]) },
        },
        'device'
      )
      expect(resolved.items).toEqual([current])
      expect(resolved.localInstalledSources.codex).toBeUndefined()
    }
  )

  test('rejects a live result belonging to a different device', () => {
    expect(() =>
      resolveLocalPluginInventory(
        null,
        { items: [], deviceId: 'old-device', sourceReads: { codex: fulfilled([]) } },
        'device'
      )
    ).toThrow('Local plugin device changed')
  })

  test('ignores fallback items carried on rejected source results', () => {
    const old = plugin('confirmed-old')
    const foreign = plugin('late-session-fallback')
    const resolved = resolveLocalPluginInventory(
      snapshot([old], { codex: [inventoryIdentity(old)] }),
      {
        items: [foreign],
        partial: true,
        sourceReads: { codex: { ...rejected, items: [foreign] } },
      },
      'device'
    )
    expect(resolved.items).toEqual([old])
  })

  test('retains overlapping Codex and store ownership until both sources establish absence', () => {
    const codex = plugin('tool', 'wegent')
    const stored = storePlugin('tool')
    const first = resolveLocalPluginInventory(
      null,
      { items: [], sourceReads: { codex: fulfilled([codex]), store: fulfilled([stored]) } },
      'device'
    )
    expect(first.items).toHaveLength(1)
    expect(first.localInstalledSources).toEqual({
      codex: [inventoryIdentity(codex)],
      store: [inventoryIdentity(codex)],
    })
    const retained = resolveLocalPluginInventory(
      snapshot(first.items, first.localInstalledSources),
      { items: [], partial: true, sourceReads: { codex: fulfilled([]), store: rejected } },
      'device'
    )
    expect(retained.items).toEqual(first.items)
    expect(retained.localInstalledSources.codex).toEqual([])
    expect(retained.localInstalledSources.store).toEqual([inventoryIdentity(codex)])
    const removed = resolveLocalPluginInventory(
      snapshot(retained.items, retained.localInstalledSources),
      { items: [], sourceReads: { codex: fulfilled([]), store: fulfilled([]) } },
      'device'
    )
    expect(removed.items).toEqual([])
    expect(removed.localInstalledSources).toEqual({ codex: [], store: [] })
  })

  test('maps raw store and Codex IDs onto their final cloud record', () => {
    const stored = storePlugin('tool')
    const codex = {
      ...plugin('tool', 'wegent'),
      spec: { ...plugin('tool', 'wegent').spec, sourcePayload: stored.spec.sourcePayload },
    }
    const cloud = {
      ...plugin('tool', 'wegent'),
      metadata: { ...stored.metadata, labels: { id: '62' } },
      spec: { ...stored.spec, pluginId: 42, releaseId: 7 },
    }
    expect(indexLocalPluginSources([cloud], { codex: [codex], store: [stored] }, 'device')).toEqual(
      {
        codex: ['cloud:42'],
        store: ['cloud:42'],
      }
    )
    expect(indexLocalPluginSources([cloud], { store: [stored] }, '')).toEqual({})
  })

  test.each(['left', 'wegent'])(
    'does not apply cloud matching to equal native plugin names in %s and another marketplace',
    marketplace => {
      const left = plugin('tool', marketplace)
      const right = plugin('tool', 'right')
      expect(indexLocalPluginSources([left, right], { codex: [left] }, 'device')).toEqual({
        codex: [inventoryIdentity(left)],
      })
    }
  )

  test('personal success empties only the Codex personal subset', () => {
    const other = plugin('other-tool')
    const personal = plugin('my-tool', 'wework-personal')
    const resolved = resolveLocalPluginInventory(
      snapshot([other, personal], {
        codex: [inventoryIdentity(other), inventoryIdentity(personal)],
      }),
      { items: [], partial: true, sourceReads: { codex: rejected, personal: fulfilled([]) } },
      'device'
    )
    expect(resolved.items).toEqual([other])
    expect(resolved.localInstalledSources).toEqual({
      codex: [inventoryIdentity(other)],
      personal: [],
    })
  })

  test('fresh Codex membership supersedes an old successful empty personal override', () => {
    const personal = plugin('new-personal', 'wework-personal')
    const resolved = resolveLocalPluginInventory(
      snapshot([], { codex: [], personal: [] }),
      { items: [personal], sourceReads: { codex: fulfilled([personal]), store: fulfilled([]) } },
      'device'
    )
    expect(resolved.items).toEqual([personal])
    expect(resolved.localInstalledSources).toEqual({
      codex: [inventoryIdentity(personal)],
      store: [],
    })
  })

  test('reconstructs legacy ownership from explicit native and managed routing metadata', () => {
    const native = plugin('native-tool')
    const stored = storePlugin('stored-tool')
    const cloudOnly = { ...stored, spec: { ...stored.spec, pluginId: 99, sourcePayload: {} } }
    const resolved = resolveLocalPluginInventory(
      snapshot([native, stored, cloudOnly]),
      { items: [], partial: true, sourceReads: { codex: rejected, store: rejected } },
      'device'
    )
    expect(resolved.items).toEqual([native, stored])
    expect(resolved.localInstalledSources).toEqual({
      codex: [inventoryIdentity(native)],
      store: [inventoryIdentity(stored)],
      personal: [],
    })
  })

  test('missing source records cannot be manufactured from a persisted identity alone', () => {
    expect(
      resolveLocalPluginInventory(
        snapshot([], { codex: ['custom:removed'] }),
        { items: [], partial: true, sourceReads: { codex: rejected } },
        'device'
      ).items
    ).toEqual([])
  })

  test('a complete fresh local list retains cloud-projected rows without inferring previous cloud-only records', () => {
    const native = plugin('cloud-projected-tool')
    const projected = { ...native, spec: { ...native.spec, pluginId: 99, sourcePayload: {} } }
    const resolved = resolveLocalPluginInventory(null, { items: [projected] }, 'device')
    expect(resolved.items).toEqual([projected])
    expect(resolved.localInstalledSources.codex).toEqual(['cloud:99'])
    expect(
      resolveLocalPluginInventory(
        snapshot([projected]),
        { items: [], partial: true, sourceReads: { codex: rejected } },
        'device'
      ).items
    ).toEqual([])
  })

  test('rejects ambiguous partial lists and malformed successful source results', () => {
    expect(() => resolveLocalPluginInventory(null, { items: [], partial: true }, 'device')).toThrow(
      'requires source read results'
    )
    expect(() =>
      resolveLocalPluginInventory(
        null,
        { items: [], sourceReads: { codex: { status: 'fulfilled' } } },
        'device'
      )
    ).toThrow('Invalid codex plugin source')
  })

  test('accepts a complete flat read as a replacement, rather than retaining old membership', () => {
    const old = plugin('old-tool')
    const sourceItems: LocalPluginSourceItems = { codex: [old] }
    const resolved = resolveLocalPluginInventory(
      snapshot([old], indexLocalPluginSources([old], sourceItems, 'device')),
      { items: [] },
      'device'
    )
    expect(resolved.items).toEqual([])
    expect(resolved.localInstalledSourceStatus).toEqual({
      codex: 'fulfilled',
      store: 'fulfilled',
      personal: 'fulfilled',
    })
  })
})
