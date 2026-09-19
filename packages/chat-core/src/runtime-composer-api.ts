import type { InstalledPlugin } from './installed-plugin-types'
import type { RuntimeTaskAddress } from './runtime'
import { decodeRuntimeComposerSnapshot } from './runtime-composer-snapshot'
import type { LocalDeviceSkill } from './runtime-composer-catalog'
import type { CloudRuntimeIpcClient } from './runtime-ipc'
import type { RuntimeWorkspaceSearchResponse } from './runtime-workspace-search'

export function decodeRuntimeSkills(stdout: unknown): LocalDeviceSkill[] {
  const data: unknown = typeof stdout === 'string' ? JSON.parse(stdout) : stdout
  if (!Array.isArray(data)) throw new Error('Invalid runtime skill catalog')
  const skills = new Map<string, LocalDeviceSkill>()
  for (const item of data) {
    if (
      !item ||
      typeof item !== 'object' ||
      typeof item.name !== 'string' ||
      typeof item.path !== 'string'
    )
      throw new Error('Invalid runtime skill catalog entry')
    const skill = item as LocalDeviceSkill
    const key = skill.name.trim().toLowerCase()
    if (!key) continue
    const previous = skills.get(key)
    const rank = skill.source_priority ?? 99
    const previousRank = previous?.source_priority ?? 99
    if (
      !previous ||
      rank < previousRank ||
      (rank === previousRank && (skill.mtime ?? 0) > (previous.mtime ?? 0))
    )
      skills.set(key, skill)
  }
  return [...skills.values()].sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
  )
}

export function createRuntimeComposerApi(
  ipc: Pick<CloudRuntimeIpcClient, 'request'>,
  listCloudInstalledPlugins: (deviceId: string) => Promise<InstalledPlugin[]>
) {
  return {
    readCatalog: async (address: RuntimeTaskAddress, forceRefresh = false) => {
      if (!address.deviceId.trim() || !address.taskId.trim())
        throw new Error('Composer device and task are required')
      const [response, installed] = await Promise.all([
        ipc.request<unknown>(
          'runtime.composer.catalog.read',
          { taskId: address.taskId, forceRefresh },
          address.deviceId
        ),
        listCloudInstalledPlugins(address.deviceId),
      ])
      return decodeRuntimeComposerSnapshot(address, response, installed)
    },
    searchWorkspaceEntries: (
      deviceId: string,
      root: string,
      query: string,
      cancellationToken?: string
    ) =>
      ipc.request<RuntimeWorkspaceSearchResponse>(
        'runtime.workspace.search',
        { deviceId, root, query, cancellationToken },
        deviceId
      ),
  }
}
