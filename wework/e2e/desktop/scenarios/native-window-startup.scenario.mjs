import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { telemetryEvents } from '../modules/response-protocol.mjs'
import { verifyStartupRecovery } from '../modules/startup-recovery.mjs'
import {
  parseStartupEvents,
  verifyStartupSplashProgress,
  waitForStartupProgressEvidence,
} from '../modules/startup-splash-progress.mjs'
import { waitForClosedStartupSplash } from '../modules/native-window-state.mjs'
import { verifyFirstUsePageLoading } from '../modules/first-use-page-loading.mjs'
import { packagedResourcesRoot } from '../modules/workbench-schema-compatibility.mjs'
import { verifyStartupSplashHandoff } from '../modules/startup-splash-handoff.mjs'
import {
  captureStartupThemeEvidence,
  seedStoppedStartupTheme,
} from '../modules/startup-theme-evidence.mjs'

const SPLASH_CLOSE_TIMEOUT_MS = 10_000
const SPLASH_CLOSE_POLL_INTERVAL_MS = 50

function startupEventIndex(events, step, status) {
  return events.findIndex(event => event.step === step && event.status === status)
}

async function waitForStartupLogs(resultDir) {
  const logPath = join(resultDir, 'app.log')
  const deadline = Date.now() + SPLASH_CLOSE_TIMEOUT_MS
  let appLog = ''

  do {
    appLog = await readFile(logPath, 'utf8')
    if (
      appLog.includes("source: 'task-list'") &&
      appLog.includes("step: 'renderer-startup-ready'") &&
      appLog.includes("step: 'startup-splash-close'")
    ) {
      return appLog
    }
    await delay(SPLASH_CLOSE_POLL_INTERVAL_MS)
  } while (Date.now() < deadline)

  assert.fail(`The Electron startup log did not contain the required stages:\n${appLog}`)
}

