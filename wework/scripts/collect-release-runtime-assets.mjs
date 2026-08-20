#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const defaultWeworkDirectory = path.resolve(scriptDirectory, '..')

const runtimeDefinitions = [
  {
    kind: 'harness',
    descriptor: ['src-tauri', 'bundled-harness-runtime', 'runtime.json'],
    cache: ['node_modules', '.cache', 'harness-runtime-assets'],
  },
  {
    kind: 'node',
    descriptor: ['src-tauri', 'bundled-execution-runtimes', 'node.json'],
    cache: ['node_modules', '.cache', 'execution-runtime-assets'],
  },
]

async function sha256(pathname) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(pathname), hash)
  return hash.digest('hex')
}

function normalizedBaseUrl(value) {
  const baseUrl = value.trim().replace(/\/+$/, '')
  if (!baseUrl) throw new Error('Runtime asset base URL must not be empty')
  return baseUrl
}

export async function collectReleaseRuntimeAssets({
  outputDirectory,
  runtimeBaseUrl,
  expectedPlatform,
  weworkDirectory = defaultWeworkDirectory,
}) {
  const baseUrl = normalizedBaseUrl(runtimeBaseUrl)
  await mkdir(outputDirectory, { recursive: true })

  const assets = []
  for (const definition of runtimeDefinitions) {
    const descriptorPath = path.join(weworkDirectory, ...definition.descriptor)
    const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8'))
    const assetName = descriptor.assetName
    if (typeof assetName !== 'string' || !assetName) {
      throw new Error(`Runtime descriptor has no assetName: ${descriptorPath}`)
    }
    if (!assetName.startsWith(`${definition.kind === 'node' ? 'node' : 'harness'}-runtime-`)) {
      throw new Error(`Unexpected ${definition.kind} runtime asset name: ${assetName}`)
    }
    if (!assetName.includes(`-${expectedPlatform}-`)) {
      throw new Error(
        `${definition.kind} runtime asset targets the wrong platform: expected ${expectedPlatform}, got ${assetName}`
      )
    }

    const expectedUrl = `${baseUrl}/${assetName}`
    if (descriptor.downloadUrl !== expectedUrl) {
      throw new Error(
        `${definition.kind} runtime download URL must be ${expectedUrl}, got ${descriptor.downloadUrl}`
      )
    }

    const sourcePath = path.join(weworkDirectory, ...definition.cache, assetName)
    const sourceStat = await stat(sourcePath)
    const archiveSha256 = await sha256(sourcePath)
    if (descriptor.archiveBytes !== sourceStat.size) {
      throw new Error(
        `${definition.kind} runtime size mismatch: expected ${descriptor.archiveBytes}, got ${sourceStat.size}`
      )
    }
    if (descriptor.archiveSha256 !== archiveSha256) {
      throw new Error(`${definition.kind} runtime checksum mismatch: ${assetName}`)
    }

    await copyFile(sourcePath, path.join(outputDirectory, assetName))
    assets.push({
      kind: definition.kind,
      name: assetName,
      bytes: sourceStat.size,
      sha256: archiveSha256,
      downloadUrl: expectedUrl,
    })
  }

  const manifestPath = path.join(outputDirectory, 'release-runtime-assets.json')
  await writeFile(manifestPath, `${JSON.stringify({ assets }, null, 2)}\n`, 'utf8')
  return manifestPath
}

async function main() {
  const [outputDirectory, runtimeBaseUrl, expectedPlatform] = process.argv.slice(2)
  if (!outputDirectory || !runtimeBaseUrl || !expectedPlatform) {
    throw new Error(
      'Usage: collect-release-runtime-assets.mjs <output-directory> <runtime-base-url> <expected-platform>'
    )
  }
  await collectReleaseRuntimeAssets({
    outputDirectory: path.resolve(outputDirectory),
    runtimeBaseUrl,
    expectedPlatform,
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main()
}
