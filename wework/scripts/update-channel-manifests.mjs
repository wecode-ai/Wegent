#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.([1-9]\d*))?$/

export function parseWeworkVersion(version) {
  const match = VERSION_PATTERN.exec(version)
  if (!match) {
    throw new Error(`Unsupported Wework version: ${version}`)
  }

  const [, major, minor, patch, beta] = match
  return [
    Number(major),
    Number(minor),
    Number(patch),
    beta === undefined ? 1 : 0,
    beta === undefined ? 0 : Number(beta),
  ]
}

export function compareWeworkVersions(left, right) {
  const leftParts = parseWeworkVersion(left)
  const rightParts = parseWeworkVersion(right)

  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] > rightParts[index] ? 1 : -1
    }
  }

  return 0
}

export function isNewerWeworkVersion(candidate, current) {
  return compareWeworkVersions(candidate, current) > 0
}

export function parseElectronManifestVersion(manifest) {
  const match = /(?:^|\n)version:\s*['"]?([^'"\s]+)['"]?\s*(?:\n|$)/.exec(manifest)
  if (!match) {
    throw new Error('Electron update manifest does not contain a version.')
  }
  parseWeworkVersion(match[1])
  return match[1]
}

export function expectedChannelAssetNames(channel) {
  if (channel !== 'stable' && channel !== 'beta') {
    throw new Error(`Unsupported Wework update channel: ${channel}`)
  }

  const electronChannel = channel === 'stable' ? 'latest' : 'beta'
  return [
    `${electronChannel}.yml`,
    `${electronChannel}-mac.yml`,
    `components-${channel}-macos-arm64.json`,
    `components-${channel}-macos-x64.json`,
    `components-${channel}-windows-x64.json`,
    `components-${channel}-linux-x64.json`,
  ]
}

export function hasCompleteChannelAssets(assetNames, channel) {
  const availableAssets = new Set(assetNames)
  return expectedChannelAssetNames(channel).every(name => availableAssets.has(name))
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'is-newer') {
    const [candidate, current] = args
    if (!candidate || !current) {
      throw new Error('Usage: update-channel-manifests.mjs is-newer <candidate> <current>')
    }
    process.exitCode = isNewerWeworkVersion(candidate, current) ? 0 : 1
    return
  }

  if (command === 'has-complete-channel-assets') {
    const [assetsPath, channel] = args
    if (!assetsPath || !channel) {
      throw new Error(
        'Usage: update-channel-manifests.mjs has-complete-channel-assets <assets-json> <stable|beta>'
      )
    }
    const payload = JSON.parse(await readFile(assetsPath, 'utf8'))
    const assets = Array.isArray(payload) ? payload : payload.assets
    if (!Array.isArray(assets)) {
      throw new Error(`Expected an asset list in ${assetsPath}`)
    }
    const assetNames = assets.map(asset => (typeof asset === 'string' ? asset : asset.name))
    process.exitCode = hasCompleteChannelAssets(assetNames, channel) ? 0 : 1
    return
  }

  if (command === 'read-electron-version') {
    const [manifestPath] = args
    if (!manifestPath) {
      throw new Error('Usage: update-channel-manifests.mjs read-electron-version <manifest-yml>')
    }
    process.stdout.write(`${parseElectronManifestVersion(await readFile(manifestPath, 'utf8'))}\n`)
    return
  }

  throw new Error(
    'Expected command: is-newer, has-complete-channel-assets, or read-electron-version'
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main()
}
