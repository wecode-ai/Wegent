import { normalizeProjectPluginNames } from './composer-plugin-scope'
import { buildComposerPluginInventory } from './composer-plugin-inventory'
import type { RuntimeTaskAddress } from './runtime'
import type { RuntimeComposerCatalogSnapshot } from './runtime-composer-snapshot'
import type { LocalDeviceApp } from './runtime-composer-catalog'
import {
  mergeInstalledPluginSummaries,
  toWegentStoreInstalledPlugin,
} from './codex-installed-plugins'
import { mergeLocalInstalledWithStorePackages } from './installed-plugin-merge'
import { preferWeworkPersonalInstalled } from './personal-plugin-preference'
import { createPluginAssetResolver } from './plugin-assets'
import { createComposerPluginPresentation } from './composer-plugin-presentation'

const assetPaths = createPluginAssetResolver(path => path)
const presentation = createComposerPluginPresentation(assetPaths.resolveInstalledPluginLogoUrl)

export function composerAppsFromRuntimeSnapshot(
  snapshot: RuntimeComposerCatalogSnapshot,
  deviceId: string,
  translate: (key: string) => string
): LocalDeviceApp[] {
  const local = mergeLocalInstalledWithStorePackages(
    preferWeworkPersonalInstalled(
      mergeInstalledPluginSummaries(snapshot.marketplaces, [], translate)
    ),
    snapshot.store.plugins.map(plugin =>
      toWegentStoreInstalledPlugin(plugin, snapshot.store.storePath, translate)
    )
  )
  return buildComposerPluginInventory({
    deviceId,
    apps: snapshot.apps,
    localInstalledPlugins: local,
    cloudInstalledPlugins: snapshot.cloudInstalledPlugins,
    visiblePluginKeys: new Set(normalizeProjectPluginNames(snapshot.projectPluginIds)),
    presentation,
  })
}

/** One instance per addressed composer; simultaneous menu readers share a single request. */
export function createRuntimeComposerPluginSource(
  read: (
    address: RuntimeTaskAddress,
    forceRefresh: boolean
  ) => Promise<RuntimeComposerCatalogSnapshot>,
  address: RuntimeTaskAddress,
  translate: (key: string) => string,
  resolveAsset: (path: string) => Promise<string>
) {
  type Catalog = { apps: LocalDeviceApp[]; skills: RuntimeComposerCatalogSnapshot['skills'] }
  let pending: Promise<Catalog> | null = null
  const load = () => {
    if (pending) return pending
    const request = read(address, true)
      .then(async snapshot => ({
        apps: await Promise.all(
          composerAppsFromRuntimeSnapshot(snapshot, address.deviceId, translate).map(async app => {
            const [logoUrl, logoUrlDark] = await Promise.all([
              app.logoUrl ? resolveAsset(app.logoUrl) : app.logoUrl,
              app.logoUrlDark ? resolveAsset(app.logoUrlDark) : app.logoUrlDark,
            ])
            return { ...app, logoUrl, logoUrlDark }
          })
        ),
        skills: snapshot.skills,
      }))
      .finally(() => {
        if (pending === request) pending = null
      })
    pending = request
    return request
  }
  return {
    listApps: async () => (await load()).apps,
    listSkills: async () => (await load()).skills,
  }
}
