import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFile, cp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

import { hashComponentPath } from '../../../scripts/lib/component-content-hash.mjs'

const require = createRequire(new URL('../../../electron/package.json', import.meta.url))
const { buildBlockMap } = createRequire(require.resolve('electron-builder/package.json'))(
  'app-builder-lib/out/targets/blockmap/blockmap.js'
)
const { saveBaseline, readBaseline } = require('electron-updater/out/WeworkUpdateBaseline.js')
const TEST_TRAILER = Buffer.from('\nwework-e2e-corrupt-differential-update\n')

export async function createDesktopScenario({ homePath, resultDir, workbenchReadyTimeoutMs }) {
  assert.equal(process.platform, 'darwin', 'App update baseline E2E requires macOS')
  const appBinary = resolve(process.env.WEWORK_E2E_APP_BIN ?? '')
  const resourcesRoot = resolve(appBinary, '..', '..', 'Resources')
  const releaseRoot = resolve(resourcesRoot, '..', '..', '..', '..')
  const packagedComponents = JSON.parse(
    await readFile(join(resourcesRoot, 'components.json'), 'utf8')
  )
  const releaseAssets = await readdir(releaseRoot)
  const oldZipName = findSingle(
    releaseAssets,
    name => name === `WeWork_${packagedComponents.appVersion}_macos_arm64.zip`,
    'macOS arm64 ZIP'
  )
  const oldZip = join(releaseRoot, oldZipName)
  const oldBlockmap = `${oldZip}.blockmap`
  const oldBlockmapBytes = await readFile(oldBlockmap)
  const currentVersion = versionFromMacZip(oldZipName)
  const targetVersion = nextPatchVersion(currentVersion)
  const targetZipName = `WeWorkHostUpdate_${targetVersion}_macos_arm64.zip`
  const targetZip = join(resultDir, targetZipName)
  const targetBlockmap = `${targetZip}.blockmap`
  await cp(oldZip, targetZip)
  await appendFile(targetZip, TEST_TRAILER)
  const targetInfo = await buildBlockMap(targetZip, 'gzip', targetBlockmap)
  const targetZipBytes = await readFile(targetZip)
  const targetBlockmapBytes = await readFile(targetBlockmap)

  const appUpdateConfig = await readFile(join(resourcesRoot, 'app-update.yml'), 'utf8')
  const updaterCacheDirName = yamlScalar(appUpdateConfig, 'updaterCacheDirName')
  const updaterCache = join(homePath, 'Library', 'Caches', updaterCacheDirName)
  await rm(updaterCache, { recursive: true, force: true })
  await saveBaseline(updaterCache, oldZip, oldBlockmapBytes, {
    version: currentVersion,
    arch: 'arm64',
    url: `https://release.invalid/${oldZipName}`,
    sha512: createHash('sha512')
      .update(await readFile(oldZip))
      .digest('base64'),
  })

  let origin = ''
  const requests = []
  const componentManifest = await componentManifestForTarget(
    packagedComponents,
    resourcesRoot,
    targetVersion
  )
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? '/', origin).pathname)
    const range = request.headers.range ?? null
    requests.push({ method: request.method ?? 'GET', path, range })

    if (path === '/latest-mac.yml') {
      response.setHeader('content-type', 'text/yaml')
      response.end(
        [
          `version: ${targetVersion}`,
          'files:',
          `  - url: ${targetZipName}`,
          `    sha512: ${targetInfo.sha512}`,
          `    size: ${targetInfo.size}`,
          `path: ${targetZipName}`,
          `sha512: ${targetInfo.sha512}`,
          "releaseDate: '2026-09-07T00:00:00Z'",
          '',
        ].join('\n')
      )
      return
    }
    if (path === '/components-stable-macos-arm64.json') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(componentManifest))
      return
    }
    if (path === `/${targetZipName}.blockmap`) {
      sendBytes(response, targetBlockmapBytes, 'application/octet-stream')
      return
    }
    if (path === `/${oldZipName}.blockmap`) {
      response.statusCode = 500
      response.end('The updater must use the verified local baseline blockmap')
      return
    }
    if (path === `/${targetZipName}`) {
      if (!range) {
        sendBytes(response, targetZipBytes, 'application/zip')
        return
      }
      const parsed = parseSingleRange(range, targetZipBytes.length)
      if (!parsed) {
        response.statusCode = 416
        response.end()
        return
      }
      const body = Buffer.from(targetZipBytes.subarray(parsed.start, parsed.end + 1))
      body[0] ^= 1
      response.statusCode = 206
      response.setHeader('accept-ranges', 'bytes')
      response.setHeader(
        'content-range',
        `bytes ${parsed.start}-${parsed.end}/${targetZipBytes.length}`
      )
      sendBytes(response, body, 'application/zip')
      return
    }
    response.statusCode = 404
    response.end()
  })
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  origin = `http://127.0.0.1:${address.port}`

  return {
    usesReleasePackageRuntimeAssets: true,
    appEnvironment: { WEWORK_UPDATE_BASE_URL: origin },

    async verify(control) {
      await control.command('waitFor', '[data-testid="app-shell"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      const update = JSON.parse(await control.command('checkForAppUpdate', 'body'))
      assert.equal(update.version, targetVersion)
      await control.command('downloadPendingAppUpdate', 'body', { timeoutMs: 120_000 })

      const zipRequests = requests.filter(request => request.path === `/${targetZipName}`)
      assert.ok(
        zipRequests.some(request => request.range),
        'Expected differential ZIP ranges'
      )
      assert.equal(
        zipRequests.filter(request => !request.range).length,
        1,
        'A failed differential update must trigger exactly one full ZIP recovery'
      )
      assert.equal(
        requests.some(request => request.path === `/${oldZipName}.blockmap`),
        false,
        'The updater requested a guessed remote baseline blockmap'
      )
      assert.equal(
        requests.some(request => request.path.startsWith('/unused-')),
        false,
        'The updater downloaded an unchanged component'
      )

      const requestCount = requests.length
      await control.command('downloadPendingAppUpdate', 'body', { timeoutMs: 30_000 })
      assert.equal(requests.length, requestCount, 'A repeated download started a second transfer')

      const baselineRecord = JSON.parse(
        await readFile(join(updaterCache, 'wework-baseline.json'), 'utf8')
      )
      const cachedZipBytes = await readFile(join(updaterCache, 'update.zip'))
      const cachedBlockmapBytes = await readFile(join(updaterCache, 'current.blockmap'))
      const baselineDiagnostics = {
        record: baselineRecord,
        zipSha512: createHash('sha512').update(cachedZipBytes).digest('base64'),
        blockmapSha256: createHash('sha256').update(cachedBlockmapBytes).digest('hex'),
      }
      await writeFile(
        join(resultDir, 'app-update-baseline-cache.json'),
        JSON.stringify(baselineDiagnostics, null, 2)
      )
      assert.equal(baselineRecord.version, targetVersion)
      assert.equal(baselineDiagnostics.zipSha512, targetInfo.sha512)
      assert.equal(baselineDiagnostics.blockmapSha256, baselineRecord.blockmapSha256)
      const baseline = await readBaseline(updaterCache, 'arm64')
      assert.ok(baseline, 'The persisted update baseline did not pass integrity validation')
      assert.equal(baseline.record.version, targetVersion)
      assert.equal(baseline.record.sha512, targetInfo.sha512)

      const progress = JSON.parse(await control.command('getAppUpdateProgress', 'body'))
      assert.equal(progress.phase, 'ready')
      assert.equal(progress.mode, 'full')
      assert.equal(progress.reason, 'differential-failed')
      const transferredBytes = zipRequests.reduce(
        (total, request) =>
          total + (request.range ? rangeLength(request.range) : targetZipBytes.length),
        0
      )
      assert.equal(progress.downloadedBytes, transferredBytes)
      await writeFile(
        join(resultDir, 'app-update-baseline-requests.json'),
        JSON.stringify(requests, null, 2)
      )
    },

    async cleanup() {
      await new Promise(resolvePromise => server.close(resolvePromise))
      await rm(targetZip, { force: true })
      await rm(targetBlockmap, { force: true })
      await rm(updaterCache, { recursive: true, force: true })
    },

    diagnostics() {
      return {
        appUpdateCurrentVersion: currentVersion,
        appUpdateTargetVersion: targetVersion,
        appUpdateRequests: requests,
      }
    },
  }
}

