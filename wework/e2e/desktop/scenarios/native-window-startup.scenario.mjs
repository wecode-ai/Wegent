import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const SPLASH_CLOSE_TIMEOUT_MS = 10_000
const SPLASH_CLOSE_POLL_INTERVAL_MS = 50

function parseStartupEvents(appLog) {
  const events = []
  for (const match of appLog.matchAll(/\[startup\]\s+\{([\s\S]*?)\}/g)) {
    const body = match[1]
    const step = body.match(/\bstep:\s*'([^']+)'/)?.[1]
    const status = body.match(/\bstatus:\s*'([^']+)'/)?.[1]
    const elapsedMs = Number(body.match(/\belapsedMs:\s*(\d+)/)?.[1])
    if (step && status && Number.isFinite(elapsedMs)) {
      events.push({ step, status, elapsedMs })
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
      const portAllocationStarted = startupEventIndex(
        runtimeStartupEvents,
        'core-dsh-port-allocation',
        'started'
      )
      const portAllocationCompleted = startupEventIndex(
        runtimeStartupEvents,
        'core-dsh-port-allocation',
        'completed'
      )
      const coreProcessStarted = startupEventIndex(
        runtimeStartupEvents,
        'core-dsh-process-start',
        'started'
      )
      assert.ok(corePrepareStarted >= 0, 'Core DSH preparation did not start')
      assert.ok(executorStarted >= 0, 'The managed Executor did not start')
      assert.ok(executorCompleted >= 0, 'The managed Executor did not become ready')
      assert.ok(portAllocationStarted >= 0, 'Core DSH did not allocate a runtime port')
      assert.ok(portAllocationCompleted >= 0, 'Core DSH runtime port allocation did not complete')
      assert.ok(coreProcessStarted >= 0, 'The Core DSH process did not start')
      assert.ok(
        corePrepareStarted < executorCompleted,
        'Core DSH preparation did not overlap managed Executor startup'
      )
      assert.ok(
        executorCompleted < portAllocationStarted,
        'Core DSH allocated its port before the managed Executor bound its startup ports'
      )
      assert.ok(
        portAllocationStarted <= portAllocationCompleted &&
          portAllocationCompleted < coreProcessStarted,
        'Core DSH did not start immediately after allocating its runtime port'
      )
      await writeFile(
        join(resultDir, 'desktop-runtime-startup-order.json'),
        `${JSON.stringify(runtimeStartupEvents, null, 2)}\n`
      )

      // Consent is already saved by common bootstrap. Restart without clicking or focusing
      // anything so the assertion exercises startup autofocus itself.
      assert.ok(restartDesktopApp, 'The startup focus scenario requires the desktop restart hook')
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
    },

    diagnostics() {
      return { nativeWindowStartup: true }
    },
  }
}
