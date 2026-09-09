#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'

import { componentReleaseScope } from './desktop-component-release.mjs'

const [
  assetsDirectory,
  outputDirectory,
  version,
  channel,
  repository,
  releaseTag,
  notesPath,
  sourceSha,
] = process.argv.slice(2)

if (
  !assetsDirectory ||
  !outputDirectory ||
  !version ||
  !channel ||
  !repository ||
  !releaseTag ||
  !notesPath ||
  !sourceSha
) {
  throw new Error(
    'Usage: generate-desktop-update-manifests.mjs <assets> <output> <version> <stable|beta> <repository> <release-tag> <notes-file> <source-sha>'
  )
}
if (channel !== 'stable' && channel !== 'beta') {
  throw new Error(`Unsupported Wework update channel: ${channel}`)
}
if (!/^[0-9a-f]{40,64}$/.test(sourceSha)) {
  throw new Error(`Invalid Wework source SHA: ${sourceSha}`)
}

const assets = resolve(assetsDirectory)
const output = resolve(outputDirectory)
const notes = await readFile(resolve(notesPath), 'utf8')
const releaseDate = new Date().toISOString()
const releaseBaseUrl = (
  process.env.WEWORK_RELEASE_BASE_URL?.trim() ||
  `https://github.com/${repository}/releases/download/${releaseTag}`
).replace(/\/+$/, '')
const sharedComponentBaseUrl = (
  process.env.WEWORK_COMPONENT_BASE_URL?.trim() ||
  `https://github.com/${repository}/releases/download/wework-updater`
).replace(/\/+$/, '')
const useComponentizedHostUpdate = process.env.WEWORK_USE_COMPONENTIZED_HOST_UPDATE === 'true'
const includeLegacyTauriBridge =
  process.env.WEWORK_INCLUDE_LEGACY_TAURI_BRIDGE?.trim().toLowerCase() !== 'false'
const requestedTargets = new Set(
  (process.env.WEWORK_RELEASE_TARGETS?.trim() || 'macos-arm64,macos-x64,windows-x64')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
)
const supportedTargets = new Set(['macos-arm64', 'macos-x64', 'windows-x64'])
const macosReleasePlatforms = new Map([
  ['macos-arm64', 'darwin-aarch64'],
  ['macos-x64', 'darwin-x86_64'],
])
if (requestedTargets.size === 0) {
  throw new Error('At least one desktop release target is required.')
}
if ([...requestedTargets].some(target => !supportedTargets.has(target))) {
  throw new Error(`Unsupported desktop release targets: ${[...requestedTargets].join(', ')}`)
}
await mkdir(output, { recursive: true })

const macAssets = []
for (const [target, platform] of macosReleasePlatforms) {
  if (requestedTargets.has(target)) {
    macAssets.push(await updateAsset(`${platform}.zip`))
  }
}
const windows = requestedTargets.has('windows-x64')
  ? await updateAsset(`windows-x64-setup.exe`)
  : null
await Promise.all(
  [...macAssets, ...(windows ? [windows] : [])].map(file => requireAsset(`${file.name}.blockmap`))
)
const electronChannels = channel === 'stable' ? ['latest', 'beta'] : ['beta']

for (const targetChannel of electronChannels) {
  if (macAssets.length > 0) {
    await writeFile(
      resolve(output, `${targetChannel}-mac.yml`),
      electronManifest(version, releaseDate, notes, macAssets),
      'utf8'
    )
  }
  if (windows) {
    await writeFile(
      resolve(output, `${targetChannel}.yml`),
      electronManifest(version, releaseDate, notes, [windows]),
      'utf8'
    )
  }
}

const updateChannels = channel === 'stable' ? ['stable', 'beta'] : ['beta']
if (includeLegacyTauriBridge) {
  const tauriPlatforms = {}
  for (const [target, platform] of macosReleasePlatforms) {
    if (requestedTargets.has(target)) {
      tauriPlatforms[platform] = await tauriEntry(`WeWork_${version}_${platform}.app.tar.gz`)
    }
  }
  if (requestedTargets.has('windows-x64')) {
    tauriPlatforms['windows-x86_64'] = await tauriEntry(`WeWork_${version}_windows-x64-setup.exe`)
  }
  const tauriSource = {
    version,
    notes,
    pub_date: releaseDate,
    platforms: tauriPlatforms,
  }
  await writeFile(
    resolve(output, 'latest.json'),
    `${JSON.stringify(tauriSource, null, 2)}\n`,
    'utf8'
  )
  for (const targetChannel of updateChannels) {
    for (const [platform, entry] of Object.entries(tauriSource.platforms)) {
      const [operatingSystem, ...architecture] = platform.split('-')
      const target = `${targetChannel}-${operatingSystem}`
      await writeFile(
        resolve(output, `${target}-${architecture.join('-')}.json`),
        `${JSON.stringify(
          {
            version,
            notes,
            pub_date: releaseDate,
            platforms: { [target]: entry },
          },
          null,
          2
        )}\n`,
        'utf8'
      )
    }
  }
}

