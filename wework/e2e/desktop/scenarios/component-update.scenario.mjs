import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'

import { hashComponentPath } from '../../../scripts/lib/component-content-hash.mjs'
import { resolveDesktopPackageLayout } from '../modules/desktop-package-layout.mjs'

const MARKER_NAME = join('e2e-component-update', 'nested', 'marker.txt')

export async function createDesktopScenario({
  electronUserDataDirectory,
  resultDir,
  workbenchReadyTimeoutMs,
}) {
  const appBinary = resolve(process.env.WEWORK_E2E_APP_BIN ?? '')
  const { resourcesRoot } = await resolveDesktopPackageLayout(appBinary)
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
  await mkdir(dirname(join(source, MARKER_NAME)), { recursive: true })
  await writeFile(join(source, MARKER_NAME), 'component update activated\n')
  await createTarArchive(source, archive)
  const archiveBytes = await readFile(archive)
  const archiveSha256 = sha256(archiveBytes)
  const contentSha256 = await hashComponentPath(source)
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
  const requests = []
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', origin).pathname
    requests.push(path)
    if (
      path === '/latest-mac.yml' ||
      path === '/beta-mac.yml' ||
      path === '/latest.yml' ||
      path === '/beta.yml'
    ) {
      response.setHeader('content-type', 'text/yaml')
      response.end(
        `version: ${packaged.appVersion}\nfiles:\n  - url: unused.zip\n    sha512: ${Buffer.alloc(64).toString('base64')}\n    size: 1\npath: unused.zip\nsha512: ${Buffer.alloc(64).toString('base64')}\n`
      )
      return
    }
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
      const originalState = await readJson(statePath)
      assert.equal(
        originalState.pending,
        undefined,
        'Startup staged a same-version component update'
      )
      if (process.platform === 'linux') {
        await assert.rejects(
          control.command('checkForAppUpdate', 'body'),
          /Wework updater is not available on Linux/
        )
      } else {
        const check = JSON.parse(await control.command('checkForAppUpdate', 'body'))
        assert.equal(check, null, 'A same-version release must not be offered as an app update')
      }
      assert.equal(
        requests.some(path => path.startsWith('/components-')),
        false,
        'Checking the app version independently fetched a component update'
      )
      assert.equal(
        requests.includes(`/${assetName}`),
        false,
        'Startup downloaded changed code without a new application version'
      )
      for (const [id, component] of Object.entries(packaged.components)) {
        if (id === 'electron') continue
        assert.equal(
          await hashComponentPath(join(resourcesRoot, component.path)),
          component.sha256,
          `The installed ${id} content must match its versioned packaged manifest`
        )
      }
      assert.equal(typeof restartDesktopApp, 'function')
      await restartDesktopApp()
      await control.command('waitFor', '[data-testid="app-shell"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      const state = await readJson(statePath)
      assert.equal(state.pending, undefined, 'Restart staged an unversioned update')
      assert.deepEqual(
        state.current,
        originalState.current,
        'Restart activated different code for the same app version'
      )
      assert.equal(
        requests.some(path => path.startsWith('/components-')),
        false,
        'Restart independently checked for component updates'
      )
      const appLog = await readFile(join(resultDir, 'app.log'), 'utf8')
      assert.doesNotMatch(appLog, /\[runtime\] startup failed/)
      assert.doesNotMatch(appLog, /\[components\] update staged for the next application restart/)
    },

    async cleanup() {
      await new Promise(resolvePromise => server.close(resolvePromise))
      await rm(source, { recursive: true, force: true })
    },

    diagnostics() {
      return {
        sameVersionComponentUpdateRejected: true,
        componentUpdateRequests: requests,
        componentUpdateContentSha256: contentSha256,
      }
    },
  }
}

function componentTarget(platform, arch) {
  const targetPlatform =
    platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : 'linux'
  assert.ok(arch === 'arm64' || arch === 'x64')
  return { platform: targetPlatform, arch }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw error
  }
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
