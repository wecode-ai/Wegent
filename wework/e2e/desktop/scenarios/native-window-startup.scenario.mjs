import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { telemetryEvents } from '../modules/response-protocol.mjs'
import { verifyStartupRecovery } from '../modules/startup-recovery.mjs'
import { verifyStartupSplashProgress } from '../modules/startup-splash-progress.mjs'

const SPLASH_CLOSE_TIMEOUT_MS = 10_000
const SPLASH_CLOSE_POLL_INTERVAL_MS = 50

function parseStartupEvents(appLog) {
  const events = []
  for (const match of appLog.matchAll(/\[startup\]\s+\{([\s\S]*?)\}/g)) {
    const body = match[1]
    const step = body.match(/\bstep:\s*'([^']+)'/)?.[1]
    const status = body.match(/\bstatus:\s*'([^']+)'/)?.[1]
    const stage = body.match(/\bstage:\s*'([^']+)'/)?.[1]
    const elapsedMs = Number(body.match(/\belapsedMs:\s*(\d+)/)?.[1])
    if (step && status && Number.isFinite(elapsedMs)) {
      events.push({ step, status, elapsedMs, ...(stage ? { stage } : {}) })
    }
  }
  return events
}

function startupEventIndex(events, step, status) {
  return events.findIndex(event => event.step === step && event.status === status)
}

async function waitForClosedStartupSplash(control) {
  const deadline = Date.now() + SPLASH_CLOSE_TIMEOUT_MS
  let snapshot

  do {
    snapshot = JSON.parse(await control.command('getStartupSplashSnapshot', 'body'))
    if (snapshot.state === 'closed') return snapshot
    await delay(SPLASH_CLOSE_POLL_INTERVAL_MS)
  } while (Date.now() < deadline)

  assert.fail(
    `The Electron startup splash did not close within ${SPLASH_CLOSE_TIMEOUT_MS}ms: ${JSON.stringify(snapshot)}`
  )
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
  return {
    appEnvironment: { WEWORK_E2E_BACKGROUND_WINDOW: '0' },

    setRestartDesktopApp(restart) {
      restartDesktopApp = restart
    },

    async verify(control) {
      await verifyStartupSplashProgress({
        appBinary: process.env.WEWORK_E2E_APP_BIN,
        resultDir,
      })
      await verifyStartupRecovery({ appBinary: process.env.WEWORK_E2E_APP_BIN, resultDir })
      const snapshot = await waitForClosedStartupSplash(control)
      assert.deepEqual(
        snapshot.events.map(event => event.name),
        ['created', 'animation-ready', 'shown', 'closed'],
        'The Electron startup splash did not complete its animated lifecycle'
      )
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
      const appLog = await waitForStartupLogs(resultDir)
      const startupReady = appLog.indexOf("step: 'renderer-startup-ready'")
      const taskListReady = appLog.indexOf("source: 'task-list'", startupReady)
      const splashClosed = appLog.indexOf("step: 'startup-splash-close'")
      assert.ok(taskListReady >= 0, 'The renderer did not log task-list readiness')
      assert.ok(
        startupReady <= taskListReady && taskListReady < splashClosed,
        'The startup stages were logged out of order'
      )
      const runtimeStartupEvents = parseStartupEvents(appLog)
      const canonicalProgressStages = [
        'launch',
        'shell',
        'components',
        'runtime-files',
        'cli',
        'workspace',
        'services',
        'core-dsh',
        'renderer',
      ]
      const requiredProgressStages = [
        'launch',
        'shell',
        'components',
        'cli',
        'workspace',
        'services',
        'core-dsh',
        'renderer',
      ]
      const progressStages = runtimeStartupEvents
        .filter(event => event.step === 'startup-progress' && event.status === 'started')
        .map(event => event.stage)
      const progressIndexes = progressStages.map(stage => canonicalProgressStages.indexOf(stage))
      assert.ok(
        progressIndexes.every(index => index >= 0),
        `The startup splash received an unknown stage: ${JSON.stringify(progressStages)}`
      )
      assert.ok(
        progressIndexes.every((value, index) => index === 0 || value > progressIndexes[index - 1]),
        `The startup splash received stages out of order: ${JSON.stringify(progressStages)}`
      )
      for (const stage of requiredProgressStages) {
        assert.ok(
          progressStages.includes(stage),
          `The startup splash did not receive required stage ${stage}: ${JSON.stringify(progressStages)}`
        )
      }
      assert.equal(
        progressStages[0],
        'launch',
        `The startup splash did not start with launch: ${JSON.stringify(progressStages)}`
      )
      assert.equal(
        progressStages.at(-1),
        'renderer',
        `The startup splash did not end with renderer: ${JSON.stringify(progressStages)}`
      )
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

      // Consent is already saved by common bootstrap. Restart without clicking or focusing
      // anything so the assertion exercises startup autofocus itself.
      assert.ok(restartDesktopApp, 'The startup focus scenario requires the desktop restart hook')
      const telemetryRequestCountBeforeRestart = control.telemetryRequestCount()
      await restartDesktopApp()
      await waitForClosedStartupSplash(control)
      await control.command('waitFor', '[data-testid="desktop-empty-composer-frame"]')
      await control.command(
        'waitFor',
        '[data-testid="chat-message-input"][contenteditable="true"]:focus'
      )
      const focusSnapshot = JSON.parse(await control.command('getComposerFocusSnapshot', 'body'))
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
    },

    diagnostics() {
      return { nativeWindowStartup: true }
    },
  }
}
