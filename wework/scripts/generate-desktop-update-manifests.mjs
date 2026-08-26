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
const releaseBaseUrl = `https://github.com/${repository}/releases/download/${releaseTag}`
await mkdir(output, { recursive: true })

const macArm = await asset(`WeWork_${version}_macos_arm64.zip`)
const macX64 = await asset(`WeWork_${version}_macos_x64.zip`)
const windows = await asset(`WeWork_${version}_windows_x64-setup.exe`)
const electronChannels = channel === 'stable' ? ['latest', 'beta'] : ['beta']

for (const targetChannel of electronChannels) {
  await writeFile(
    resolve(output, `${targetChannel}-mac.yml`),
    electronManifest(version, releaseDate, notes, [macArm, macX64]),
    'utf8'
  )
  await writeFile(
    resolve(output, `${targetChannel}.yml`),
    electronManifest(version, releaseDate, notes, [windows]),
    'utf8'
  )
}

const tauriSource = {
  version,
  notes,
  pub_date: releaseDate,
  platforms: {
    'darwin-aarch64': await tauriEntry(`WeWork_${version}_macos_arm64.app.tar.gz`),
    'darwin-x86_64': await tauriEntry(`WeWork_${version}_macos_x64.app.tar.gz`),
    'windows-x86_64': await tauriEntry(`WeWork_${version}_windows_x64-setup.exe`),
  },
}
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

async function asset(name) {
  const path = resolve(assets, name)
  const file = await stat(path)
  if (!file.isFile()) throw new Error(`Desktop release asset is missing: ${path}`)
  return {
    name,
    url: `${releaseBaseUrl}/${encodeURIComponent(name)}`,
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
