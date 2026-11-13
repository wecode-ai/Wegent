import assert from 'node:assert/strict'
import {
  mkdir,
  readFile,
  stat,
  writeFile,
  rename,
  lstat,
  realpath,
  rm,
  symlink,
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { hashReleaseAsset } from '../../../scripts/lib/portable-desktop-release.mjs'
import { compareVersions } from '../../../electron/src/runtime/upgrade-policy.mjs'
import { createSingleRootLocalProject } from '../modules/shared.mjs'
import { createUpgradeConversationContinuity } from '../modules/upgrade-conversation-continuity.mjs'
import { createUpgradeGoalContinuity } from '../modules/upgrade-goal-continuity.mjs'
import { createUpgradeAuxiliaryHistory } from '../modules/upgrade-auxiliary-history.mjs'
import { assertUpgradeComposition } from '../modules/upgrade-selected-composition.mjs'
import { createUpgradeWriterWait } from '../modules/upgrade-writer-wait.mjs'
import { retainUpgradeReleaseDiagnostics } from '../modules/upgrade-stopped-diagnostics.mjs'
import { credentialsRequireReupgrade, UPGRADE_SUITE_VERSION } from '../upgrade-suite.mjs'
import { waitForUpdatePreparation } from '../modules/update-preparation-progress.mjs'
import { createUpgradeUpdateServer } from '../modules/upgrade-update-server.mjs'
import { startRefreshedAppUpdate } from '../modules/app-update-refresh.mjs'
import { finishFailedUpgradeRetry } from '../modules/failed-upgrade-retry.mjs'
import { prepareReleaseProcess } from '../../../electron/src/runtime/release-preparation-progress.mjs'
import { stopProcessGroup, waitForOwnedProcessExit } from '../process-lifecycle.mjs'
import { seedUnstartedActivation } from '../modules/unstarted-activation-fixture.mjs'
import { waitForInterruptedRollback } from '../modules/interrupted-rollback.mjs'
import {
  routeUpgradeRequests,
  routeRunningUpgradeRequests,
} from '../modules/upgrade-request-route.mjs'
import {
  assertInstalledStartupWithStaleHistory,
  quitInstalledHost,
} from '../modules/installed-startup-history.mjs'
import {
  armEmptyManifestUpgrade,
  assertEmptyManifestBackups,
  assertEmptyManifestRecovery,
  restartUpgradedHost,
} from '../modules/empty-capability-manifest-upgrade.mjs'
import { assertDelayedRecoveryHandoffs } from '../modules/delayed-recovery-handoff.mjs'
import { upgradeCredentials } from '../modules/upgrade-credentials.mjs'
import { reupgradeAfterRollback } from '../modules/reupgrade-after-rollback.mjs'
import { verifyRollbackProtection } from '../modules/rollback-protection.mjs'
import { openAboutSettings } from '../modules/app-update-navigation.mjs'
import {
  installPreparedSource,
  installedSourcePlugins,
  installedSourcePreparationRequest,
  installedSourceSnapshotIdentity,
  SOURCE_DISABLED_PLUGIN as OPTIONAL_PLUGIN,
} from '../modules/installed-source-preparation.mjs'
import {
  restoreInstalledSourceSnapshot,
  saveInstalledSourceSnapshot,
} from '../modules/installed-source-snapshot.mjs'
import {
  linkBundledRuntimeCache,
  prepareBundledRuntimeCache,
} from '../modules/bundled-runtime-cache.mjs'
import {
  macosUpgradeIdentity,
  pruneWithRolledBackSource,
  useVersionedMacosRecoveryBridge,
} from '../modules/macos-upgrade-identity.mjs'
import {
  assistantMessage,
  createSse,
  handleEmptyReplyPrediction,
  readRequestBody,
  responseCreated,
} from '../modules/response-protocol.mjs'

const PROMPT = 'WEWORK_UPGRADE_PERSISTENCE'
const ANSWER = 'WEWORK_UPGRADE_REAL_RUNTIME_OK'
const STORAGE_KEY = 'wework:upgrade-regression-marker'

/** One reusable flow for fixed A -> B pairs. Version numbers never select assertions. */
export async function createDesktopScenario(options) {
  const {
    checkpoint,
    electronUserDataDirectory,
    executorHome,
    resultDir,
    restartDesktopApp,
    workbenchReadyTimeoutMs,
    workspacePath,
  } = options
  const pairFile = process.env.WEWORK_E2E_UPGRADE_PAIR
  assert.ok(pairFile, 'Upgrade checkpoints require an independently built source/target pair')
  const pair = JSON.parse(await readFile(pairFile, 'utf8'))
  const writerWait = createUpgradeWriterWait(pair, checkpoint, options)
  const usesDefaultUserData = options.usesDefaultUserData === true
  assert.equal(pair.transport, 'default-update-route')
  assert.ok(usesDefaultUserData, 'Upgrade verification must use the product default layout')
  const verifiesUnstartedActivation =
    usesDefaultUserData &&
    checkpoint === 'app-rollback' &&
    (pair.kind === 'regression' || Boolean(pair.from.installedSource))
  let legacyDataDirectory
  let launchEnvironment
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
  const verifiesRefreshedUpdate = checkpoint === 'app-update-refresh'
  const verifiesRetry = checkpoint === 'app-update-retry'
  const verifiesFailedActivation = checkpoint === 'app-upgrade-recovery' || verifiesRetry
  let offer = verifiesRefreshedUpdate ? 'unavailable' : 'target'
  let control
  const inspectorPorts = []
  let launchedAppPid
  let passed = false
  let modelRequests = 0
  const continuity = createUpgradeConversationContinuity(() => control, workbenchReadyTimeoutMs)
  const goalContinuity = createUpgradeGoalContinuity(pair, () => control, workbenchReadyTimeoutMs)
  const auxiliaryHistory = createUpgradeAuxiliaryHistory(pair, () => control, options)
  const { server, origin, requests, releaseHostDownload, unavailablePolicy, intervalProbe } =
    await createUpgradeUpdateServer({
      pair,
      channel,
      currentOffer: () => offer,
    })
  const root = join(electronUserDataDirectory, 'releases')
  const capabilities = join(executorHome, 'capabilities')
  const verifiesEmptyManifest = checkpoint === 'app-rollback'
  const sourceRuntimeRoot = join(electronUserDataDirectory, 'managed-runtimes/dsh')
  const appEnvironment = {}
  if (verifiesFailedActivation) appEnvironment.WEWORK_E2E_RELEASE_FAILURE_VERSION = pair.to.version
  if (checkpoint === 'app-rollback-recovery')
    appEnvironment.WEWORK_E2E_ROLLBACK_FAILURE = 'after-journal'

  const installedVersion = async () =>
    JSON.parse(await control.command('getInstalledAppVersion', 'body')).version
  const runtimeDiagnostics = async () =>
    JSON.parse(await control.command('getDesktopRuntimeDiagnostics', 'body'))
  const assertDisabledPlugin = async message => {
    const profileState = JSON.parse(
      await readFile(
        join(electronUserDataDirectory, 'dsh-core/profiles/wework-core/.wework-core-plugins.json'),
        'utf8'
      )
    )
    assert.ok(profileState.disabled.includes(OPTIONAL_PLUGIN), message)
  }
  const compositions = []
  const credentials = upgradeCredentials()
  let rollbackProtection
  const verifyCredentials = (stage, options) =>
    credentials.verify(
      control,
      inspectorPorts,
      stage,
      [electronUserDataDirectory, legacyDataDirectory].filter(Boolean),
      options
    )
  let macosIdentity
  const assertSelectedComposition = version =>
    assertUpgradeComposition({
      control,
      root,
      version,
      compositions,
      macosIdentity,
      resultDir,
      inspectorPorts,
    })
  const about = () => openAboutSettings(control)
  const send = text => continuity.send(text, `${ANSWER} ${modelRequests + 1}`)
  return {
    usesReleasePackageRuntimeAssets: true,
    ...(!options.preparationOnly
      ? {
          electronLaunchArguments: ['--inspect-brk=127.0.0.1:0'],
          appProcessStarted: async child => {
            const port = await routeUpgradeRequests(
              child,
              origin,
              join(resultDir, 'upgrade-transport.log'),
              { followHandoffs: true }
            )
            inspectorPorts.push(port)
            launchedAppPid = child.pid
          },
        }
      : {}),
    appEnvironment,
    async prepareApp({ appEnvironment: sourceEnvironment }) {
      launchEnvironment = sourceEnvironment
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
        JSON.stringify(installedSourcePlugins())
      )
      // A represents an installed, prepared desktop. Run its own shipped
      // preparation entry before launch; B must still prepare its isolated slot.
      const resources =
        process.platform === 'darwin'
          ? resolve(dirname(pair.from.executable), '../Resources')
          : join(dirname(pair.from.executable), 'resources')
      // An installed source already has its immutable runtime cache. Install
      // those exact checked bytes once; its shipped entry still prepares all
      // components and mutable profile state. The target still validates its
      // delivered archives and prepares its own isolated profile.
      const cacheStarted = performance.now()
      console.log(`[upgrade-e2e] Installing the delivered source runtime ${pair.from.version}`)
      const runtimeCache =
        pair.from.runtimeCache || join(resultDir, 'installed-runtimes', pair.from.sha256)
      await prepareBundledRuntimeCache(resources, runtimeCache)
      await linkBundledRuntimeCache(runtimeCache, sourceRuntimeRoot)
      console.log(
        `[upgrade-e2e] Source runtime installed: durationMs=${Math.round(performance.now() - cacheStarted)}`
      )
      const snapshot =
        !options.preparationOnly && pair.from.preparationCache
          ? {
              cache: pair.from.preparationCache,
              slot: join(root, 'slots/source-preparation'),
              dataDirectory: electronUserDataDirectory,
              identity: installedSourceSnapshotIdentity(pair.from),
            }
          : null
      const restored = snapshot && (await restoreInstalledSourceSnapshot(snapshot))
      if (restored)
        console.log(`[upgrade-e2e] Restored private source preparation: sha256=${pair.from.sha256}`)
      if (!restored) {
        const request = join(resultDir, 'prepare-source.json')
        await writeFile(
          request,
          JSON.stringify(
            installedSourcePreparationRequest(
              { ...pair.from, resources },
              electronUserDataDirectory
            )
          )
        )
        console.log(`[upgrade-e2e] Preparing the installed source ${pair.from.version}`)
        const preparation = prepareReleaseProcess(
          pair.from.executable,
          [join(resources, 'app.asar', 'dist', 'runtime', 'release-preparation-cli.js'), request],
          {
            env: { ...sourceEnvironment, ELECTRON_RUN_AS_NODE: '1' },
            progress: {
              logPath: join(electronUserDataDirectory, 'logs', 'release-preparation.log'),
            },
            version: pair.from.version,
            releaseId: 'source-preparation',
            stop: stopProcessGroup,
          }
        )
        try {
          await preparation
        } catch (error) {
          await writeFile(
            join(resultDir, 'source-preparation.log'),
            `${error.stdout ?? ''}\n${error.stderr ?? ''}`
          )
          await writeFile(
            join(resultDir, 'source-preparation-result.json'),
            JSON.stringify({
              pid: preparation.child?.pid,
              code: error.code,
              signal: error.signal,
              killed: error.killed,
              error: { name: error.name, message: error.message },
            })
          )
          throw new Error(`Source preparation failed: ${error.message}`, { cause: error })
        }
        if (snapshot) await saveInstalledSourceSnapshot(snapshot)
      }
      if (!options.preparationOnly)
        await installPreparedSource(
          join(root, 'slots/source-preparation'),
          electronUserDataDirectory
        )
      console.log('[upgrade-e2e] Installed source prepared from its delivered package')
      if (pair.immutableRuntimeCache && !options.preparationOnly) {
        // This store contains immutable programs only. Source/target catalogs,
        // profile state and all release slots remain private to this checkpoint.
        await mkdir(pair.immutableRuntimeCache, { recursive: true })
        const shared = join(sourceRuntimeRoot, '.prepared')
        await symlink(
          pair.immutableRuntimeCache,
          shared,
          process.platform === 'win32' ? 'junction' : 'dir'
        )
      }
    },
    async prepareUserDataLaunch() {
      await credentials.seed(electronUserDataDirectory)
      if (usesDefaultUserData) {
        // Start from the real default application-data location. The shipped
        // migration, bootstrap and updater must agree on the resulting userData.
        const applicationData = options.upgradeHome?.applicationData
        assert.ok(applicationData)
        assert.match(pair.applicationId, /^io\.wecode\.wework(?:\.[a-z0-9-]+)*$/)
        const legacyTarget = join(applicationData, pair.applicationId)
        await assert.rejects(stat(legacyTarget), { code: 'ENOENT' })
        await rename(electronUserDataDirectory, legacyTarget)
        legacyDataDirectory = legacyTarget
      }
    },
    async handleHttp(request, response, url) {
      if (credentials.handleHttp(request, response, url)) return true
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      if (!JSON.stringify(body).includes(PROMPT)) return false
      continuity.observeModel(body)
      if (goalContinuity.handleModel(body, response)) return true
      if (continuity.toolResponse(body, response)) return true
      modelRequests++
      const id = `upgrade-model-${modelRequests}`
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(
        createSse([
          responseCreated(id),
          assistantMessage(`${ANSWER} ${modelRequests}`),
          goalContinuity.completedModelResponse(id),
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
      const { release: sourceRuntime } = JSON.parse(
        await control.command('getDesktopRuntimeDiagnostics', 'body')
      )
      macosIdentity = await macosUpgradeIdentity(sourceRuntime.hostExecutable)
      await writeFile(
        join(resultDir, 'source-runtime-result.json'),
        `${JSON.stringify({ version: pair.from.version, ...sourceRuntime }, null, 2)}\n`
      )
      console.log(`[upgrade-e2e] Source ${pair.from.version} is ready`)
      await verifyCredentials('source')
      const workspace = join(workspacePath, 'upgrade-source-project')
      await mkdir(workspace, { recursive: true })
      await control.command('click', '[data-testid="new-chat-button"]')
      await createSingleRootLocalProject(control, workspace, 'upgrade-source-project')
      if (pair.to.afterStopPreparation === 1) continuity.seedTool(workspace)
      await send(PROMPT)
      await continuity.assertThread()
      await auxiliaryHistory.seed(continuity.nativeThread())
      await goalContinuity.arm({ send, prompt: PROMPT, answer: `${ANSWER} ${modelRequests + 1}` })
      await continuity.assertThread()
      await control.command('setLocalStorageItem', 'body', {
        value: JSON.stringify({ key: STORAGE_KEY, value: 'before-update' }),
      })
      let stalled
      if (verifiesUnstartedActivation) {
        assert.ok(compareVersions(pair.from.version, pair.from.installedSource.version) < 0)
        const { release: running } = JSON.parse(
          await control.command('getDesktopRuntimeDiagnostics', 'body')
        )
        await control.command('quitApp', 'body')
        await restartDesktopApp({
          afterStop: async () => {
            stalled = await seedUnstartedActivation({
              dataDirectory: electronUserDataDirectory,
              executorHome,
              root,
              resultDir,
              running,
              from: pair.from,
              homePath: options.homePath,
            })
          },
        })
        assert.equal(await installedVersion(), pair.from.version)
        await control.command('waitFor', '[data-testid="new-chat-button"]', {
          timeoutMs: workbenchReadyTimeoutMs,
        })
        assert.equal((await readFile(join(root, 'active'), 'utf8')).trim(), stalled.to)
        await assert.rejects(readFile(join(root, 'attempted')), { code: 'ENOENT' })
        console.log(
          '[upgrade-e2e] Reproduced the shipped unstarted activation with a usable source'
        )
      }
      await about()
      const updateButton = '[data-testid="about-check-update-button"]'
      if (verifiesRefreshedUpdate) {
        await startRefreshedAppUpdate(control, {
          staleVersion: unavailablePolicy().releases[1].version,
          targetVersion: pair.to.version,
          requests,
          setOffer: value => {
            offer = value
          },
          manifestPath: `/components-${channel}-${pair.to.platform}-${pair.to.arch}.json`,
        })
      } else {
        const alreadyAvailable = (await control.command('clickWhenEnabled', updateButton)).includes(
          pair.to.version
        )
        if (!alreadyAvailable) {
          await control.command('waitFor', '[data-testid="about-update-status"]', {
            text: pair.to.version,
          })
          await control.command('clickWhenEnabled', updateButton)
        }
      }
      const accepted = JSON.parse(await control.command('getAppUpdateProgress', 'body'))
      assert.notEqual(
        accepted.phase,
        'ready',
        'The download request blocked until preparation completed'
      )
      assert.notEqual(accepted.phase, 'failed', 'The download failed to start')
      releaseHostDownload()
      let preparationPhase = 'accepted'
      let phaseStarted = performance.now()
      const observedProgress = await waitForUpdatePreparation(async () => {
        const progress = JSON.parse(await control.command('getAppUpdateProgress', 'body'))
        if (progress.phase !== preparationPhase) {
          const now = performance.now()
          console.log(
            `[upgrade-e2e] ${JSON.stringify({
              phase: preparationPhase,
              nextPhase: progress.phase,
              elapsedMs: Math.round(now - phaseStarted),
              downloadedBytes: progress.downloadedBytes,
            })}`
          )
          preparationPhase = progress.phase
          phaseStarted = now
        }
        return progress
      })
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
      if (stalled) {
        await assert.rejects(readFile(join(root, 'activation.json')), { code: 'ENOENT' })
        assert.equal((await readFile(join(root, 'active'), 'utf8')).trim(), stalled.from)
        assert.deepEqual(
          JSON.parse(await readFile(join(root, 'recovery', `${stalled.token}.json`), 'utf8')),
          stalled
        )
        console.log('[upgrade-e2e] Target preparation recovered the unstarted source transaction')
      }
      await control.command('waitFor', '[data-testid="app-update-restart-confirm"]')
      if (verifiesRefreshedUpdate) {
        const confirmation = await control.command(
          'getText',
          '#app-update-restart-confirm-description'
        )
        assert.ok(
          confirmation.includes(pair.to.version),
          'Confirmation must show the actual prepared version'
        )
        assert.equal(
          confirmation.includes(unavailablePolicy().releases[1].version),
          false,
          'Confirmation must not retain the stale target version'
        )
      }
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
      if (verifiesFailedActivation) await useVersionedMacosRecoveryBridge(root, pair.to.version)
      if (verifiesEmptyManifest) {
        const { executorPid } = await runtimeDiagnostics()
        // Historical source packages may not expose a process snapshot action.
        await armEmptyManifestUpgrade(inspectorPorts, launchedAppPid, {
          root,
          capabilities,
          targetVersion: pair.to.version,
          executorPid,
        })
      }
      const readyCount = control.readyCount
      await writerWait.beforeRestart(workspace)
      goalContinuity.beforeRestart()
      await control.command('click', '[data-testid="app-update-restart-confirm"]')
      await writerWait.afterRestart(root, () => goalContinuity.assertStopped())
      await control.awaitReadyAfter(readyCount, workbenchReadyTimeoutMs)
      await control.command('waitFor', '[data-testid="app-shell"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      if (verifiesFailedActivation) {
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
        await goalContinuity.verifyResumed('failed-activation-recovery')
        await auxiliaryHistory.verify('failed-activation-recovery')
        await send(`${PROMPT} continue after failed activation`)
        await assertSelectedComposition(pair.from.version)
        console.log('[upgrade-e2e] Automatic recovery preserved a usable task')
        await writeFile(
          join(resultDir, 'upgrade-recovery-result.json'),
          JSON.stringify({ source: pair.from.sha256, target: pair.to.sha256, recovered: true })
        )
        if (verifiesRetry)
          await finishFailedUpgradeRetry(control, {
            root,
            homePath: options.homePath,
            pair,
            requests,
            resultDir,
            restartDesktopApp,
            workbenchReadyTimeoutMs,
            about,
            send,
            installedVersion,
            assertSelectedComposition,
            captureScreenshot: options.captureScreenshot,
            routeCurrentUpdateRequests: () =>
              routeRunningUpgradeRequests(inspectorPorts, control, origin),
          })
        passed = true
        return
      }
      assert.equal(await installedVersion(), pair.to.version)
      const targetReleaseId = (await readFile(join(root, 'active'), 'utf8')).trim()
      const preparedTarget = JSON.parse(
        await readFile(join(root, 'slots', targetReleaseId, 'release.json'), 'utf8')
      )
      assert.equal(preparedTarget.id, targetReleaseId)
      assert.equal(preparedTarget.version, pair.to.version)
      if (preparedTarget.packageSha256 !== undefined)
        assert.equal(preparedTarget.packageSha256, pair.to.sha256)
      console.log(`[upgrade-e2e] Running target ${pair.to.version}`)
      await verifyCredentials('upgraded')
      await control.command(
        'waitFor',
        '[data-testid="new-chat-button"], [data-testid="settings-back-button"]',
        { timeoutMs: workbenchReadyTimeoutMs }
      )
      const manifestRecovery = verifiesEmptyManifest
        ? await assertEmptyManifestRecovery(capabilities)
        : null
      await assertDisabledPlugin('Upgrade lost the disabled plugin state')
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
      await goalContinuity.verifyResumed('upgrade')
      await auxiliaryHistory.verify('upgrade')
      await send(`${PROMPT} continue after upgrade`)
      await continuity.assertThread()
      await assertSelectedComposition(pair.to.version)
      assert.ok(
        modelRequests > beforeRequests,
        'The restored task did not execute through the real runtime'
      )
      console.log('[upgrade-e2e] Persisted task continued through the real runtime')
      if (manifestRecovery) {
        const beforeRestart = await runtimeDiagnostics()
        assert.ok(beforeRestart.executorPid > 0)
        const executorSha256 = await hashReleaseAsset(beforeRestart.release.executorPath)
        if (process.platform === 'darwin') {
          await assertInstalledStartupWithStaleHistory({
            root,
            restartDesktopApp,
            installedVersion,
            expectedVersion: pair.to.version,
            control,
            timeoutMs: workbenchReadyTimeoutMs,
          })
        } else {
          await restartUpgradedHost(control, inspectorPorts, workbenchReadyTimeoutMs)
        }
        assert.equal(await installedVersion(), pair.to.version)
        await control.command('waitFor', '[data-testid="message-assistant"]', {
          text: ANSWER,
          timeoutMs: workbenchReadyTimeoutMs,
        })
        assert.deepEqual(await assertEmptyManifestRecovery(capabilities), manifestRecovery)
        await assertDisabledPlugin('Restart lost the disabled plugin state')
        assert.equal(
          await control.command('getLocalStorageItem', 'body', { value: STORAGE_KEY }),
          'before-update'
        )
        const requestsBeforeRestartedTask = modelRequests
        await send(`${PROMPT} continue after restarting the upgraded package`)
        assert.ok(
          modelRequests > requestsBeforeRestartedTask,
          'The restarted package did not continue the persisted task'
        )
        const restarted = await runtimeDiagnostics()
        assert.ok(restarted.executorPid > 0)
        assert.notEqual(restarted.executorPid, beforeRestart.executorPid)
        assert.equal(await hashReleaseAsset(restarted.release.executorPath), executorSha256)
        console.log(
          '[upgrade-e2e] Target restart preserved the recovered manifest and continued its task'
        )
      }
      if (
        verifiesUnstartedActivation ||
        verifiesRefreshedUpdate ||
        checkpoint === 'app-rollback' ||
        checkpoint === 'app-rollback-recovery'
      ) {
        if (checkpoint === 'app-rollback-recovery')
          await goalContinuity.restartPaused(async () => {
            await quitInstalledHost(root, control)
            await restartDesktopApp()
          })
        await control.command('setLocalStorageItem', 'body', {
          value: JSON.stringify({ key: STORAGE_KEY, value: 'after-update' }),
        })
        await about()
        if (checkpoint === 'app-rollback') {
          await routeRunningUpgradeRequests(inspectorPorts, control, origin)
          await intervalProbe.verify(control, resultDir)
        }
        await control.command('clickWhenEnabled', '[data-testid="about-rollback-button"]')
        await control.command('waitFor', '[data-testid="app-update-rollback-confirm"]')
        const beforeRollback = control.readyCount
        await goalContinuity.arm()
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
        await verifyCredentials('rolled-back', { write: true })
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
        await assertDisabledPlugin('Rollback lost the disabled plugin state')
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
        if (process.platform === 'darwin' && checkpoint === 'app-rollback-recovery') {
          await assertDelayedRecoveryHandoffs({
            root,
            inspectorPorts,
            targetId: targetReleaseId,
            control,
            environment: launchEnvironment,
            installedVersion,
            expectedVersion: pair.from.version,
            origin,
            resultDir,
            workspacePath,
            timeoutMs: workbenchReadyTimeoutMs,
          })
        }
        await pruneWithRolledBackSource(root, resultDir, options.homePath)
        await goalContinuity.verifyResumed('rollback')
        await auxiliaryHistory.verify('rollback')
        await send(`${PROMPT} continue after rollback`)
        await continuity.assertThread()
        await assertSelectedComposition(pair.from.version)
        if (manifestRecovery) {
          const { backup, historicalBackup } = manifestRecovery
          assert.deepEqual(await assertEmptyManifestBackups(capabilities), {
            backup,
            historicalBackup,
          })
        }
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
        if (checkpoint === 'app-rollback') {
          rollbackProtection = await verifyRollbackProtection({
            control,
            root,
            target: pair.to,
            preparedTarget,
            requests,
            about,
            route: () => routeRunningUpgradeRequests(inspectorPorts, control, origin),
          })
        }
        if (checkpoint === 'app-rollback' && credentialsRequireReupgrade(credentials.stages)) {
          await reupgradeAfterRollback({
            control,
            routeCurrentUpdateRequests: () =>
              routeRunningUpgradeRequests(inspectorPorts, control, origin),
            about,
            version: pair.to.version,
            installedVersion,
            assertSelectedComposition,
            send,
            verifyCredentials: () => verifyCredentials('re-upgraded'),
            timeoutMs: workbenchReadyTimeoutMs,
          })
          rollbackProtection.retryConfirmed = true
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
        ...(manifestRecovery && {
          manifestRecovery: { ...manifestRecovery, restarted: true, rolledBack: true },
        }),
        upgrade: 'passed',
        rollback:
          verifiesUnstartedActivation ||
          verifiesRefreshedUpdate ||
          ['app-rollback', 'app-rollback-recovery'].includes(checkpoint)
            ? 'passed'
            : 'not-run',
        requests,
        compositions,
        credentials: credentials.stages,
        ...(rollbackProtection ? { rollbackProtection } : {}),
        reupgrade: credentials.stages.some(stage => stage.stage === 're-upgraded')
          ? 'passed'
          : 'not-run',
        conversationContinuity: continuity.evidence(),
        goalContinuity: goalContinuity.evidence(),
        auxiliaryHistory: auxiliaryHistory.evidence(),
      })
      await writeFile(join(resultDir, 'upgrade-edge-result.json'), evidence)
      if (
        process.env.WEWORK_E2E_UPGRADE_EVIDENCE &&
        (!process.env.WEWORK_E2E_UPGRADE_EVIDENCE_CHECKPOINT ||
          process.env.WEWORK_E2E_UPGRADE_EVIDENCE_CHECKPOINT === checkpoint)
      )
        await writeFile(process.env.WEWORK_E2E_UPGRADE_EVIDENCE, evidence)
      passed = true
    },
    async cleanup() {
      const errors = []
      goalContinuity.cleanup()
      try {
        await auxiliaryHistory.cleanup()
      } catch (error) {
        errors.push(error)
      }
      try {
        await writerWait.cleanup()
      } catch (error) {
        errors.push(error)
      }
      try {
        const shutdownSnapshot =
          control && process.platform === 'win32' && checkpoint === 'app-rollback-recovery'
            ? JSON.parse(await control.command('getOwnedProcessSnapshot', 'body'))
            : null
        if (shutdownSnapshot)
          await writeFile(
            join(resultDir, 'shutdown-processes-result.json'),
            JSON.stringify(
              shutdownSnapshot,
              [
                'capturedAt',
                'platform',
                'applicationPid',
                'degraded',
                'code',
                'processes',
                'pid',
                'parentPid',
                'startedAt',
                'kind',
              ],
              2
            )
          )
        if (control) await control.command('quitApp', 'body').catch(() => undefined)
        if (shutdownSnapshot) await waitForOwnedProcessExit(shutdownSnapshot)
        const fs = await import('node:fs/promises')
        // Default-layout runs keep product log locations. Retain diagnostics before
        // the shared result compactor removes the isolated Home and its databases.
        if (usesDefaultUserData) {
          await retainUpgradeReleaseDiagnostics({
            root,
            version: pair.to.version,
            resultDir,
            electronUserDataDirectory,
            legacyDataDirectory,
          })
        }
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
          // Retain shutdown phases even when the successful release slot is removed.
          await fs
            .copyFile(
              join(root, 'activation-diagnostics.log'),
              join(resultDir, 'activation-diagnostics.log')
            )
            .catch(error => {
              if (error.code !== 'ENOENT') throw error
            })
          assert.equal(alive, false, 'The upgraded application did not exit during cleanup')
        }
        if (passed) await fs.rm(root, { recursive: true, force: true })
        if (legacyDataDirectory) {
          const legacy = await lstat(legacyDataDirectory).catch(error => {
            if (error.code !== 'ENOENT') throw error
            return null
          })
          if (legacy?.isSymbolicLink()) {
            assert.equal(
              await realpath(legacyDataDirectory),
              await realpath(electronUserDataDirectory)
            )
            await rm(legacyDataDirectory)
          } else if (legacy) {
            // Preparation can fail before the application migrates its fixture.
            await rename(legacyDataDirectory, electronUserDataDirectory)
          }
        }
      } catch (error) {
        errors.push(error)
      }
      try {
        server.closeAllConnections()
        await new Promise((accept, reject) =>
          server.close(error => (error ? reject(error) : accept()))
        )
      } catch (error) {
        errors.push(error)
      }
      if (errors.length) throw new AggregateError(errors, 'Upgrade verification cleanup failed')
    },
  }
}
