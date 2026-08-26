import { realpathSync } from 'node:fs'
import path from 'node:path'

export function normalizeFileViewerAssetManifest(manifest, outputRoot) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new TypeError('File viewer asset manifest must be an object')
  }
  const assets = Array.isArray(manifest.assets)
    ? manifest.assets.map(asset => normalizeAsset(asset, outputRoot))
    : []
  return {
    ...manifest,
    copiedAt: '1970-01-01T00:00:00.000Z',
    assets,
  }
}

function normalizeAsset(asset, outputRoot) {
  if (!asset || typeof asset !== 'object' || Array.isArray(asset)) return asset
  if (typeof asset.to !== 'string') return asset
  const relative = path.relative(canonicalPath(outputRoot), canonicalPath(asset.to))
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`File viewer asset is outside the DSH app output: ${asset.to}`)
  }
  return {
    ...asset,
    to: relative.split(path.sep).join('/'),
  }
}

function canonicalPath(filePath) {
  try {
    return realpathSync.native(filePath)
  } catch (error) {
    if (error?.code === 'ENOENT') return path.resolve(filePath)
    throw error
  }
}