const componentTargets = [
  ...(requestedTargets.has('macos-arm64') ? [['macos', 'arm64']] : []),
  ...(requestedTargets.has('macos-x64') ? [['macos', 'x64']] : []),
  ...(requestedTargets.has('windows-x64') ? [['windows', 'x64']] : []),
  ['linux', 'x64'],
]
const hasComponentRelease = await Promise.all(
  componentTargets.map(([platform, architecture]) =>
    stat(resolve(assets, `components-${platform}-${architecture}.json`))
      .then(file => file.isFile())
      .catch(() => false)
  )
).then(results => results.some(Boolean))

for (const [platform, architecture] of hasComponentRelease ? componentTargets : []) {
  const sourcePath = resolve(assets, `components-${platform}-${architecture}.json`)
  let source
  try {
    source = JSON.parse(await readFile(sourcePath, 'utf8'))
  } catch {
    if (platform === 'linux') continue
    throw new Error(`Component release descriptor is missing: ${sourcePath}`)
  }
  const components = {}
  for (const [id, component] of Object.entries(source.components ?? {})) {
    const releaseScope = componentReleaseScope(id)
    if (component.releaseScope !== releaseScope) {
      throw new Error(
        `Component release scope mismatch for ${id}: expected ${releaseScope}, received ${component.releaseScope}`
      )
    }
    const resolvedArchive = await resolveComponentArchive(component, id, releaseScope)
    components[id] = {
      version: component.version,
      contentSha256: component.contentSha256,
      archiveSha256: resolvedArchive.archiveSha256,
      archiveBytes: resolvedArchive.archiveBytes,
      downloadUrl: resolvedArchive.downloadUrl,
      entryPath: component.entryPath,
    }
  }
  for (const targetChannel of updateChannels) {
    await writeFile(
      resolve(output, `components-${targetChannel}-${platform}-${architecture}.json`),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          appVersion: version,
          sourceSha,
          channel: targetChannel,
          platform,
          arch: architecture,
          releaseDate,
          capabilities: {
            componentizedHostUpdate: 1,
          },
          components,
        },
        null,
        2
      )}\n`,
      'utf8'
    )
  }
}

async function resolveComponentArchive(component, id, releaseScope) {
  if (component.reused === true) {
    if (
      !/^[0-9a-f]{64}$/.test(component.archiveSha256) ||
      !Number.isSafeInteger(component.archiveBytes) ||
      component.archiveBytes <= 0 ||
      typeof component.downloadUrl !== 'string'
    ) {
      throw new Error(`Reused component archive metadata is invalid: ${id}`)
    }
    return component
  }
  const archivePath = resolve(assets, component.assetName)
  const archive = await localAsset(component.assetName)
  const archiveSha256 = await sha256(archivePath)
  if (archiveSha256 !== component.archiveSha256) {
    throw new Error(
      `Component archive checksum mismatch for ${id}: expected ${component.archiveSha256}, received ${archiveSha256}`
    )
  }
  return {
    archiveSha256,
    archiveBytes: archive.size,
    downloadUrl: `${releaseScope === 'shared' ? sharedComponentBaseUrl : releaseBaseUrl}/${encodeURIComponent(component.assetName)}`,
  }
}

async function asset(name) {
  const local = await localAsset(name)
  return {
    ...local,
    url: `${releaseBaseUrl}/${encodeURIComponent(name)}`,
  }
}

async function updateAsset(suffix) {
  const prefix = useComponentizedHostUpdate ? 'WeWorkHostUpdate' : 'WeWork'
  return asset(`${prefix}_${version}_${suffix}`)
}

async function localAsset(name) {
  const path = resolve(assets, name)
  const file = await stat(path)
  if (!file.isFile()) throw new Error(`Desktop release asset is missing: ${path}`)
  return {
    name,
    size: file.size,
    sha512: await sha512(path),
  }
}

async function requireAsset(name) {
  const path = resolve(assets, name)
  const file = await stat(path).catch(() => null)
  if (!file?.isFile()) throw new Error(`Desktop release asset is missing: ${path}`)
}

async function tauriEntry(name) {
  const signaturePath = resolve(assets, `${name}.sig`)
  return {
    signature: (await readFile(signaturePath, 'utf8')).trim(),
    url: `${releaseBaseUrl}/${encodeURIComponent(name)}`,
  }
}

function electronManifest(releaseVersion, date, releaseNotes, files) {
  const primary = files[0]
  const indentedNotes = releaseNotes
    .trimEnd()
    .split('\n')
    .map(line => `  ${line}`)
    .join('\n')
  return [
    `version: ${releaseVersion}`,
    'files:',
    ...files.flatMap(file => [
      `  - url: ${file.url}`,
      `    sha512: ${file.sha512}`,
      `    size: ${file.size}`,
    ]),
    `path: ${primary.url}`,
    `sha512: ${primary.sha512}`,
    `releaseDate: '${date}'`,
    'releaseNotes: |-',
    indentedNotes || '  ',
    '',
  ].join('\n')
}

async function sha512(path) {
  const hash = createHash('sha512')
  await pipeline(createReadStream(path), hash)
  return hash.digest('base64')
}

async function sha256(path) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}