async function componentManifestForTarget(packaged, resourcesRoot, targetVersion) {
  const components = await Promise.all(
    Object.entries(packaged.components)
      .filter(([id]) => id !== 'electron')
      .map(async ([id, component]) => {
        const contentSha256 = await hashComponentPath(join(resourcesRoot, component.path))
        return [
          id,
          {
            version: component.version,
            contentSha256,
            archiveSha256: contentSha256,
            archiveBytes: 1,
            downloadUrl: `http://unused.invalid/unused-${id}.tar.gz`,
            entryPath: '.',
          },
        ]
      })
  )
  return {
    schemaVersion: 1,
    appVersion: targetVersion,
    channel: 'stable',
    platform: 'macos',
    arch: 'arm64',
    components: Object.fromEntries(components),
  }
}

function findSingle(values, predicate, label) {
  const matches = values.filter(predicate)
  assert.equal(matches.length, 1, `Expected one ${label}, found: ${matches.join(', ') || 'none'}`)
  return matches[0]
}

function versionFromMacZip(name) {
  const match = /^WeWork_(.+)_macos_arm64\.zip$/.exec(name)
  assert.ok(match)
  return match[1]
}

function nextPatchVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version)
  assert.ok(match, `Unsupported application version: ${version}`)
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`
}

function yamlScalar(source, key) {
  const match = new RegExp(`^${key}:\\s*['"]?([^'"\\s]+)['"]?\\s*$`, 'm').exec(source)
  assert.ok(match, `Missing ${key} in app-update.yml`)
  return match[1]
}

function parseSingleRange(value, size) {
  const match = /^bytes=(\d+)-(\d+)$/.exec(value)
  if (!match) return null
  const start = Number(match[1])
  const end = Math.min(Number(match[2]), size - 1)
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) return null
  return { start, end }
}

function rangeLength(value) {
  const parsed = typeof value === 'string' ? /^bytes=(\d+)-(\d+)$/.exec(value) : null
  assert.ok(parsed, `Expected a single byte range, received: ${value}`)
  return Number(parsed[2]) - Number(parsed[1]) + 1
}

function sendBytes(response, bytes, contentType) {
  response.setHeader('content-type', contentType)
  response.setHeader('content-length', String(bytes.length))
  response.end(bytes)
}
