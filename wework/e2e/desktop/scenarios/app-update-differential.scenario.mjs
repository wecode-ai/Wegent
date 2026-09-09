import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFile, cp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { hashComponentPath } from '../../../scripts/lib/component-content-hash.mjs'

const TEST_TRAILER = Buffer.from('\nwework-e2e-differential-update\n')
const UPDATE_CHANNEL = 'stable'
const electronPackage = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'electron',
  'package.json'
)

export async function createDesktopScenario({
  electronUserDataDirectory,
  homePath,
  resultDir,
  uiTimeoutMs,
  workbenchReadyTimeoutMs,
}) {
  assert.equal(process.platform, 'darwin', 'App differential update E2E requires macOS')
  const appBinary = resolve(process.env.WEWORK_E2E_APP_BIN ?? '')
  if (process.env.WEWORK_E2E_REQUIRE_RELEASE_PACKAGE === '1') {
    assert.match(appBinary, /release-installer/)
  }

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
  await readFile(oldBlockmap)

  const currentVersion = versionFromMacZip(oldZipName)
  const targetVersion = nextPatchVersion(currentVersion)
  const targetZipName = `WeWorkHostUpdate_${targetVersion}_macos_arm64.zip`
  const targetZip = join(resultDir, targetZipName)
  const targetBlockmap = `${targetZip}.blockmap`
  await cp(oldZip, targetZip)
  await appendFile(targetZip, TEST_TRAILER)
  const { buildBlockMap } = loadBlockmapBuilder()
  const updateInfo = await buildBlockMap(targetZip, 'gzip', targetBlockmap)
  const targetZipBytes = await readFile(targetZip)
  const targetBlockmapBytes = await readFile(targetBlockmap)
  const oldBlockmapBytes = await readFile(oldBlockmap)

  const appUpdateConfig = await readFile(join(resourcesRoot, 'app-update.yml'), 'utf8')
  const updaterCacheDirName = yamlScalar(appUpdateConfig, 'updaterCacheDirName')
  const updaterCache = join(homePath, 'Library', 'Caches', updaterCacheDirName)
  const appUpdateLogs = await captureAppUpdateLogs(electronUserDataDirectory)
  await rm(updaterCache, { recursive: true, force: true })
  await mkdir(updaterCache, { recursive: true })
  const electronRequire = createRequire(electronPackage)
  const { saveBaseline } = electronRequire('electron-updater/out/WeworkUpdateBaseline.js')
  await saveBaseline(updaterCache, oldZip, oldBlockmapBytes, {
    version: currentVersion,
    arch: 'arm64',
    url: `https://release.invalid/${oldZipName}`,
    sha512: createHash('sha512')
      .update(await readFile(oldZip))
      .digest('base64'),
  })

  let origin = ''
  let rejectManifest = true
  let targetComponentManifest
  const requests = []
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', origin)
    const path = decodeURIComponent(url.pathname)
    const range = request.headers.range ?? null
    requests.push({ method: request.method ?? 'GET', path, range })

    if (path === '/latest-mac.yml') {
      if (rejectManifest) {
        response.statusCode = 503
        response.setHeader('content-type', 'text/html')
        response.end(
          '<!doctype html><style>body{color:red}</style><body>SGErrorDomain EOF https://internal.example/update</body>'
        )
        return
      }
      const manifest = [
        `version: ${targetVersion}`,
        'files:',
        `  - url: ${targetZipName}`,
        `    sha512: ${updateInfo.sha512}`,
        `    size: ${updateInfo.size}`,
        `path: ${targetZipName}`,
        `sha512: ${updateInfo.sha512}`,
        `releaseDate: '${new Date().toISOString()}'`,
        '',
      ].join('\n')
      response.setHeader('content-type', 'text/yaml')
      response.end(manifest)
      return
    }
    if (path === `/components-${UPDATE_CHANNEL}-macos-arm64.json`) {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(targetComponentManifest))
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
        response.statusCode = 500
        response.end('Full ZIP downloads are forbidden by this E2E')
        return
      }
      const parsed = parseSingleRange(range, targetZipBytes.length)
      if (!parsed) {
        response.statusCode = 416
        response.end()
        return
      }
      const body = targetZipBytes.subarray(parsed.start, parsed.end + 1)
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
  targetComponentManifest = await componentManifestForTarget(
    packagedComponents,
    resourcesRoot,
    targetVersion,
    origin
  )

  return {
    usesReleasePackageRuntimeAssets: true,
    appEnvironment: {
      WEWORK_UPDATE_BASE_URL: origin,
    },

    async verify(control) {
      await control.command('waitFor', '[data-testid="app-shell"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      const shellSnapshot = JSON.parse(await control.command('snapshot', 'body'))
      if (shellSnapshot.testIds.includes('desktop-sidebar-hover-edge')) {
        await control.command('toggleSidebar', 'body')
        await control.command('waitFor', '[data-testid="desktop-sidebar"]', {
          timeoutMs: uiTimeoutMs,
        })
      }
      await control.command('click', '[data-testid="settings-button"]')
      await control.command('click', '[data-testid="check-app-update-button"]')
      await control.command('waitFor', '[data-testid="app-update-error-details-button"]', {
        timeoutMs: uiTimeoutMs,
      })
      const compactError = await control.command('getText', '[data-testid="app-update-status"]')
      assert.match(compactError, /网络不可用|Network unavailable/)
      assert.doesNotMatch(compactError, /<!doctype|<style|internal\.example/)

      await control.command('click', '[data-testid="app-update-error-details-button"]')
      await control.command('waitFor', '[data-testid="app-update-error-dialog"]', {
        timeoutMs: uiTimeoutMs,
      })
      const errorDetails = await control.command(
        'getText',
        '[data-testid="app-update-error-dialog"]'
      )
      assert.match(errorDetails, /APP_UPDATE_NETWORK_UNAVAILABLE/)
      assert.doesNotMatch(errorDetails, /<!doctype|<style|internal\.example/)

      rejectManifest = false
      await control.command('click', '[data-testid="app-update-error-retry"]')
      await waitFor(async () => {
        const label = await control.command('getText', '[data-testid="check-app-update-button"]')
        return label.includes(targetVersion)
      }, `The app update ${targetVersion} was not discovered`)
      await control.command('downloadPendingAppUpdate', 'body', {
        timeoutMs: Math.max(uiTimeoutMs, 120_000),
      })

      const componentState = JSON.parse(
        await readFile(join(electronUserDataDirectory, 'managed-components', 'state.json'), 'utf8')
      )
      assert.equal(componentState.pending?.appVersion, targetVersion)
      assert.equal(componentState.pending?.stagedFromAppVersion, currentVersion)

      const componentManifestPath = `/components-${UPDATE_CHANNEL}-macos-arm64.json`
      const componentManifestRequestIndex = requests.findIndex(
        request => request.path === componentManifestPath
      )
      const firstZipRequestIndex = requests.findIndex(
        request => request.path === `/${targetZipName}`
      )
      assert.notEqual(
        componentManifestRequestIndex,
        -1,
        'The target app component manifest was never requested'
      )
      assert.notEqual(firstZipRequestIndex, -1, 'The target ZIP was never requested')
      assert.ok(
        componentManifestRequestIndex < firstZipRequestIndex,
        'The target app component manifest was not staged before the ZIP download'
      )
      assert.equal(
        requests.some(request => request.path.startsWith('/unused-')),
        false,
        'The updater downloaded an unchanged packaged component'
      )
      const zipRequests = requests.filter(request => request.path === `/${targetZipName}`)
      assert.ok(
        zipRequests.some(request => request.range),
        'The updater did not request any ZIP byte ranges'
      )
      assert.equal(
        zipRequests.some(request => !request.range),
        false,
        'The updater fell back to a full ZIP download'
      )
      assert.equal(
        requests.some(request => request.path === `/${oldZipName}.blockmap`),
        false,
        'The updater requested a guessed remote baseline blockmap'
      )
      const downloadedBytes = zipRequests.reduce(
        (total, request) => total + rangeLength(request.range),
        0
      )
      assert.ok(
        downloadedBytes < targetZipBytes.length,
        `Differential download transferred ${downloadedBytes} bytes for a ${targetZipBytes.length}-byte ZIP`
      )

      const updateLog = await waitForAppUpdateLog(appUpdateLogs)
      assert.match(updateLog, /Full: .+ To download: .+ \(\d+%\)/)
      assert.doesNotMatch(updateLog, /fallback to full download/i)
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

async function componentManifestForTarget(packaged, resourcesRoot, targetVersion, origin) {
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
            downloadUrl: `${origin}/unused-${id}.tar.gz`,
            entryPath: '.',
          },
        ]
      })
  )
  return {
    schemaVersion: 1,
    appVersion: targetVersion,
    channel: UPDATE_CHANNEL,
    platform: 'macos',
    arch: 'arm64',
    components: Object.fromEntries(components),
  }
}

function loadBlockmapBuilder() {
  const electronRequire = createRequire(electronPackage)
  const electronBuilderPackage = electronRequire.resolve('electron-builder/package.json')
  return createRequire(electronBuilderPackage)('app-builder-lib/out/targets/blockmap/blockmap.js')
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

async function waitFor(predicate, message, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate().catch(() => false)) return
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(message)
}

async function captureAppUpdateLogs(electronUserDataDirectory) {
  const path = join(electronUserDataDirectory, 'logs', 'app-update.log')
  return [
    {
      path,
      offset: await stat(path)
        .then(value => value.size)
        .catch(() => 0),
    },
  ]
}

async function waitForAppUpdateLog(candidates) {
  let found = ''
  await waitFor(
    async () => {
      for (const candidate of candidates) {
        const bytes = await readFile(candidate.path).catch(() => Buffer.alloc(0))
        const offset = bytes.length >= candidate.offset ? candidate.offset : 0
        const contents = bytes.subarray(offset).toString('utf8')
        if (contents.includes('To download:')) {
          found = contents
          return true
        }
      }
      return false
    },
    `Updater differential diagnostics were not written to ${candidates
      .map(candidate => candidate.path)
      .join(' or ')}`
  )
  return found
}
