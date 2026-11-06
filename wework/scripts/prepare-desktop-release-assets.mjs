#!/usr/bin/env node

import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  deliveredPackagePaths,
  preparePackagedComponentAssets,
} from './lib/packaged-component-assets.mjs'
import { portableDesktopRelease } from './lib/portable-desktop-release.mjs'

const weworkRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const installerRoot = join(weworkRoot, 'electron', 'release-installer')
const onlineUpdateRoot = join(weworkRoot, 'electron', 'release-online-update')
const [platform, arch, version, outputDirectory] = process.argv.slice(2)

if (!platform || !arch || !version || !outputDirectory) {
  throw new Error(
    'Usage: prepare-desktop-release-assets.mjs <macos|windows|linux> <arm64|x64> <version> <output-directory>'
  )
}

const output = resolve(outputDirectory)
const { appRoot, resourcesRoot } = deliveredPackagePaths(installerRoot, platform, arch)
const installerArchitecture = platform === 'linux' && arch === 'x64' ? 'x86_64' : arch
const useComponentizedHostUpdate = process.env.WEWORK_USE_COMPONENTIZED_HOST_UPDATE === 'true'
await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })

if (platform === 'macos') {
  const dmg = await findFile(
    installerRoot,
    new RegExp(`^WeWork_${escape(version)}_macos_${arch}\\.dmg$`)
  )
  const installerZip = await findFile(
    installerRoot,
    new RegExp(`^WeWork_${escape(version)}_macos_${arch}\\.zip$`)
  )
  await cp(dmg, join(output, basename(dmg)))
  await copyUpdateArtifacts([
    installerZip,
    ...(useComponentizedHostUpdate
      ? [
          await findFile(
            onlineUpdateRoot,
            new RegExp(`^WeWorkHostUpdate_${escape(version)}_macos_${arch}\\.zip$`)
          ),
        ]
      : []),
  ])
} else if (platform === 'windows') {
  const installer = await findFile(
    installerRoot,
    new RegExp(`^WeWork_${escape(version)}_windows_${arch}-setup\\.exe$`)
  )
  await copyUpdateArtifacts([
    installer,
    ...(useComponentizedHostUpdate
      ? [
          await findFile(
            onlineUpdateRoot,
            new RegExp(`^WeWorkHostUpdate_${escape(version)}_windows_${arch}-setup\\.exe$`)
          ),
        ]
      : []),
  ])
} else if (platform === 'linux') {
  const appImage = await findFile(
    installerRoot,
    new RegExp(`^WeWork_${escape(version)}_linux_${installerArchitecture}\\.AppImage$`)
  )
  await copyUpdateArtifacts([
    appImage,
    ...(useComponentizedHostUpdate
      ? [
          await findFile(
            onlineUpdateRoot,
            new RegExp(
              `^WeWorkHostUpdate_${escape(version)}_linux_${installerArchitecture}\\.AppImage$`
            )
          ),
        ]
      : []),
  ])
} else {
  throw new Error(`Unsupported desktop release platform: ${platform}`)
}
await preparePackagedComponentAssets({ resourcesRoot, version, platform, arch, output })
if (platform === 'macos' || platform === 'windows') {
  const release = await portableDesktopRelease({ appRoot, version, platform, arch, output })
  await writeFile(
    join(output, `release-${platform}-${arch}.json`),
    JSON.stringify(release, null, 2) + '\n'
  )
}

async function copyUpdateArtifacts(paths) {
  for (const path of new Set(paths)) {
    await cp(path, join(output, basename(path)))
  }
}

async function findFile(root, pattern) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isFile() && pattern.test(entry.name)) return join(root, entry.name)
  }
  throw new Error(`No file matching ${pattern} under ${root}`)
}

function escape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
