import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { hashReleaseAsset } from '../../../scripts/lib/portable-desktop-release.mjs'
import { compareVersions } from '../../../electron/src/runtime/upgrade-policy.mjs'
import { ACTIVE_COMPOSER_SELECTOR, createSingleRootLocalProject } from '../modules/shared.mjs'
import { UPGRADE_SUITE_VERSION } from '../upgrade-suite.mjs'
import { waitForUpdatePreparation } from '../modules/update-preparation-progress.mjs'
import {
  assistantMessage,
  createSse,
  handleEmptyReplyPrediction,
  readRequestBody,
  responseCreated,
  responseCompleted,
} from '../modules/response-protocol.mjs'

const PROMPT = 'WEWORK_UPGRADE_PERSISTENCE'
const ANSWER = 'WEWORK_UPGRADE_REAL_RUNTIME_OK'
const STORAGE_KEY = 'wework:upgrade-regression-marker'
const OPTIONAL_PLUGIN = '@wegent/dsh-connection-dingtalk'

async function waitForInterruptedRollback(root) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    let marker
    try {
      marker = await readFile(join(root, 'rollback-interrupted'), 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (marker) {
      const pid = Number(await readFile(join(root, 'active-pid'), 'utf8'))
      assert.ok(pid > 0)
      try {
        process.kill(pid, 0)
      } catch (error) {
        if (error.code === 'ESRCH') return
        throw error
      }
    }
    await new Promise(accept => setTimeout(accept, 50))
  }
  assert.fail('The real target did not terminate after recording manual rollback')
}

