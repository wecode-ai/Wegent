#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const defaultWeworkDirectory = path.resolve(scriptDirectory, '..')

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

function validateRuntimeDescriptor(descriptor, kind, baseUrl, expectedPlatform, descriptorPath) {
  const assetName = descriptor.assetName
  if (typeof assetName !== 'string' || !assetName) {
    throw new Error(`Runtime descriptor has no assetName: ${descriptorPath}`)
  }
  if (!assetName.startsWith(`${kind}-runtime-`)) {
    throw new Error(`Unexpected ${kind} runtime asset name: ${assetName}`)
  }
  if (!assetName.includes(`-${expectedPlatform}-`)) {
    throw new Error(
      `${kind} runtime asset targets the wrong platform: expected ${expectedPlatform}, got ${assetName}`
    )
  }
  const expectedUrl = `${baseUrl}/${assetName}`
  if (descriptor.downloadUrl !== expectedUrl) {
    throw new Error(
      `${kind} runtime download URL must be ${expectedUrl}, got ${descriptor.downloadUrl}`
    )
  }
  return assetName
}

async function runtimeDefinitions(weworkDirectory) {
  const harnessCatalogPath = path.join(
    weworkDirectory,
    'src-tauri',
    'bundled-harness-runtime',
    'runtimes.json'
  )
  const harnessCatalog = JSON.parse(await readFile(harnessCatalogPath, 'utf8'))
  if (!Array.isArray(harnessCatalog.runtimes) || harnessCatalog.runtimes.length === 0) {
    throw new Error(`Harness runtime catalog is empty: ${harnessCatalogPath}`)
  }
  return [
    ...harnessCatalog.runtimes.map(descriptor => ({
      kind: 'harness',
      descriptor,
      descriptorSource: null,
      descriptorLabel: harnessCatalogPath,
      cacheDirectory: path.join(
        weworkDirectory,
        'node_modules',
        '.cache',
        'harness-runtime-assets'
      ),
    })),
    {
      kind: 'node',
      descriptor: JSON.parse(
        await readFile(
          path.join(weworkDirectory, 'src-tauri', 'bundled-execution-runtimes', 'node.json'),
          'utf8'
        )
      ),
      descriptorSource: path.join(
        weworkDirectory,
        'src-tauri',
        'bundled-execution-runtimes',
        'node.json'
      ),
      descriptorLabel: path.join(
        weworkDirectory,
        'src-tauri',
        'bundled-execution-runtimes',
        'node.json'
      ),
      cacheDirectory: path.join(
        weworkDirectory,
        'node_modules',
        '.cache',
        'execution-runtime-assets'
      ),
    },
  ]
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
  for (const definition of await runtimeDefinitions(weworkDirectory)) {
    const { descriptor, kind } = definition
    const assetName = validateRuntimeDescriptor(
      descriptor,
      kind,
      baseUrl,
      expectedPlatform,
      definition.descriptorLabel
    )
    const descriptorName = assetName.replace(/\.tar\.gz$/, '.json')

    const sourcePath = path.join(definition.cacheDirectory, assetName)
    const sourceStat = await stat(sourcePath)
    const archiveSha256 = await sha256(sourcePath)
    if (descriptor.archiveBytes !== sourceStat.size) {
      throw new Error(
        `${kind} runtime size mismatch: expected ${descriptor.archiveBytes}, got ${sourceStat.size}`
      )
    }
    if (descriptor.archiveSha256 !== archiveSha256) {
      throw new Error(`${kind} runtime checksum mismatch: ${assetName}`)
    }

    await copyFile(sourcePath, path.join(outputDirectory, assetName))
    if (definition.descriptorSource) {
      await copyFile(definition.descriptorSource, path.join(outputDirectory, descriptorName))
    } else {
      await writeFile(
        path.join(outputDirectory, descriptorName),
        `${JSON.stringify(descriptor, null, 2)}\n`,
        'utf8'
      )
    }
    assets.push({
      kind,
      archiveName: assetName,
      descriptorName,
      bytes: sourceStat.size,
      sha256: archiveSha256,
      downloadUrl: descriptor.downloadUrl,
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
