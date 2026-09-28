import type { RuntimeTaskAddress } from './runtime'
import type { LocalDeviceApp, LocalDeviceSkill } from './runtime-composer-catalog'
import type {
  CodexPluginMarketplaceEntry,
  CodexPluginSummary,
  WegentStoreListResult,
} from './codex-plugin-types'
import type { InstalledPlugin, PluginInterface } from './installed-plugin-types'
import {
  catalogArray,
  catalogRecord,
  catalogString,
  decodeCodexComposerApps,
  decodeCodexComposerSkills,
} from './codex-composer-catalog'

export interface RuntimeComposerCatalogSnapshot {
  taskId: string
  workspacePath: string
  projectPluginIds: string[]
  apps: LocalDeviceApp[]
  skills: LocalDeviceSkill[]
  marketplaces: CodexPluginMarketplaceEntry[]
  store: WegentStoreListResult
  cloudInstalledPlugins: InstalledPlugin[]
}
function text(value: unknown): string | null {
  if (value == null) return null
  if (typeof value !== 'string') throw new Error('Invalid plugin catalog text')
  return value
}
function enabled(value: unknown): boolean {
  if (value == null) return true
  if (typeof value !== 'boolean') throw new Error('Invalid plugin catalog enabled state')
  return value
}
function pluginInterface(value: unknown): PluginInterface | null {
  if (value == null) return null
  const record = catalogRecord(value)
  for (const key of [
    'displayName',
    'shortDescription',
    'longDescription',
    'developerName',
    'category',
    'websiteUrl',
    'privacyPolicyUrl',
    'termsOfServiceUrl',
    'brandColor',
    'composerIcon',
    'logo',
    'logoDark',
    'logoUrl',
    'logoUrlDark',
    'composerIconUrl',
  ])
    text(record[key])
  for (const key of ['capabilities', 'screenshots', 'screenshotUrls']) {
    if (record[key] != null) catalogArray(record[key]).forEach(catalogString)
  }
  return { ...record, defaultPrompt: prompts(record.defaultPrompt) } as PluginInterface
}
function prompts(value: unknown): string[] | null {
  if (value == null) return null
  return typeof value === 'string' ? [value] : catalogArray(value).map(catalogString)
}
function summary(value: unknown): CodexPluginSummary {
  const plugin = catalogRecord(value)
  return {
    ...plugin,
    name: catalogString(plugin.name),
    id: text(plugin.id) || catalogString(plugin.name),
    remotePluginId: text(plugin.remotePluginId),
    localVersion: text(plugin.localVersion),
    source: plugin.source == null ? undefined : catalogRecord(plugin.source),
    enabled: enabled(plugin.enabled),
    installed: true,
    interface: pluginInterface(plugin.interface),
  }
}

/** An addressed snapshot retains all membership/authorization data for catalog merging. */
export function decodeRuntimeComposerSnapshot(
  address: Pick<RuntimeTaskAddress, 'taskId'>,
  value: unknown,
  cloudInstalledPlugins: InstalledPlugin[] = []
): RuntimeComposerCatalogSnapshot {
  const snapshot = catalogRecord(value)
  if (catalogString(snapshot.taskId) !== address.taskId)
    throw new Error('Composer catalog belongs to another task')
  const store = catalogRecord(snapshot.store)
  return {
    taskId: address.taskId,
    workspacePath: catalogString(snapshot.workspacePath),
    projectPluginIds: catalogArray(snapshot.projectPluginIds).map(catalogString),
    apps: decodeCodexComposerApps(snapshot.apps),
    skills: decodeCodexComposerSkills(snapshot.skills),
    marketplaces: catalogArray(snapshot.marketplaces).map(item => {
      const marketplace = catalogRecord(item)
      return {
        name: catalogString(marketplace.name),
        path: text(marketplace.path),
        interface:
          marketplace.interface == null
            ? null
            : {
                displayName: text(catalogRecord(marketplace.interface).displayName),
              },
        plugins: catalogArray(marketplace.plugins).map(summary),
      }
    }),
    store: {
      storePath: catalogString(store.storePath),
      plugins: catalogArray(store.plugins).map(item => {
        const plugin = catalogRecord(item)
        const installedPluginId = plugin.installedPluginId
        if (
          installedPluginId != null &&
          (!Number.isSafeInteger(installedPluginId) || typeof installedPluginId !== 'number')
        )
          throw new Error('Invalid installed plugin ID')
        return {
          name: catalogString(plugin.name),
          packageId: catalogString(plugin.packageId),
          marketplace: catalogString(plugin.marketplace),
          pluginPath: catalogString(plugin.pluginPath),
          enabled: enabled(plugin.enabled),
          installedPluginId: installedPluginId as number | null | undefined,
          displayName: text(plugin.displayName),
          description: text(plugin.description),
          version: text(plugin.version),
          logo: text(plugin.logo),
          category: text(plugin.category),
          defaultPrompt: prompts(plugin.defaultPrompt),
        }
      }),
    },
    cloudInstalledPlugins,
  }
}
