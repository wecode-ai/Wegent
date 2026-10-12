import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFile, cp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'

import { hashComponentPath } from '../../../scripts/lib/component-content-hash.mjs'

const TEST_TRAILER = Buffer.from('\nwework-e2e-full-update\n')
const UPDATE_CHANNEL = 'stable'

export async function createDesktopScenario({ homePath, resultDir, workbenchReadyTimeoutMs }) {
  assert.equal(process.platform, 'darwin', 'App full update E2E requires macOS')
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
  const currentVersion = versionFromMacZip(oldZipName)
  const targetVersion = nextPatchVersion(currentVersion)
  const targetZipName = `WeWorkHostUpdate_${targetVersion}_macos_arm64.zip`
  const targetZip = join(resultDir, targetZipName)
  await cp(join(releaseRoot, oldZipName), targetZip)
  await appendFile(targetZip, TEST_TRAILER)
  const targetZipBytes = await readFile(targetZip)
  const targetSha512 = createHash('sha512').update(targetZipBytes).digest('base64')

  const appUpdateConfig = await readFile(join(resourcesRoot, 'app-update.yml'), 'utf8')
  const updaterCacheDirName = yamlScalar(appUpdateConfig, 'updaterCacheDirName')
  const updaterCache = join(homePath, 'Library', 'Caches', updaterCacheDirName)
  await rm(updaterCache, { recursive: true, force: true })

  let origin = ''
  let componentManifest
  const requests = []
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
          `    sha512: ${targetSha512}`,
          `    size: ${targetZipBytes.length}`,
          `path: ${targetZipName}`,
          `sha512: ${targetSha512}`,
          `releaseDate: '${new Date().toISOString()}'`,
          '',
        ].join('\n')
      )
      return
    }
    if (path === `/components-${UPDATE_CHANNEL}-macos-arm64.json`) {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(componentManifest))
      return
    }
    if (path.endsWith('.blockmap')) {
      response.statusCode = 500
      response.end('Full updates must not request blockmaps')
      return
    }
    if (path === `/${targetZipName}`) {
      if (range) {
        response.statusCode = 500
        response.end('Full updates must not request byte ranges')
        return
      }
      sendBytes(response, targetZipBytes, 'application/zip')
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
  componentManifest = await componentManifestForTarget(
    packagedComponents,
    resourcesRoot,
    targetVersion,
    origin
  )

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
      assert.equal(zipRequests.length, 1, 'The updater must download the Host ZIP exactly once')
      assert.equal(zipRequests[0].range, null, 'The Host update must use one full request')
      assert.equal(
        requests.some(request => request.path.endsWith('.blockmap')),
        false,
        'The updater requested a blockmap after differential updates were disabled'
      )
      assert.equal(
        requests.some(request => request.path.startsWith('/unused-')),
        false,
        'The updater downloaded an unchanged packaged component'
      )

      const requestCount = requests.length
      await control.command('downloadPendingAppUpdate', 'body', { timeoutMs: 30_000 })
      assert.equal(requests.length, requestCount, 'A repeated download started a second transfer')

      for (const name of ['update.zip', 'current.blockmap', 'wework-baseline.json']) {
        assert.equal(
          await stat(join(updaterCache, name))
            .then(() => true)
            .catch(() => false),
          false,
          `The updater retained obsolete differential state: ${name}`
        )
      }

      const progress = JSON.parse(await control.command('getAppUpdateProgress', 'body'))
      assert.equal(progress.phase, 'ready')
      assert.equal(progress.downloadedBytes, targetZipBytes.length)
      assert.equal(progress.totalBytes, targetZipBytes.length)
      assert.equal(progress.mode, undefined)
      assert.equal(progress.reason, undefined)
    },

    async cleanup() {
      await new Promise(resolvePromise => server.close(resolvePromise))
      await rm(targetZip, { force: true })
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

function sendBytes(response, bytes, contentType) {
  response.setHeader('content-type', contentType)
  response.setHeader('content-length', String(bytes.length))
  response.end(bytes)
}
