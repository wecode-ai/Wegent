import { execFile } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { isNewerWeworkVersion, parseElectronManifestVersion } from './update-channel-manifests.mjs'
import { isLegacyWindowsMigrationDescriptor } from './windows-legacy-migration.mjs'

export function planChannelUpdates({
  channel,
  version,
  assetNames,
  macVersion,
  windowsV2,
  legacyComponents,
  legacyVersion,
}) {
  if (channel !== 'stable' && channel !== 'beta') throw new Error(`Invalid channel: ${channel}`)
  const electron = channel === 'stable' ? 'latest' : 'beta'
  const available = new Set(assetNames)
  const otherPlatforms = [
    `components-${channel}-macos-arm64.json`,
    `components-${channel}-macos-x64.json`,
    `components-${channel}-linux-x64.json`,
    `${electron}-mac.yml`,
  ]
  const legacy = [`components-${channel}-windows-x64.json`, `${electron}.yml`]
  const v2 = `windows-${channel}-v2.json`
  let publishOther = true
  if (macVersion && !isNewerWeworkVersion(version, macVersion)) {
    if (otherPlatforms.every(name => available.has(name))) publishOther = false
    else if (isNewerWeworkVersion(macVersion, version)) {
      throw new Error(`Newer ${channel} channel ${macVersion} has incomplete platform assets`)
    }
  }
  if (windowsV2 && windowsV2.schemaVersion !== 2) {
    throw new Error(`Unsupported existing ${channel} Windows update protocol`)
  }
  const publishV2 = !windowsV2 || isNewerWeworkVersion(version, windowsV2.version)
  const migration = isLegacyWindowsMigrationDescriptor(legacyComponents ?? {})
  const frozen = migration && legacyComponents.appVersion === legacyVersion
  let publishLegacy = !frozen
  if (publishLegacy && legacyVersion && isNewerWeworkVersion(legacyVersion, version)) {
    if (migration)
      throw new Error('A newer legacy migration bridge is incomplete; rerun its release')
    publishLegacy = false
  }
  if (publishLegacy && migration && isNewerWeworkVersion(legacyComponents.appVersion, version)) {
    throw new Error('A newer legacy migration bridge is incomplete; rerun its release')
  }
  return {
    otherPlatforms: publishOther ? otherPlatforms : [],
    legacyWindows: publishLegacy ? legacy : [],
    windowsV2: publishV2 ? [v2] : [],
  }
}

async function main() {
  const [manifestDirectory, channel, version, temporaryDirectory] = process.argv.slice(2)
  if (!manifestDirectory || !channel || !version || !temporaryDirectory) {
    throw new Error(
      'Usage: publish-desktop-update-channel.mjs <manifests> <channel> <version> <temp>'
    )
  }
  const gh = async args =>
    (await promisify(execFile)('gh', args, { maxBuffer: 16 * 1024 * 1024 })).stdout
  const current = JSON.parse(await gh(['release', 'view', 'wework-updater', '--json', 'assets']))
  const assetNames = current.assets.map(asset => asset.name)
  const directory = join(resolve(temporaryDirectory), `wework-channel-${channel}`)
  await mkdir(directory, { recursive: true })
  const download = async name => {
    if (!assetNames.includes(name)) return undefined
    const file = join(directory, name)
    await gh([
      'release',
      'download',
      'wework-updater',
      '--pattern',
      name,
      '--output',
      file,
      '--clobber',
    ])
    return readFile(file, 'utf8')
  }
  const electron = channel === 'stable' ? 'latest' : 'beta'
  const mac = await download(`${electron}-mac.yml`)
  const legacy = await download(`${electron}.yml`)
  const components = await download(`components-${channel}-windows-x64.json`)
  const windows = await download(`windows-${channel}-v2.json`)
  const plan = planChannelUpdates({
    channel,
    version,
    assetNames,
    macVersion: mac ? parseElectronManifestVersion(mac) : undefined,
    legacyVersion: legacy ? parseElectronManifestVersion(legacy) : undefined,
    legacyComponents: components ? JSON.parse(components) : undefined,
    windowsV2: windows ? JSON.parse(windows) : undefined,
  })
  // Validate the bridge pair before any upload. A partial prior publication must
  // be repaired, never mistaken for a frozen, complete migration endpoint.
  const generated = resolve(manifestDirectory)
  const candidate = JSON.parse(
    await readFile(join(generated, `components-${channel}-windows-x64.json`), 'utf8')
  )
  const candidateVersion = parseElectronManifestVersion(
    await readFile(join(generated, `${electron}.yml`), 'utf8')
  )
  if (
    !isLegacyWindowsMigrationDescriptor(candidate) ||
    candidate.appVersion !== version ||
    candidateVersion !== version
  ) {
    throw new Error('Generated legacy Windows installer and migration components do not match')
  }
  for (const [domain, names] of Object.entries(plan)) {
    if (names.length === 0) {
      console.log(`Keeping existing ${channel} ${domain} manifests`)
      continue
    }
    await gh([
      'release',
      'upload',
      'wework-updater',
      ...names.map(name => join(generated, name)),
      '--clobber',
    ])
    console.log(`Published ${channel} ${domain}: ${names.join(', ')}`)
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main()
}
