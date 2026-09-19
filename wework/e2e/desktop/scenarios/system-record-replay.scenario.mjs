import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scenarioDirectory = dirname(fileURLToPath(import.meta.url))
const PAGE = '[data-testid="record-replay-permissions"]'
const READY = '[data-testid="record-replay-permissions-ready"]'
const START = '[data-testid="record-replay-start"]'
const STOP = '[data-testid="record-replay-stop"]'
const ITEM = '[data-testid^="record-replay-item-"]'
const PLAY = '[data-testid^="record-replay-play-"]'
const DELETE = '[data-testid^="record-replay-delete-"]'

export function createDesktopScenario({ captureScreenshot, resultDir, uiTimeoutMs }) {
  const recorderExitFile = join(resultDir, 'system-record-replay-helper-exited')
  return {
    appEnvironment: {
      WEWORK_SYSTEM_RECORD_REPLAY_HELPER: join(
        scenarioDirectory,
        '..',
        '..',
        '..',
        'electron',
        'scripts',
        'system-record-replay-fixture.mjs'
      ),
      WEWORK_SYSTEM_RECORD_REPLAY_FIXTURE_EXIT_FILE: recorderExitFile,
    },

    async verify(control) {
      await control.command('navigate', 'body', { value: '/record-replay' })
      await control.command('waitFor', PAGE, { timeoutMs: uiTimeoutMs })
      await control.command('waitFor', READY, { timeoutMs: uiTimeoutMs })
      await control.command('fill', '[data-testid="record-replay-title-input"]', {
        value: 'System operation flow',
      })
      await control.command('click', START)
      await control.command('waitFor', STOP, { timeoutMs: uiTimeoutMs })
      await new Promise(resolve => setTimeout(resolve, 900))
      await captureScreenshot(control, 'system-record-replay-active.png', PAGE)

      await control.command('click', STOP)
      await control.command('waitFor', ITEM, { timeoutMs: uiTimeoutMs })
      assert.equal(
        Number(await control.command('getElementCount', ITEM)),
        1,
        'The system recording was not saved'
      )
      await captureScreenshot(control, 'system-record-replay-saved.png', ITEM)

      await control.command('click', PLAY)
      await control.command('waitFor', '[data-testid="record-replay-cancel"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', START, {
        enabled: true,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', DELETE, {
        enabled: true,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', DELETE)
      await control.command('waitFor', '[data-testid="record-replay-empty"]', {
        timeoutMs: uiTimeoutMs,
      })

      await rm(recorderExitFile, { force: true })
      await control.command('fill', '[data-testid="record-replay-title-input"]', {
        value: 'Shutdown cleanup',
      })
      await control.command('click', START)
      await control.command('waitFor', STOP, { timeoutMs: uiTimeoutMs })
      assert.equal(
        JSON.parse(
          await control.command('activateTray', 'body', {
            value: JSON.stringify({ type: 'menu-item', menuItemId: 'quit' }),
          })
        ),
        true,
        'The Electron Tray Quit action was not activated'
      )
      await waitForRecorderExit(recorderExitFile, uiTimeoutMs)
    },

    diagnostics() {
      return { systemRecordReplay: true }
    },
  }
}

async function waitForRecorderExit(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await readFile(path, 'utf8').catch(() => '')) === 'stopped\n') return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.fail('Application shutdown did not terminate the active system recorder helper')
}
