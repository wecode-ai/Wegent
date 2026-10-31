import { satisfies } from 'semver'
import type { createPluginApi } from './plugins'
import type { ConnectionProviderDescriptor } from './standIn'

export type ConnectionDependencyPluginApi = Pick<
  ReturnType<typeof createPluginApi>,
  'listMarketplacePlugins' | 'installMarketplacePlugin'
>

function failure(code: string): Error {
  return Object.assign(new Error(code), { code })
}

// Match the backend's plugin_marketplace_identity.py, without UI alias normalization.
function marketplaceForVisibility(visibility: string): string | undefined {
  const marketplaces: Record<string, string> = {
    public: 'wework',
    workspace: 'wegent',
    personal: 'wework-personal',
  }
  return marketplaces[visibility]
}

export async function installStandInConnectionDependencies(options: {
  providerId: string
  aliases: string[]
  deviceId: string
  catalog(): Promise<{ items: ConnectionProviderDescriptor[] }>
  installNative(aliases: string[]): Promise<unknown>
  plugins?: ConnectionDependencyPluginApi
}): Promise<unknown> {
  const { providerId, aliases, deviceId, plugins } = options
  const provider = (await options.catalog()).items.find(item => item.id === providerId)
  if (!provider) throw failure('connection_unavailable')
  if (aliases.some(alias => !provider.dependencies.some(item => item.alias === alias))) {
    throw failure('invalid_dependency')
  }
  const selected = provider.dependencies.filter(item => aliases.includes(item.alias))
  const cloud = selected.filter(item =>
    ['wegent', 'wework'].includes(item.source?.marketplaceId ?? '')
  )
  const missing = cloud.filter(item => item.status !== 'ready')
  if (missing.some(item => item.status !== 'missing')) throw failure('dependency_conflict')
  if (missing.length) {
    if (!plugins) throw failure('dependency_cloud_required')
    const catalog = await plugins.listMarketplacePlugins({ deviceId, source: 'wegent' })
    // The server-owned sourceProvider identifies the official cloud source. A
    // community listing or another Codex marketplace must never satisfy it.
    const targets = missing.map(dependency => {
      const matches = catalog.items.filter(
        item =>
          item.sourceProvider === 'wegent' &&
          marketplaceForVisibility(item.visibility) === dependency.source?.marketplaceId &&
          `${item.name}@${marketplaceForVisibility(item.visibility)}` ===
            dependency.source?.pluginId
      )
      if (matches.length !== 1) throw failure('dependency_catalog_unavailable')
      const target = matches[0]
      if (
        dependency.version &&
        dependency.version !== '*' &&
        (!target.version || !satisfies(target.version, dependency.version))
      ) {
        throw failure('dependency_conflict')
      }
      if (target.installed && !target.enabled) throw failure('dependency_conflict')
      return target
    })
    // Validate the whole plan before changing any installation.
    for (const target of targets) await plugins.installMarketplacePlugin(target.id, deviceId)
    const refreshed = (await options.catalog()).items.find(item => item.id === providerId)
    if (
      cloud.some(
        dependency =>
          !refreshed?.dependencies.some(
            item =>
              item.alias === dependency.alias &&
              item.status === 'ready' &&
              item.source?.marketplaceId === dependency.source?.marketplaceId &&
              item.source?.pluginId === dependency.source?.pluginId
          )
      )
    )
      throw failure('dependency_not_ready')
  }
  const native = selected.filter(item => !cloud.includes(item)).map(item => item.alias)
  return native.length ? options.installNative(native) : { success: true }
}
