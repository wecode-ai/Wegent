#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { create } from 'tar'

import { hashComponentPath } from './lib/component-content-hash.mjs'
import {
  loadPreviousComponentManifest,
  resolveReusableComponent,
} from './lib/component-asset-reuse.mjs'
import { componentReleaseScope } from './desktop-component-release.mjs'
import { desktopComponentIds } from './lib/desktop-component-ids.mjs'
import identityModule from '../electron/scripts/build-identity.cjs'

const { resolveBuildIdentity } = identityModule
const weworkRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const installerRoot = join(weworkRoot, 'electron', 'release-installer')
const onlineUpdateRoot = join(weworkRoot, 'electron', 'release-online-update')
const componentResourcesRoot = join(weworkRoot, 'electron', 'resources')
const [platform, arch, version, outputDirectory] = process.argv.slice(2)
const identity = resolveBuildIdentity()
const componentAssetSource = process.env.WEWORK_RELEASE_COMPONENT_ASSET_SOURCE?.trim() || 'prepared'
const previousComponentManifestPath = process.env.WEWORK_PREVIOUS_COMPONENT_MANIFEST?.trim()
let packagedComponentResourcesRoot = componentResourcesRoot

if (!platform || !arch || !version || !outputDirectory) {
  throw new Error(
    'Usage: prepare-desktop-release-assets.mjs <macos|windows|linux> <arm64|x64> <version> <output-directory>'
  )
}
if (!['prepared', 'packaged-macos-app'].includes(componentAssetSource)) {
  throw new Error(`Unsupported release component asset source: ${componentAssetSource}`)
}
if (componentAssetSource === 'packaged-macos-app' && platform !== 'macos') {
  throw new Error('packaged-macos-app component assets require the macOS release platform')
}

const output = resolve(outputDirectory)
const installerArchitecture = platform === 'linux' && arch === 'x64' ? 'x86_64' : arch
const useComponentizedHostUpdate = process.env.WEWORK_USE_COMPONENTIZED_HOST_UPDATE === 'true'
const previousComponentManifest = await loadPreviousComponentManifest(
  previousComponentManifestPath,
  platform,
  arch
)
await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })

if (platform === 'macos') {
  const appDirectory = join(installerRoot, arch === 'arm64' ? 'mac-arm64' : 'mac')
  const releasePlatform = arch === 'arm64' ? 'darwin-aarch64' : 'darwin-x86_64'
  if (componentAssetSource === 'packaged-macos-app') {
    const appPath = join(appDirectory, `${identity.productName}.app`)
    await requireDirectory(appPath)
    packagedComponentResourcesRoot = join(appPath, 'Contents', 'Resources')
  }
  const dmg = await findFile(
    installerRoot,
    new RegExp(`^WeWork_${escape(version)}_macos_${arch}\\.dmg$`)
  )
  const zip = await findFile(
    installerRoot,
    new RegExp(`^WeWork_${escape(version)}_macos_${arch}\\.zip$`)
  )
  const blockmap = `${zip}.blockmap`
  await requireFile(blockmap)
  const releaseBaseName = `WeWork_${version}_${releasePlatform}`
  const releaseZip = join(output, `${releaseBaseName}.zip`)
  await Promise.all([
    cp(dmg, join(output, `${releaseBaseName}.dmg`)),
    cp(zip, releaseZip),
    cp(blockmap, `${releaseZip}.blockmap`),
  ])
  if (useComponentizedHostUpdate) {
    const updateZip = await findFile(
      onlineUpdateRoot,
      new RegExp(`^WeWorkHostUpdate_${escape(version)}_macos_${arch}\\.zip$`)
    )
    const updateReleaseZip = join(output, `WeWorkHostUpdate_${version}_${releasePlatform}.zip`)
    await requireFile(`${updateZip}.blockmap`)
    await cp(updateZip, updateReleaseZip)
    await cp(`${updateZip}.blockmap`, `${updateReleaseZip}.blockmap`)
  }
} else if (platform === 'windows') {
  const installer = await findFile(
    installerRoot,
    new RegExp(`^WeWork_${escape(version)}_windows-${arch}-setup\\.exe$`)
  )
  await copyUpdateArtifacts([
    installer,
    ...(useComponentizedHostUpdate
      ? [
          await findFile(
            onlineUpdateRoot,
            new RegExp(`^WeWorkHostUpdate_${escape(version)}_windows-${arch}-setup\\.exe$`)
          ),
        ]
      : []),
  ])
} else if (platform === 'linux') {
  const appImage = await findFile(
    installerRoot,
    new RegExp(`^WeWork_${escape(version)}_linux_${installerArchitecture}\\.AppImage$`)
  )
  await copyUpdateArtifacts(
    [
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
    ],
    false
  )
} else {
  throw new Error(`Unsupported desktop release platform: ${platform}`)
}
await prepareComponentAssets()

