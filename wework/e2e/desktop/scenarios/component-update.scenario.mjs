import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'

const MARKER_NAME = 'e2e-component-update.marker'

export async function createDesktopScenario({
  electronUserDataDirectory,
  resultDir,
  workbenchReadyTimeoutMs,
}) {
  const appBinary = resolve(process.env.WEWORK_E2E_APP_BIN ?? '')
  const resourcesRoot = resolveResourcesRoot(appBinary)
  const packaged = JSON.parse(await readFile(join(resourcesRoot, 'components.json'), 'utf8'))
  assert.ok(
    packaged.channel === 'stable' || packaged.channel === 'beta',
    `Packaged component channel is invalid: ${packaged.channel}`
  )
  if (process.env.WEWORK_E2E_REQUIRE_RELEASE_PACKAGE === '1') {
    assert.match(appBinary, /release-installer/)
  }

  const source = join(resultDir, 'component-update-source')
  const archive = join(resultDir, 'component-update.tar.gz')
  await cp(join(resourcesRoot, packaged.components.weworkCorePlugins.path), source, {
    recursive: true,
  })
  await writeFile(join(source, MARKER_NAME), 'component update activated\n')
  await createTarArchive(source, archive)
  const archiveBytes = await readFile(archive)
  const archiveSha256 = sha256(archiveBytes)
  const contentSha256 = await hashTree(source)
  const target = componentTarget(process.platform, process.arch)
  const assetName = `WeworkComponent_weworkCorePlugins_${archiveSha256}_${target.platform}_${target.arch}.tar.gz`
  let origin = ''
  const components = Object.fromEntries(
    Object.entries(packaged.components)
      .filter(([id]) => id !== 'electron')
      .map(([id, component]) => [
        id,
        id === 'weworkCorePlugins'
          ? {
              version: `${component.version}-e2e`,
              contentSha256,
              archiveSha256,
              archiveBytes: archiveBytes.length,
              downloadUrl: '',
              entryPath: '.',
            }
          : {
              version: component.version,
              contentSha256: component.sha256,
              archiveSha256: '0'.repeat(64),
              archiveBytes: 1,
              downloadUrl: '',
              entryPath: '.',
            },
      ])
  )
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', origin).pathname
    if (path === `/components-${packaged.channel}-${target.platform}-${target.arch}.json`) {
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          schemaVersion: 1,
          appVersion: packaged.appVersion,
          channel: packaged.channel,
          platform: target.platform,
          arch: target.arch,
          components,
        })
      )
      return
    }
    if (path === `/${assetName}`) {
      response.setHeader('content-type', 'application/gzip')
      response.setHeader('content-length', String(archiveBytes.length))
      response.end(archiveBytes)
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
  for (const component of Object.values(components)) {
    component.downloadUrl =
      component === components.weworkCorePlugins
        ? `${origin}/${assetName}`
        : `${origin}/unused.tar.gz`
  }

  let restartDesktopApp
  return {
    usesReleasePackageRuntimeAssets: true,
    appEnvironment: {
      WEWORK_E2E_DISABLE_COMPONENT_UPDATES: '0',
      WEWORK_UPDATE_BASE_URL: origin,
    },

    setRestartDesktopApp(restart) {
      restartDesktopApp = restart
    },

    async verify(control) {
      await control.command('waitFor', '[data-testid="app-shell"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      const statePath = join(electronUserDataDirectory, 'managed-components', 'state.json')
      await waitFor(async () => {
        const state = await readJson(statePath)
        return state.pending?.components?.weworkCorePlugins?.contentSha256 === contentSha256
      }, 'The component update was not staged')

      assert.equal(typeof restartDesktopApp, 'function')
      await restartDesktopApp()
      await control.command('waitFor', '[data-testid="app-shell"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      const state = await waitFor(async () => {
        const candidate = await readJson(statePath)
        return candidate.current?.components?.weworkCorePlugins?.contentSha256 === contentSha256 &&
          candidate.activationInProgress !== true
          ? candidate
          : null
      }, 'The component update was not confirmed after restart')
      assert.equal(state.pending, undefined)
      await readFile(
        join(
          electronUserDataDirectory,
          'managed-components',
          'blobs',
          'weworkCorePlugins',
          archiveSha256,
          MARKER_NAME
        ),
        'utf8'
      )
      const appLog = await readFile(join(resultDir, 'app.log'), 'utf8')
      assert.doesNotMatch(appLog, /\[runtime\] startup failed/)
      assert.match(appLog, /\[components\] update staged for the next application restart/)
    },

    async cleanup() {
      await new Promise(resolvePromise => server.close(resolvePromise))
      await rm(source, { recursive: true, force: true })
    },

    diagnostics() {
      return {
        componentUpdateActivated: true,
        componentUpdateContentSha256: contentSha256,
      }
    },
  }
}

function resolveResourcesRoot(appBinary) {
  if (process.platform === 'darwin') return resolve(appBinary, '..', '..', 'Resources')
  return resolve(appBinary, '..', 'resources')
}

function componentTarget(platform, arch) {
  const targetPlatform =
    platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : 'linux'
  assert.ok(arch === 'arm64' || arch === 'x64')
  return { platform: targetPlatform, arch }
}

async function waitFor(predicate, message, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate().catch(() => null)
    if (value) return value
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(message)
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function hashTree(root, relative = '') {
  const hash = createHash('sha256')
  const entries = await readdir(join(root, relative), { withFileTypes: true })
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = join(relative, entry.name)
    if (entry.isDirectory()) {
      hash.update(`directory:${child}\0${await hashTree(root, child)}\0`)
    } else if (entry.isFile()) {
      hash.update(`file:${child}\0${await fileSha256(join(root, child))}\0`)
    } else {
      throw new Error(`Unsupported component entry: ${child}`)
    }
  }
  return hash.digest('hex')
}

async function fileSha256(path) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function createTarArchive(source, archive) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('tar', ['-czf', archive, '-C', source, '.'], {
      env: {
        ...process.env,
        COPYFILE_DISABLE: '1',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => {
      stderr += chunk
    })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolvePromise()
      else reject(new Error(`tar exited with code ${code ?? 'unknown'}: ${stderr.trim()}`))
    })
  })
}
