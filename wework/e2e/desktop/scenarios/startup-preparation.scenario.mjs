import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { processIsAlive } from '../process-lifecycle.mjs'
import {
  RUNTIME_SELF_EXIT_TIMEOUT_MS,
  waitForProcessExitWithin,
} from '../modules/window-attachment-flows.mjs'
import {
  parseStartupEvents,
  waitForClosedStartupSplash,
  waitForStartupLogs,
} from './native-window-startup.scenario.mjs'

export function assertStartupPreparation(events) {
  const single = (step, status) => {
    const matches = events.flatMap((event, index) =>
      event.step === step && event.status === status ? [index] : []
    )
    assert.equal(matches.length, 1, `Expected exactly one ${step}:${status}`)
    return matches[0]
  }
  const preparationStarted = single('desktop-environment', 'started')
  const preparationCompleted = single('desktop-environment', 'completed')
  const readyStarted = single('electron-ready', 'started')
  const readyCompleted = single('electron-ready', 'completed')
  const executorHome = single('executor-home-preparation', 'started')
  const coreStarted = single('core-dsh-process-start', 'started')
  const coreCompleted = single('core-dsh-process-start', 'completed')
  const rendererLoading = single('primary-renderer-load', 'started')
  const surfaceReady = single('renderer-startup-ready', 'completed')
  const splashClosed = single('startup-splash-close', 'completed')
  assert.ok(preparationStarted < readyStarted, 'Environment preparation did not start before ready')
  assert.ok(preparationStarted < preparationCompleted, 'Environment preparation did not complete')
  assert.ok(readyStarted < readyCompleted, 'Electron did not complete its real ready lifecycle')
  assert.ok(preparationCompleted < executorHome, 'Executor Home preceded environment preparation')
  assert.ok(preparationCompleted < coreStarted, 'Core started before environment preparation')
  assert.ok(readyCompleted < coreStarted, 'Core started before Electron was ready')
  assert.ok(coreStarted < coreCompleted, 'The real Core process did not become ready')
  assert.ok(coreCompleted < rendererLoading, 'The renderer loaded before Core became ready')
  assert.ok(rendererLoading < surfaceReady, 'The real renderer surface did not become ready')
  assert.ok(surfaceReady < splashClosed, 'The splash closed before the actual surface was ready')
}

export async function createDesktopScenario({ resultDir, uiTimeoutMs }) {
  return {
    async verify(control) {
      await waitForClosedStartupSplash(control)
      const events = parseStartupEvents(await waitForStartupLogs(resultDir))
      assertStartupPreparation(events)
      const activity = JSON.parse(await readFile(join(resultDir, '.active'), 'utf8'))
      const diagnostics = JSON.parse(await control.command('getDesktopRuntimeDiagnostics', 'body'))
      const processes = [
        { kind: 'application', pid: activity.applicationProcessId, timeoutMs: uiTimeoutMs },
        { kind: 'core', pid: diagnostics.coreDshPid, timeoutMs: RUNTIME_SELF_EXIT_TIMEOUT_MS },
        { kind: 'executor', pid: diagnostics.executorPid, timeoutMs: RUNTIME_SELF_EXIT_TIMEOUT_MS },
      ]
      assert.equal(new Set(processes.map(process => process.pid)).size, processes.length)
      for (const process of processes) {
        assert.ok(
          Number.isSafeInteger(process.pid) && process.pid > 0,
          `Missing ${process.kind} PID`
        )
        assert.equal(processIsAlive(process.pid), true, `${process.kind} was not alive before quit`)
      }
      await writeFile(
        join(resultDir, 'startup-preparation-order.json'),
        JSON.stringify(events, null, 2)
      )
      await control.command('setAppPreferences', 'body', {
        value: JSON.stringify({ closeToTrayEnabled: false }),
      })
      await control.command('requestMainWindowClose', 'body')
      const exited = await Promise.all(
        processes.map(async process => ({
          kind: process.kind,
          pid: process.pid,
          exitMs: await waitForProcessExitWithin(
            process.pid,
            process.timeoutMs,
            `${process.kind} did not exit on its own after the real window close request`
          ),
          alive: processIsAlive(process.pid),
        }))
      )
      for (const process of exited) assert.equal(process.alive, false)
      await writeFile(
        join(resultDir, 'startup-preparation-exit.json'),
        JSON.stringify(exited, null, 2)
      )
    },
  }
}
