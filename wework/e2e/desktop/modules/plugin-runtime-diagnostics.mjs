import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'

async function directories(path) {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort()
  } catch {
    return []
  }
}

async function nativePluginState(profile, name, marketplace) {
  if (![name, marketplace].every(value => typeof value === 'string' && /^[\w.-]+$/u.test(value)))
    return null
  const cache = join(profile, 'codex/plugins/cache', marketplace, name)
  const versions = await Promise.all(
    (await directories(cache)).map(async version => {
      const metadata = await stat(join(cache, version))
      return {
        version,
        createdAt: metadata.birthtime.toISOString(),
        modifiedAt: metadata.mtime.toISOString(),
      }
    })
  )
  const source = join(profile, 'codex/plugins/marketplaces', marketplace, 'plugins', name)
  return { versions, marketplaceTarget: await realpath(source).catch(() => null) }
}

async function profileState(profile) {
  try {
    const manifest = JSON.parse(
      await readFile(join(profile, 'capabilities/manifest-v2.json'), 'utf8')
    )
    const plugins = await Promise.all(
      Object.entries(manifest.plugins ?? {}).map(async ([key, entry]) => ({
        key,
        name: entry.name,
        marketplace: entry.marketplace,
        version: entry.version,
        checksum: entry.checksum,
        enabled: entry.enabled,
        installedPluginId: entry.installed_plugin_id,
        runtimePath: entry.runtime?.codex_link,
        native: await nativePluginState(profile, entry.name, entry.marketplace),
      }))
    )
    return { profile, plugins }
  } catch (error) {
    return { profile, errorCode: error.code ?? 'invalid_manifest' }
  }
}

export async function collectPluginRuntimeDiagnostics(homePath, executorHome, cloud) {
  const profiles = [executorHome]
  for (const name of await directories(homePath)) {
    if (!name.startsWith('legacy-')) continue
    const workbench = join(homePath, name, '.wegent/workbench/wework')
    for (const scope of await directories(workbench)) profiles.push(join(workbench, scope))
  }
  let account
  if (cloud?.mysqlConnectionOptions) {
    try {
      account = await cloud.queryDatabase(
        `SELECT id, name, is_active,
         JSON_EXTRACT(json, '$.spec.releaseId') AS release_id,
         JSON_EXTRACT(json, '$.spec.version') AS version,
         JSON_EXTRACT(json, '$.spec.updatePolicy') AS update_policy
         FROM kinds WHERE kind = 'InstalledPlugin' ORDER BY id`
      )
    } catch (error) {
      account = { errorCode: error.code ?? 'query_failed' }
    }
  }
  return { profiles: await Promise.all(profiles.map(profileState)), account }
}