export async function createDesktopScenario({ resultDir }) {
  let restartDesktopApp
  let lightThemeSeed
  const userDataDirectory = join(resultDir, 'electron-user-data')
  return {
    appEnvironment: { WEWORK_E2E_BACKGROUND_WINDOW: '0' },

    async prepareApp() {
      lightThemeSeed = await seedStoppedStartupTheme({
        resultDir,
        userDataDirectory,
        mode: 'light',
      })
    },

    setRestartDesktopApp(restart) {
      restartDesktopApp = restart
    },

    async verify(control) {
      const appBinary = process.env.WEWORK_E2E_APP_BIN
      await verifyStartupRecovery({
        appBinary,
        resultDir,
        electronRoot: join(packagedResourcesRoot(appBinary), 'app.asar'),
      })
      const snapshot = await waitForClosedStartupSplash(control)
      await verifyStartupSplashHandoff({ snapshot, resultDir })
      assert.ok(
        snapshot.theme === 'light' || snapshot.theme === 'dark',
        `The Electron startup splash did not resolve a valid theme: ${snapshot.theme}`
      )
      const image = await readFile(join(resultDir, 'startup-splash.png'))
      assert.ok(image.length > 8, 'The Electron startup splash capture was empty')
      assert.equal(
        image.subarray(1, 4).toString('ascii'),
        'PNG',
        'The Electron startup splash evidence was not a PNG'
      )
      await captureStartupThemeEvidence({
        control,
        snapshot,
        seed: lightThemeSeed,
        resultDir,
      })
      await waitForStartupProgressEvidence({ userDataDirectory, resultDir })
      const appLog = await waitForStartupLogs(resultDir)
      const startupReady = appLog.indexOf("step: 'renderer-startup-ready'")
      const taskListReady = appLog.indexOf("source: 'task-list'", startupReady)
      const presentationStarted = appLog.indexOf("step: 'startup-window-presentation'")
      const mainShown = appLog.indexOf("step: 'main-window-show'")
      const splashClosed = appLog.indexOf("step: 'startup-splash-close'")
      assert.ok(taskListReady >= 0, 'The renderer did not log task-list readiness')
      assert.ok(startupReady >= 0, 'The renderer did not report startup readiness')
      // Window presentation is independent of task-list health. The loaded
      // document must become visible even when the task list is still loading.
      assert.ok(
        presentationStarted >= 0 && presentationStarted < mainShown && mainShown < splashClosed,
        'The loaded desktop was not presented before closing the startup splash'
      )
      const runtimeStartupEvents = parseStartupEvents(appLog)
      const corePrepareStarted = startupEventIndex(
        runtimeStartupEvents,
        'core-dsh-prepare',
        'started'
      )
      const executorStarted = startupEventIndex(runtimeStartupEvents, 'executor-start', 'started')
      const executorCompleted = startupEventIndex(
        runtimeStartupEvents,
        'executor-start',
        'completed'
      )
      const coreProcessStarted = startupEventIndex(
        runtimeStartupEvents,
        'core-dsh-process-start',
        'started'
      )
      const coreProcessCompleted = startupEventIndex(
        runtimeStartupEvents,
        'core-dsh-process-start',
        'completed'
      )
      assert.ok(corePrepareStarted >= 0, 'Core DSH preparation did not start')
      assert.ok(executorStarted >= 0, 'The managed Executor did not start')
      assert.ok(executorCompleted >= 0, 'The managed Executor did not become ready')
      assert.ok(coreProcessStarted >= 0, 'The Core DSH process did not start')
      assert.ok(coreProcessCompleted >= 0, 'The Core DSH process did not become ready')
      assert.ok(
        corePrepareStarted < executorCompleted,
        'Core DSH preparation did not overlap managed Executor startup'
      )
      assert.ok(
        executorCompleted < coreProcessStarted,
        'Core DSH started before the managed Executor bound its startup ports'
      )
      assert.ok(
        coreProcessStarted < coreProcessCompleted,
        'Core DSH startup readiness was logged before its process started'
      )
      const coreDshLog = await readFile(
        join(resultDir, 'electron-user-data', 'logs', 'dsh-core-runtime.log'),
        'utf8'
      )
      const listeningPort = Number(coreDshLog.match(/dsh web: http:\/\/127\.0\.0\.1:(\d+)/)?.[1])
      assert.ok(
        Number.isInteger(listeningPort) && listeningPort > 0 && listeningPort <= 65535,
        'Core DSH did not bind a valid runtime port'
      )
      await writeFile(
        join(resultDir, 'desktop-runtime-startup-order.json'),
        `${JSON.stringify(runtimeStartupEvents, null, 2)}\n`
      )

      await control.command('setMainWindowSize', 'body', {
        value: JSON.stringify({ width: 1000, height: 620 }),
      })
      const savedWindow = JSON.parse(await control.command('getNativeWindowState', 'body'))
      assert.equal(savedWindow.maximized, false)
      assert.equal(savedWindow.fullScreen, false)

      await verifyStartupSplashProgress({
        control,
        resultDir,
        restartDesktopApp,
        userDataDirectory,
      })

      // Consent is already saved by common bootstrap. Restart without clicking or focusing
      // anything so the assertion exercises startup autofocus itself.
      assert.ok(restartDesktopApp, 'The startup focus scenario requires the desktop restart hook')
      const telemetryRequestCountBeforeRestart = control.telemetryRequestCount()
      const afterBytes = (await readFile(join(userDataDirectory, 'logs', 'wework-main.log'))).length
      let darkThemeSeed
      const darkSplashCapturePath = join(resultDir, 'startup-theme-dark-splash.png')
      await restartDesktopApp({
        afterStop: async () => {
          const preferences = JSON.parse(
            await readFile(join(userDataDirectory, 'app-preferences.json'), 'utf8')
          )
          assert.deepEqual(
            preferences.mainWindowState,
            { bounds: savedWindow.normalBounds, maximized: false },
            'An interrupted startup overwrote the previously saved window size'
          )
          darkThemeSeed = await seedStoppedStartupTheme({
            resultDir,
            userDataDirectory,
            mode: 'dark',
          })
        },
        appEnvironmentOverrides: {
          WEWORK_E2E_STARTUP_SPLASH_HOLD_MS: '',
          WEWORK_E2E_STARTUP_SLOW_AFTER_MS: '',
          WEWORK_E2E_STARTUP_STAGE_TIMEOUT_MS: '',
          WEWORK_E2E_STARTUP_SPLASH_CAPTURE: darkSplashCapturePath,
        },
      })
      const recoveredSplash = await waitForClosedStartupSplash(control)
      await verifyStartupSplashHandoff({
        snapshot: recoveredSplash,
        resultDir,
        name: 'startup-recovered-handoff',
      })
      await captureStartupThemeEvidence({
        control,
        snapshot: recoveredSplash,
        seed: darkThemeSeed,
        resultDir,
        splashCapturePath: darkSplashCapturePath,
      })
      await waitForStartupProgressEvidence({
        userDataDirectory,
        resultDir,
        name: 'startup-recovered-progress',
        afterBytes,
      })
      await control.command('waitFor', '[data-testid="desktop-empty-composer-frame"]')
      await control.command(
        'waitFor',
        '[data-testid="chat-message-input"][contenteditable="true"]:focus'
      )
      const focusSnapshot = JSON.parse(await control.command('getComposerFocusSnapshot', 'body'))
      const nativeWindow = JSON.parse(await control.command('getNativeWindowState', 'body'))
      assert.equal(nativeWindow.maximized, false, 'Restart unexpectedly maximized the workbench')
      assert.deepEqual(
        nativeWindow.bounds,
        savedWindow.bounds,
        'Restart lost the saved window size or position'
      )
      assert.deepEqual(
        recoveredSplash.handoff.bounds.splash,
        savedWindow.bounds,
        'The startup splash did not use the saved main-window geometry'
      )
      assert.equal(nativeWindow.visible, true, 'The workbench was hidden after the startup fade')
      assert.equal(nativeWindow.focused, true, 'The startup handoff did not focus the workbench')
      await writeFile(
        join(resultDir, 'startup-composer-focus.json'),
        `${JSON.stringify(focusSnapshot, null, 2)}\n`
      )

      await control.awaitTelemetryEventAfter(
        'app_startup_attempted',
        telemetryRequestCountBeforeRestart
      )
      await control.awaitTelemetryEventAfter(
        'app_startup_succeeded',
        telemetryRequestCountBeforeRestart
      )
      const startupEvents = control.telemetryRequests
        .slice(telemetryRequestCountBeforeRestart)
        .flatMap(request => telemetryEvents(request.payload))
      const attempted = startupEvents.find(event => event.event === 'app_startup_attempted')
      const succeeded = startupEvents.find(
        event =>
          event.event === 'app_startup_succeeded' &&
          event.properties?.startup_id === attempted?.properties?.startup_id
      )
      assert.match(
        attempted?.properties?.startup_id ?? '',
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        'The desktop startup attempt did not include a UUID correlation ID'
      )
      assert.ok(succeeded, 'The successful desktop startup did not close its correlated attempt')
      assert.ok(
        Number.isFinite(succeeded.properties?.duration_ms) && succeeded.properties.duration_ms >= 0,
        'The successful desktop startup did not include a valid duration'
      )
      await verifyFirstUsePageLoading(control)
    },

    diagnostics() {
      return { nativeWindowStartup: true }
    },
  }
}
