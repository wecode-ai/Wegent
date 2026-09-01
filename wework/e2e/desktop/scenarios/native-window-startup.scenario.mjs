import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const SPLASH_CLOSE_TIMEOUT_MS = 10_000
const SPLASH_CLOSE_POLL_INTERVAL_MS = 50

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
  return {
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
    },

    diagnostics() {
      return { nativeWindowStartup: true }
    },
  }
}