/** One reusable flow for fixed A -> B pairs. Version numbers never select assertions. */
export async function createDesktopScenario(options) {
  const {
    checkpoint,
    electronUserDataDirectory,
    resultDir,
    restartDesktopApp,
    workbenchReadyTimeoutMs,
    workspacePath,
  } = options
  const pairFile = process.env.WEWORK_E2E_UPGRADE_PAIR
  assert.ok(pairFile, 'Upgrade checkpoints require an independently built source/target pair')
  const pair = JSON.parse(await readFile(pairFile, 'utf8'))
  assert.equal(pair.schemaVersion, 1)
  assert.equal(
    pair.suiteVersion,
    UPGRADE_SUITE_VERSION,
    'Rebuild the pair for the current acceptance contract'
  )
  assert.ok(
    compareVersions(pair.to.version, pair.from.version) > 0,
    'Target must be newer than source'
  )
  for (const asset of [pair.from, pair.to]) {
    assert.equal(
      await hashReleaseAsset(asset.path),
      asset.sha256,
      'The actual release archive changed'
    )
    assert.equal((await stat(asset.path)).size, asset.bytes)
  }
  const channel = pair.channel || (pair.to.version.includes('-beta.') ? 'beta' : 'stable')
  let control
  let passed = false
  let origin
  let modelRequests = 0
  const requests = []
  const server = createServer((request, response) => {
    const url = new URL(request.url, origin)
    requests.push({
      path: url.pathname,
      method: request.method,
      range: request.headers.range ?? null,
    })
    if (url.pathname.startsWith('/components-')) {
      const releases = [pair.from, pair.to].map(asset => ({
        ...asset,
        url: `${origin}/${asset.name}`,
        minSourceVersion: pair.from.version === asset.version ? '0.0.0' : pair.from.version,
        revoked: false,
      }))
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          schemaVersion: 1,
          upgradePolicy: {
            schemaVersion: 1,
            channel,
            platform: pair.to.platform,
            arch: pair.to.arch,
            releases,
            edges: [
              {
                from: pair.from.version,
                to: pair.to.version,
                fromSha256: pair.from.sha256,
                toSha256: pair.to.sha256,
                fromSourceSha: pair.from.sourceSha,
                toSourceSha: pair.to.sourceSha,
                runId: String(process.env.GITHUB_RUN_ID || 1),
                evidenceSha256: 'a'.repeat(64),
                upgrade: 'passed',
                rollback: 'passed',
                revoked: false,
              },
            ],
          },
        })
      )
    } else if (url.pathname === `/${pair.to.name}`) {
      response.writeHead(200, {
        'content-type': 'application/gzip',
        'content-length': pair.to.bytes,
      })
      if (request.headers.range) {
        response.destroy(new Error('Whole release downloads must not use byte ranges'))
        return
      }
      const timer = setTimeout(() => createReadStream(pair.to.path).pipe(response), 6000)
      response.once('close', () => clearTimeout(timer))
    } else {
      response.writeHead(404)
      response.end()
    }
  })
  await new Promise((accept, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', accept)
  })
  origin = `http://127.0.0.1:${server.address().port}`
  const root = join(electronUserDataDirectory, 'releases')
  const sourceRuntimeRoot = join(root, 'source-runtime-cache')
  const appEnvironment = {
    WEWORK_UPDATE_BASE_URL: origin,
    WEWORK_HARNESS_RUNTIME_ROOT: sourceRuntimeRoot,
  }
  if (checkpoint === 'app-upgrade-recovery')
    appEnvironment.WEWORK_E2E_RELEASE_FAILURE_VERSION = pair.to.version
  if (checkpoint === 'app-rollback-recovery')
    appEnvironment.WEWORK_E2E_ROLLBACK_FAILURE = 'after-journal'

  const installedVersion = async () =>
    JSON.parse(await control.command('getInstalledAppVersion', 'body')).version
  const compositions = []
  const assertSelectedComposition = async version => {
    const id = (await readFile(join(root, 'active'), 'utf8')).trim()
    const slot = join(root, 'slots', id)
    const release = JSON.parse(await readFile(join(slot, 'release.json'), 'utf8'))
    const { components } = JSON.parse(await readFile(join(slot, 'prepared.json'), 'utf8'))
    const { release: actual } = JSON.parse(
      await control.command('getDesktopRuntimeDiagnostics', 'body')
    )
    assert.equal(release.version, version)
    assert.equal(actual.id, id)
    for (const [key, expected] of Object.entries({
      hostExecutable: release.executable,
      runtimeRoot: release.runtimeRoot,
      coreDshPath: components.coreDsh,
      corePluginsPath: components.weworkCorePlugins,
      executorPath: components.executor,
      codexPath: components.codex,
      dwsPath: components.dws,
    })) {
      assert.equal(resolve(actual[key]), resolve(expected), `Selected release ${key} differs`)
    }
    compositions.push({ version, ...actual, coreDsh: components.coreDsh })
  }
  const about = async () => {
    await control.command('click', '[data-testid="settings-button"]')
    await control.command('click', '[data-testid="about-menu-button"]')
    await control.command('waitFor', '[data-testid="about-settings-page"]')
  }
  const send = async text => {
    const expectedAnswer = `${ANSWER} ${modelRequests + 1}`
    await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: text })
    await control.command('clickWhenEnabled', '[data-testid="send-message-button"]')
    await control.command('waitFor', '[data-testid="message-assistant"]', {
      text: expectedAnswer,
      timeoutMs: workbenchReadyTimeoutMs,
    })
  }
  return {
    usesReleasePackageRuntimeAssets: true,
    appEnvironment,
    async prepareApp({ appEnvironment: sourceEnvironment }) {
      // Exercise each delivered package's own executor and coding CLIs. Fixed
      // runner binary overrides would otherwise survive into the target release.
      for (const key of [
        'WEWORK_EXECUTOR_PATH',
        'WEWORK_EXECUTOR_SIDECAR',
        'CODEX_BINARY_PATH',
        'CODEX_BIN',
        'DWS_BINARY_PATH',
      ])
        delete sourceEnvironment[key]
      await mkdir(electronUserDataDirectory, { recursive: true })
      await writeFile(
        join(electronUserDataDirectory, 'renderer-local-storage.json'),
        JSON.stringify({
          version: 1,
          entries: { 'wework:autoDownloadUpdates': 'false', 'wework:updateChannel': channel },
        })
      )
      const profile = join(electronUserDataDirectory, 'dsh-core', 'profiles', 'wework-core')
      await mkdir(profile, { recursive: true })
      await writeFile(
        join(profile, '.wework-core-plugins.json'),
        JSON.stringify({ version: 1, order: [], disabled: [OPTIONAL_PLUGIN] })
      )
      // A represents an installed, prepared desktop. Run its own shipped
      // preparation entry before launch; B must still prepare its isolated slot.
      const resources =
        process.platform === 'darwin'
          ? resolve(dirname(pair.from.executable), '../Resources')
          : join(dirname(pair.from.executable), 'resources')
      const request = join(resultDir, 'prepare-source.json')
      await writeFile(
        request,
        JSON.stringify({
          storeRoot: root,
          sourceProfile: profile,
          release: {
            schemaVersion: 1,
            id: 'source-preparation',
            version: pair.from.version,
            executable: pair.from.executable,
            resources,
            runtimeRoot: sourceRuntimeRoot,
            profileRoot: join(root, 'slots/source-preparation/profile'),
            dataSchema: pair.from.dataSchema,
            readableDataSchemas: pair.from.readableDataSchemas,
          },
        })
      )
      console.log(`[upgrade-e2e] Preparing the installed source ${pair.from.version}`)
      const preparation = promisify(execFile)(
        pair.from.executable,
        [join(resources, 'app.asar', 'dist', 'runtime', 'release-preparation-cli.js'), request],
        {
          env: { ...sourceEnvironment, ELECTRON_RUN_AS_NODE: '1' },
          timeout: 300_000,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        }
      )
      try {
        await preparation
      } catch (error) {
        await writeFile(
          join(resultDir, 'source-preparation-result.json'),
          JSON.stringify({
            pid: preparation.child?.pid,
            code: error.code,
            signal: error.signal,
            killed: error.killed,
          })
        )
        throw new Error(
          `Source preparation failed: code=${error.code}, signal=${error.signal}, killed=${error.killed}`,
          { cause: error }
        )
      }
      console.log('[upgrade-e2e] Installed source prepared from its delivered package')
    },
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      if (!JSON.stringify(body).includes(PROMPT)) return false
      modelRequests++
      const id = `upgrade-model-${modelRequests}`
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(
        createSse([
          responseCreated(id),
          assistantMessage(`${ANSWER} ${modelRequests}`),
          responseCompleted(id),
        ])
      )
      return true
    },
    async verify(client) {
      control = client
      await control.command('waitFor', '[data-testid="new-chat-button"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      assert.equal(await installedVersion(), pair.from.version)
      console.log(`[upgrade-e2e] Source ${pair.from.version} is ready`)
      const workspace = join(workspacePath, 'upgrade-source-project')
      await mkdir(workspace, { recursive: true })
      await control.command('click', '[data-testid="new-chat-button"]')
      await createSingleRootLocalProject(control, workspace, 'upgrade-source-project')
      await send(PROMPT)
      await control.command('setLocalStorageItem', 'body', {
        value: JSON.stringify({ key: STORAGE_KEY, value: 'before-update' }),
      })
      await about()
      const updateButton = '[data-testid="about-check-update-button"]'
      const alreadyAvailable = (await control.command('clickWhenEnabled', updateButton)).includes(
        pair.to.version
      )
      if (!alreadyAvailable) {
        await control.command('waitFor', '[data-testid="about-update-status"]', {
          text: pair.to.version,
        })
        await control.command('clickWhenEnabled', updateButton)
      }
      const accepted = JSON.parse(await control.command('getAppUpdateProgress', 'body'))
      assert.notEqual(
        accepted.phase,
        'ready',
        'The download request blocked until preparation completed'
      )
      assert.notEqual(accepted.phase, 'failed', 'The download failed to start')
      const observedProgress = await waitForUpdatePreparation(async () =>
        JSON.parse(await control.command('getAppUpdateProgress', 'body'))
      )
      const transfers = requests.filter(request => request.path === `/${pair.to.name}`)
      assert.equal(transfers.length, 1, 'The updater must download the complete host exactly once')
      assert.equal(transfers[0].range, null, 'The host update must use one full request')
      assert.equal(
        requests.some(request => request.path.endsWith('.blockmap')),
        false
      )
      assert.equal(observedProgress.downloadedBytes, pair.to.bytes)
      assert.equal(observedProgress.totalBytes, pair.to.bytes)
      const requestCount = requests.length
      await control.command('downloadPendingAppUpdate', 'body')
      assert.equal(requests.length, requestCount, 'Repeated preparation started another transfer')
      console.log(`[upgrade-e2e] Target ${pair.to.version} fully prepared before restart`)
      await control.command('waitFor', '[data-testid="app-update-restart-confirm"]')
      const progress = JSON.parse(await control.command('getAppUpdateProgress', 'body'))
      assert.equal(
        progress.phase,
        'ready',
        'Restart must not be offered before target preparation completes'
      )
      assert.equal(
        await installedVersion(),
        pair.from.version,
        'Background preparation changed the running version'
      )
      assert.equal(
        await control.command('getLocalStorageItem', 'body', { value: STORAGE_KEY }),
        'before-update'
      )
      const readyCount = control.readyCount
      await control.command('click', '[data-testid="app-update-restart-confirm"]')
      await control.awaitReadyAfter(readyCount, workbenchReadyTimeoutMs)
      await control.command('waitFor', '[data-testid="app-shell"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      if (checkpoint === 'app-upgrade-recovery') {
        assert.equal(
          await installedVersion(),
          pair.from.version,
          'Failed target did not roll back to source'
        )
        assert.equal(
          await control.command('getLocalStorageItem', 'body', { value: STORAGE_KEY }),
          'before-update'
        )
        await control.command(
          'waitFor',
          '[data-testid="new-chat-button"], [data-testid="settings-back-button"]',
          { timeoutMs: workbenchReadyTimeoutMs }
        )
        if (
          Number(await control.command('getElementCount', '[data-testid="settings-back-button"]')) >
          0
        )
          await control.command('click', '[data-testid="settings-back-button"]')
        await send(`${PROMPT} continue after failed activation`)
        await assertSelectedComposition(pair.from.version)
        console.log('[upgrade-e2e] Automatic recovery preserved a usable task')
        await writeFile(
          join(resultDir, 'upgrade-recovery-result.json'),
          JSON.stringify({ source: pair.from.sha256, target: pair.to.sha256, recovered: true })
        )
        passed = true
        return
      }
      assert.equal(await installedVersion(), pair.to.version)
      console.log(`[upgrade-e2e] Running target ${pair.to.version}`)
      await control.command(
        'waitFor',
        '[data-testid="new-chat-button"], [data-testid="settings-back-button"]',
        { timeoutMs: workbenchReadyTimeoutMs }
      )
      const profileState = JSON.parse(
        await readFile(
          join(
            electronUserDataDirectory,
            'dsh-core/profiles/wework-core/.wework-core-plugins.json'
          ),
          'utf8'
        )
      )
      assert.ok(
        profileState.disabled.includes(OPTIONAL_PLUGIN),
        'Upgrade lost the disabled plugin state'
      )
      assert.equal(
        await control.command('getLocalStorageItem', 'body', { value: STORAGE_KEY }),
        'before-update'
      )
      if (
        Number(await control.command('getElementCount', '[data-testid="settings-back-button"]')) > 0
      )
        await control.command('click', '[data-testid="settings-back-button"]')
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: ANSWER,
        timeoutMs: workbenchReadyTimeoutMs,
      })
      const beforeRequests = modelRequests
      await send(`${PROMPT} continue after upgrade`)
      await assertSelectedComposition(pair.to.version)
      assert.ok(
        modelRequests > beforeRequests,
        'The restored task did not execute through the real runtime'
      )
      console.log('[upgrade-e2e] Persisted task continued through the real runtime')
      if (checkpoint === 'app-rollback' || checkpoint === 'app-rollback-recovery') {
        await control.command('setLocalStorageItem', 'body', {
          value: JSON.stringify({ key: STORAGE_KEY, value: 'after-update' }),
        })
        await about()
        await control.command('click', '[data-testid="about-rollback-button"]')
        await control.command('waitFor', '[data-testid="app-update-rollback-confirm"]')
        const beforeRollback = control.readyCount
        await control.command('click', '[data-testid="app-update-rollback-confirm"]')
        if (checkpoint === 'app-rollback-recovery') {
          await waitForInterruptedRollback(root)
          const journal = JSON.parse(await readFile(join(root, 'activation.json'), 'utf8'))
          assert.equal(journal.rollbackRequested, true)
          assert.equal(
            (await readFile(join(root, 'healthy'), 'utf8')).trim(),
            journal.token,
            'The test must retain the previously healthy marker during the interrupted rollback'
          )
          await restartDesktopApp()
        }
        await control.awaitReadyAfter(beforeRollback, workbenchReadyTimeoutMs)
        assert.equal(await installedVersion(), pair.from.version)
        console.log(`[upgrade-e2e] Rolled back to ${pair.from.version}`)
        await assert.rejects(
          readFile(join(root, 'previousHealthy')),
          { code: 'ENOENT' },
          'A completed rollback must not offer the active version as its own predecessor'
        )
        await control.command(
          'waitFor',
          '[data-testid="new-chat-button"], [data-testid="settings-back-button"]',
          { timeoutMs: workbenchReadyTimeoutMs }
        )
        const restoredPlugins = JSON.parse(
          await readFile(
            join(
              electronUserDataDirectory,
              'dsh-core/profiles/wework-core/.wework-core-plugins.json'
            ),
            'utf8'
          )
        )
        assert.ok(
          restoredPlugins.disabled.includes(OPTIONAL_PLUGIN),
          'Rollback lost the disabled plugin state'
        )
        const restoreRequired = !pair.from.readableDataSchemas.includes(pair.to.dataSchema)
        assert.equal(
          await control.command('getLocalStorageItem', 'body', { value: STORAGE_KEY }),
          restoreRequired ? 'before-update' : 'after-update',
          'Rollback did not restore the pre-update snapshot'
        )
        if (
          Number(await control.command('getElementCount', '[data-testid="settings-back-button"]')) >
          0
        )
          await control.command('click', '[data-testid="settings-back-button"]')
        await send(`${PROMPT} continue after rollback`)
        await assertSelectedComposition(pair.from.version)
        if (restoreRequired) {
          const { readdir } = await import('node:fs/promises')
          const preserved = await readdir(join(root, 'preserved-data'))
          assert.equal(preserved.length, 1, 'Expected one preserved post-update data set')
          const storage = JSON.parse(
            await readFile(
              join(root, 'preserved-data', preserved[0], 'renderer-local-storage.json'),
              'utf8'
            )
          )
          assert.equal(
            storage.entries[STORAGE_KEY],
            'after-update',
            'Rollback did not preserve the newer local data'
          )
        }
      }
      const evidence = JSON.stringify({
        schemaVersion: 1,
        kind: pair.kind,
        suiteVersion: pair.suiteVersion,
        runId: String(process.env.GITHUB_RUN_ID || ''),
        fromVersion: pair.from.version,
        toVersion: pair.to.version,
        platform: pair.to.platform,
        arch: pair.to.arch,
        channel,
        source: pair.from.sha256,
        target: pair.to.sha256,
        fromSourceSha: pair.from.sourceSha,
        toSourceSha: pair.to.sourceSha,
        upgrade: 'passed',
        rollback: ['app-rollback', 'app-rollback-recovery'].includes(checkpoint)
          ? 'passed'
          : 'not-run',
        requests,
        compositions,
      })
      await writeFile(join(resultDir, 'upgrade-edge-result.json'), evidence)
      if (process.env.WEWORK_E2E_UPGRADE_EVIDENCE)
        await writeFile(process.env.WEWORK_E2E_UPGRADE_EVIDENCE, evidence)
      passed = true
    },
    async cleanup() {
      if (control) await control.command('quitApp', 'body').catch(() => undefined)
      const fs = await import('node:fs/promises')
      // A failed activation can leave the native recovery shell waiting for
      // confirmation before it connects to the renderer control channel.
      const recoveryPid = Number(
        await fs.readFile(join(root, 'recovery-pid'), 'utf8').catch(() => '0')
      )
      if (recoveryPid && !passed) {
        try {
          process.kill(recoveryPid)
        } catch (error) {
          if (error.code !== 'ESRCH') throw error
        }
      }
      const pid = Number(await fs.readFile(join(root, 'active-pid'), 'utf8').catch(() => '0'))
      if (pid) {
        const deadline = Date.now() + 10_000
        let alive = true
        while (alive && Date.now() < deadline) {
          try {
            process.kill(pid, 0)
          } catch {
            alive = false
          }
          if (alive) await new Promise(accept => setTimeout(accept, 100))
        }
        assert.equal(alive, false, 'The upgraded application did not exit during cleanup')
      }
      if (passed) await fs.rm(root, { recursive: true, force: true })
      server.closeAllConnections()
      await new Promise(accept => server.close(accept))
    },
  }
}
