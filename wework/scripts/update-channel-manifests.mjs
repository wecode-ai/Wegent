#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises'
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

export async function generateChannelManifests({ sourcePath, outputDirectory, channel }) {
  if (channel !== 'stable' && channel !== 'beta') {
    throw new Error(`Unsupported Wework update channel: ${channel}`)
  }

  const source = JSON.parse(await readFile(sourcePath, 'utf8'))
  const platforms = ['darwin-aarch64', 'darwin-x86_64', 'windows-x86_64']
  await mkdir(outputDirectory, { recursive: true })

  for (const platform of platforms) {
    const [operatingSystem, ...architectureParts] = platform.split('-')
    const architecture = architectureParts.join('-')
    const target = `${channel}-${operatingSystem}`
    const entry = source.platforms?.[platform]
    if (!entry) {
      throw new Error(`Missing platform '${platform}' in ${sourcePath}`)
    }
    const data = {
      version: source.version,
      notes: source.notes,
      pub_date: source.pub_date,
      platforms: {
        [target]: entry,
      },
    }
    await writeFile(
      resolve(outputDirectory, `${target}-${architecture}.json`),
      `${JSON.stringify(data, null, 2)}\n`,
      'utf8'
    )
  }
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

  if (command === 'generate') {
    const [sourcePath, outputDirectory, channel] = args
    if (!sourcePath || !outputDirectory || !channel) {
      throw new Error(
        'Usage: update-channel-manifests.mjs generate <source> <output-directory> <channel>'
      )
    }
    await generateChannelManifests({ sourcePath, outputDirectory, channel })
    return
  }

  throw new Error('Expected command: is-newer or generate')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main()
}