async function prepareComponentAssets() {
  const packaged = JSON.parse(
    await readFile(join(packagedComponentResourcesRoot, 'components.json'), 'utf8')
  )
  const componentAssets = {}
  for (const id of desktopComponentIds) {
    const component = packaged.components[id]
    if (!component?.path || !component?.sha256 || !component?.version) {
      throw new Error(`Packaged component metadata is incomplete: ${id}`)
    }
    const sourcePath = join(packagedComponentResourcesRoot, component.path)
    const source = await stat(sourcePath)
    const contentSha256 = await hashComponentPath(sourcePath)
    const entryPath = source.isDirectory() ? '.' : basename(sourcePath)
    const reusable = resolveReusableComponent({
      arch,
      component,
      contentSha256,
      entryPath,
      id,
      platform,
      previousManifest: previousComponentManifest,
    })
    if (reusable) {
      componentAssets[id] = reusable
      console.log(`Reusing unchanged component asset: ${reusable.assetName}`)
      continue
    }
    const temporaryAssetPath = join(output, `.component-${id}.tar.gz`)
    const archiveOptions = {
      cwd: source.isDirectory() ? sourcePath : dirname(sourcePath),
      file: temporaryAssetPath,
      gzip: true,
      mtime: new Date(0),
      portable: true,
    }
    if (source.isDirectory()) {
      await create(archiveOptions, ['.'])
    } else if (source.isFile()) {
      await create(archiveOptions, [basename(sourcePath)])
    } else {
      throw new Error(`Component source is unavailable: ${sourcePath}`)
    }
    const archiveSha256 = await sha256(temporaryAssetPath)
    const assetName = `WeworkComponent_${id}_${archiveSha256}_${platform}_${arch}.tar.gz`
    const archivePath = join(output, assetName)
    await rename(temporaryAssetPath, archivePath)
    componentAssets[id] = {
      version: component.version,
      contentSha256,
      archiveSha256,
      archiveBytes: (await stat(archivePath)).size,
      assetName,
      releaseScope: componentReleaseScope(id),
      entryPath,
    }
  }
  await writeFile(
    join(output, `components-${platform}-${arch}.json`),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        appVersion: packaged.appVersion,
        platform,
        arch,
        components: componentAssets,
      },
      null,
      2
    )}\n`
  )
}

async function sha256(path) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

async function copyUpdateArtifacts(paths, includeBlockmap = true) {
  for (const path of new Set(paths)) {
    await cp(path, join(output, basename(path)))
    if (!includeBlockmap) continue
    const blockmap = `${path}.blockmap`
    await requireFile(blockmap)
    await cp(blockmap, join(output, basename(blockmap)))
  }
}

async function findFile(root, pattern) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isFile() && pattern.test(entry.name)) return join(root, entry.name)
  }
  throw new Error(`No file matching ${pattern} under ${root}`)
}

async function requireFile(path) {
  if (!(await stat(path).catch(() => null))?.isFile()) {
    throw new Error(`Required release file is missing: ${path}`)
  }
}

function escape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
