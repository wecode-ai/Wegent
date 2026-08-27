#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'

const [assetsDirectory, outputDirectory, version, channel, repository, releaseTag, notesPath] =
  process.argv.slice(2)

if (
  !assetsDirectory ||
  !outputDirectory ||
  !version ||
  !channel ||
  !repository ||
  !releaseTag ||
  !notesPath
) {
  throw new Error(
    'Usage: generate-desktop-update-manifests.mjs <assets> <output> <version> <stable|beta> <repository> <release-tag> <notes-file>'
  )
}
if (channel !== 'stable' && channel !== 'beta') {
  throw new Error(`Unsupported Wework update channel: ${channel}`)
}

const assets = resolve(assetsDirectory)
const output = resolve(outputDirectory)
const notes = await readFile(resolve(notesPath), 'utf8')
const releaseDate = new Date().toISOString()
const releaseBaseUrl = (
  process.env.WEWORK_RELEASE_BASE_URL?.trim() ||
  `https://github.com/${repository}/releases/download/${releaseTag}`
).replace(/\/+$/, '')
const componentBaseUrl = (
  process.env.WEWORK_COMPONENT_BASE_URL?.trim() ||
  `https://github.com/${repository}/releases/download/wework-updater`
).replace(/\/+$/, '')
const requestedTargets = new Set(
  (process.env.WEWORK_RELEASE_TARGETS?.trim() || 'macos-arm64,macos-x64,windows-x64')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
)
const supportedTargets = new Set(['macos-arm64', 'macos-x64', 'windows-x64'])
if (requestedTargets.size === 0) {
  throw new Error('At least one desktop release target is required.')
}
if ([...requestedTargets].some(target => !supportedTargets.has(target))) {
  throw new Error(`Unsupported desktop release targets: ${[...requestedTargets].join(', ')}`)
}
await mkdir(output, { recursive: true })

const macAssets = []
if (requestedTargets.has('macos-arm64')) {
  macAssets.push(await asset(`WeWork_${version}_macos_arm64.zip`))
}
if (requestedTargets.has('macos-x64')) {
  macAssets.push(await asset(`WeWork_${version}_macos_x64.zip`))
}
const windows = requestedTargets.has('windows-x64')
  ? await asset(`WeWork_${version}_windows_x64-setup.exe`)
  : null
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

const tauriPlatforms = {}
if (requestedTargets.has('macos-arm64')) {
  tauriPlatforms['darwin-aarch64'] = await tauriEntry(`WeWork_${version}_macos_arm64.app.tar.gz`)
}
if (requestedTargets.has('macos-x64')) {
  tauriPlatforms['darwin-x86_64'] = await tauriEntry(`WeWork_${version}_macos_x64.app.tar.gz`)
}
if (requestedTargets.has('windows-x64')) {
  tauriPlatforms['windows-x86_64'] = await tauriEntry(`WeWork_${version}_windows_x64-setup.exe`)
}
const tauriSource = {
  version,
  notes,
  pub_date: releaseDate,
  platforms: tauriPlatforms,
}
await writeFile(resolve(output, 'latest.json'), `${JSON.stringify(tauriSource, null, 2)}\n`, 'utf8')
const tauriChannels = channel === 'stable' ? ['stable', 'beta'] : ['beta']
for (const targetChannel of tauriChannels) {
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
    const archivePath = resolve(assets, component.assetName)
    const archive = await localAsset(component.assetName)
    const archiveSha256 = await sha256(archivePath)
    if (archiveSha256 !== component.archiveSha256) {
      throw new Error(
        `Component archive checksum mismatch for ${id}: expected ${component.archiveSha256}, received ${archiveSha256}`
      )
    }
    components[id] = {
      version: component.version,
      contentSha256: component.contentSha256,
      archiveSha256,
      archiveBytes: archive.size,
      downloadUrl: `${componentBaseUrl}/${encodeURIComponent(component.assetName)}`,
      entryPath: component.entryPath,
    }
  }
  for (const targetChannel of tauriChannels) {
    await writeFile(
      resolve(output, `components-${targetChannel}-${platform}-${architecture}.json`),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          appVersion: version,
          channel: targetChannel,
          platform,
          arch: architecture,
          releaseDate,
          components,
        },
        null,
        2
      )}\n`,
      'utf8'
    )
  }
}

async function asset(name) {
  const local = await localAsset(name)
  return {
    ...local,
    url: `${releaseBaseUrl}/${encodeURIComponent(name)}`,
  }
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
