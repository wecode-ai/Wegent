#!/usr/bin/env node

import { desktopComponentIds, sharedDesktopComponentIds } from './lib/desktop-component-ids.mjs'

const [releaseBaseUrlInput, sharedBaseUrlInput, version, channel, platform, arch] =
  process.argv.slice(2)

if (!releaseBaseUrlInput || !sharedBaseUrlInput || !version || !channel || !platform || !arch) {
  throw new Error(
    'Usage: verify-minio-component-release.mjs <release-base-url> <shared-component-base-url> <version> <stable|beta> <platform> <arch>'
  )
}
if (channel !== 'stable' && channel !== 'beta') {
  throw new Error(`Unsupported Wework update channel: ${channel}`)
}

const releaseBaseUrl = normalizedBaseUrl(releaseBaseUrlInput)
const sharedBaseUrl = normalizedBaseUrl(sharedBaseUrlInput)
const sharedComponentIds = new Set(sharedDesktopComponentIds)
const manifestUrl = new URL(`components-${channel}-${platform}-${arch}.json`, releaseBaseUrl)
const response = await fetch(manifestUrl, { cache: 'no-store' })
if (!response.ok) {
  throw new Error(`Component manifest is not publicly readable: HTTP ${response.status}`)
}
const manifest = await response.json()
if (
  manifest?.schemaVersion !== 1 ||
  manifest?.appVersion !== version ||
  manifest?.channel !== channel ||
  manifest?.platform !== platform ||
  manifest?.arch !== arch ||
  !manifest?.components ||
  Object.keys(manifest.components).sort().join(',') !== desktopComponentIds.slice().sort().join(',')
) {
  throw new Error(`Published component manifest is incompatible: ${manifestUrl}`)
}

for (const id of desktopComponentIds) {
  const component = manifest.components[id]
  if (
    typeof component?.downloadUrl !== 'string' ||
    !Number.isSafeInteger(component.archiveBytes) ||
    component.archiveBytes <= 0 ||
    !/^[0-9a-f]{64}$/.test(component.archiveSha256)
  ) {
    throw new Error(`Published component entry is invalid: ${id}`)
  }
  const downloadUrl = new URL(component.downloadUrl)
  const expectedBaseUrl = sharedComponentIds.has(id) ? sharedBaseUrl : releaseBaseUrl
  if (
    downloadUrl.origin !== expectedBaseUrl.origin ||
    !downloadUrl.pathname.startsWith(expectedBaseUrl.pathname)
  ) {
    throw new Error(`Published component URL is outside its MinIO storage prefix: ${id}`)
  }
  const archive = await fetch(downloadUrl, { method: 'HEAD', cache: 'no-store' })
  if (!archive.ok) {
    throw new Error(`Component archive is not publicly readable: ${id} HTTP ${archive.status}`)
  }
  const contentLength = Number(archive.headers.get('content-length'))
  if (contentLength !== component.archiveBytes) {
    throw new Error(`Published component archive size mismatch: ${id}`)
  }
}

console.log(`Verified MinIO component release: ${version} ${channel} ${platform}-${arch}`)

function normalizedBaseUrl(input) {
  return new URL(`${input.replace(/\/+$/, '')}/`)
}
