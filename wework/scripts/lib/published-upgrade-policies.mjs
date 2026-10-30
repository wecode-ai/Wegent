import { execFileSync } from 'node:child_process'
import { validateUpgradeCatalog } from '../../electron/src/runtime/upgrade-policy.mjs'

export function publishedUpgradePolicies({ repository, platform, arch }, execute = execFileSync) {
  const readJson = args =>
    JSON.parse(
      execute('gh', ['release', ...args, '--repo', repository], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      })
    )
  const shared = readJson(['view', 'wework-updater', '--json', 'assets'])
  const catalogs = {}
  for (const channel of ['stable', 'beta']) {
    const name = `components-${channel}-${platform}-${arch}.json`
    // Only a genuinely missing catalog permits an initial protocol baseline.
    if (!shared.assets.some(asset => asset.name === name)) continue
    const manifest = readJson(['download', 'wework-updater', '--pattern', name, '--output', '-'])
    if (!manifest.upgradePolicy) continue
    const catalog = validateUpgradeCatalog(manifest.upgradePolicy)
    if (catalog.channel !== channel || catalog.platform !== platform || catalog.arch !== arch)
      throw new Error('Published upgrade policy target mismatch')
    catalogs[channel] = catalog
  }
  return catalogs
}
