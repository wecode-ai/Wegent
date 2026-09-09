import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

import { componentReleaseScope } from '../desktop-component-release.mjs'

export async function loadPreviousComponentManifest(path, platform, arch) {
  if (!path) return null
  try {
    const manifest = JSON.parse(await readFile(resolve(path), 'utf8'))
    if (
      manifest?.schemaVersion !== 1 ||
      manifest?.platform !== platform ||
      manifest?.arch !== arch ||
      typeof manifest?.components !== 'object'
    ) {
      throw new Error('metadata does not match the requested target')
    }
    return manifest
  } catch (error) {
    throw new Error(`Invalid previous component manifest ${path}: ${error.message}`)
  }
}

export function resolveReusableComponent({
  arch,
  component,
  contentSha256,
  entryPath,
  id,
  platform,
  previousManifest,
}) {
  const previous = previousManifest?.components?.[id]
  if (!previous || previous.contentSha256 !== contentSha256) return null
  if (
    !/^[0-9a-f]{64}$/.test(previous.archiveSha256) ||
    !Number.isSafeInteger(previous.archiveBytes) ||
    previous.archiveBytes <= 0 ||
    typeof previous.downloadUrl !== 'string' ||
    previous.entryPath !== entryPath
  ) {
    throw new Error(`Reusable component metadata is invalid: ${id}`)
  }
  const assetName = basename(decodeURIComponent(new URL(previous.downloadUrl).pathname))
  const expectedSuffix = `_${platform}_${arch}.tar.gz`
  if (!assetName.startsWith(`WeworkComponent_${id}_`) || !assetName.endsWith(expectedSuffix)) {
    throw new Error(`Reusable component asset name is invalid: ${assetName}`)
  }
  return {
    version: component.version,
    contentSha256,
    archiveSha256: previous.archiveSha256,
    archiveBytes: previous.archiveBytes,
    assetName,
    releaseScope: componentReleaseScope(id),
    entryPath,
    downloadUrl: previous.downloadUrl,
    reused: true,
  }
}
