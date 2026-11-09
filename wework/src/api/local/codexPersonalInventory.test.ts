import { describe, expect, test } from 'vitest'
import { personalInstalledFromDisk, withPersonalInventoryDetails } from './codexPersonalInventory'

describe('personal disk membership and runtime detail enrichment', () => {
  const source = {
    marketplaceId: 'wework-personal',
    marketplacePath: '/personal',
    plugins: [{ name: 'tool', pluginPath: '/personal/plugins/tool', version: '2.0.0' }],
  }

  test.each([undefined, 9])(
    'runtime details cannot overwrite current disk preferences or cloud link %s',
    cloudPluginId => {
      const [disk] = personalInstalledFromDisk(
        source,
        { enabledPluginKeys: [], disabledPluginKeys: ['tool@wework-personal'] },
        []
      )
      disk.spec.sourcePayload =
        cloudPluginId === undefined ? {} : { cloudPluginId, cloudReleaseId: 8 }
      const runtime = {
        ...disk,
        spec: {
          ...disk.spec,
          enabled: true,
          version: '1.0.0',
          sourcePayload: { cloudPluginId: 42, cloudReleaseId: 1 },
          components: {
            ...disk.spec.components,
            skills: [{ name: 'runtime-skill', description: 'Runtime detail' }],
          },
        },
      }
      const [merged] = withPersonalInventoryDetails([disk], [runtime])
      expect(merged.spec.enabled).toBe(false)
      expect(merged.status.state).toBe('disabled')
      expect(merged.spec.version).toBe('2.0.0')
      expect(merged.spec.sourcePayload?.cloudPluginId).toBe(cloudPluginId)
      expect(merged.spec.components.skills.map(skill => skill.name)).toEqual(['runtime-skill'])
    }
  )

  test('a runtime member cannot restore a package absent from the owned directory or configuration', () => {
    const runtime = personalInstalledFromDisk(
      source,
      { enabledPluginKeys: ['tool@wework-personal'] },
      []
    )
    for (const items of [
      personalInstalledFromDisk(
        { ...source, plugins: [] },
        { enabledPluginKeys: ['tool@wework-personal'] },
        runtime
      ),
      personalInstalledFromDisk(source, { enabledPluginKeys: [], disabledPluginKeys: [] }, runtime),
    ]) {
      expect(withPersonalInventoryDetails(items, runtime)).toEqual([])
    }
  })
})
