import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'

export function packagedResourcesRoot(appBinary) {
  return resolve(
    dirname(appBinary),
    ...(process.platform === 'darwin' ? ['..', 'Resources'] : ['resources'])
  )
}

export async function preparePackagedHarnessRuntimes(appBinary, runtimeRoot) {
  const resourceRoot = join(packagedResourcesRoot(appBinary), 'harness-runtime')
  const catalog = JSON.parse(await readFile(join(resourceRoot, 'runtimes.json'), 'utf8'))
  const runtimes = catalog.runtimes.filter(runtime => ['core', 'workbench'].includes(runtime.role))
  if (!['core', 'workbench'].every(role => runtimes.some(runtime => runtime.role === role))) {
    throw new Error('Bundled Electron runtime catalog must contain Core and Workbench runtimes')
  }
  await mkdir(runtimeRoot, { recursive: true })
  for (const runtime of runtimes) {
    if (runtime.bundled === false) continue
    if (
      !/^[0-9a-f]{64}$/.test(runtime.sourceFingerprint) ||
      !/^[0-9a-f]{64}$/.test(runtime.archiveSha256) ||
      !Number.isSafeInteger(runtime.archiveBytes) ||
      runtime.archiveBytes <= 0 ||
      typeof runtime.assetName !== 'string' ||
      basename(runtime.assetName) !== runtime.assetName ||
      !runtime.assetName.endsWith('.tar.gz') ||
      (runtime.directory !== undefined && runtime.directory !== runtime.sourceFingerprint)
    ) {
      throw new Error('Bundled Electron runtime descriptor is invalid')
    }
    const extracted = join(runtimeRoot, runtime.sourceFingerprint)
    if (runtime.directory) {
      await symlink(
        join(resourceRoot, runtime.directory),
        extracted,
        process.platform === 'win32' ? 'junction' : 'dir'
      )
    } else {
      const archive = join(resourceRoot, runtime.assetName)
      if ((await stat(archive)).size !== runtime.archiveBytes) {
        throw new Error(`Bundled DSH runtime size mismatch: ${runtime.assetName}`)
      }
      const hash = createHash('sha256')
      await pipeline(createReadStream(archive), hash)
      if (hash.digest('hex') !== runtime.archiveSha256) {
        throw new Error(`Bundled DSH runtime checksum mismatch: ${runtime.assetName}`)
      }
      await mkdir(extracted, { recursive: true })
      await promisify(execFile)('tar', ['-xzf', archive, '-C', extracted])
    }
    const identity = JSON.parse(await readFile(join(extracted, 'runtime.json'), 'utf8'))
    if (
      identity.dshVersion !== runtime.dshVersion ||
      identity.role !== runtime.role ||
      identity.sourceFingerprint !== runtime.sourceFingerprint
    ) {
      throw new Error(`Bundled DSH runtime identity is invalid: ${runtime.assetName}`)
    }
    await readFile(join(extracted, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  }
  await writeFile(join(runtimeRoot, 'runtimes.json'), `${JSON.stringify({ runtimes }, null, 2)}\n`)
  return runtimeRoot
}

// Deliver the actual build artifact over HTTP, including its production checksum and layout.
export async function serveHarnessRuntimeAsset(request, response, url, assetDirectory) {
  if (!url.pathname.startsWith('/dsh-runtime-assets/')) return false
  const { resolveSharedHarnessRuntimeAssetCacheRoot } =
    await import('../../../scripts/lib/harness-runtime-cache.mjs')
  const assetName = url.pathname.slice('/dsh-runtime-assets/'.length)
  if (request.method !== 'GET' || !/^[a-zA-Z0-9._-]+\.tar\.gz$/.test(assetName)) {
    response.writeHead(400)
    response.end('Invalid runtime asset request')
    return true
  }
  const path = join(
    assetDirectory ?? join(resolveSharedHarnessRuntimeAssetCacheRoot(), 'harness-runtime-assets'),
    assetName
  )
  const metadata = await stat(path)
  response.writeHead(200, {
    'content-type': 'application/gzip',
    'content-length': metadata.size,
  })
  await pipeline(createReadStream(path), response)
  return true
}
