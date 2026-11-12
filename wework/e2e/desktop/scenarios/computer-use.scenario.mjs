import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { verifyComputerUseHostMenu } from '../modules/computer-use-host-menu.mjs'
import { verifyComputerUseCancellation } from '../modules/computer-use-cancellation.mjs'
import { startComputerUseLateEnable } from '../modules/computer-use-late-enable.mjs'

const PAGE_SELECTOR = '[data-testid="computer-use-settings-page"]'
const TOGGLE_SELECTOR = '[data-testid="computer-use-enabled-toggle"]'
const RUNTIME_FILE = 'computer-use-bridge.json'
const WORKBENCH_READY_TIMEOUT_MS = 180_000

async function waitForAttribute(control, selector, name, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let latest = null
  while (Date.now() < deadline) {
    latest = await control.command('getAttribute', selector, { value: name })
    if (latest === expected) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(`${selector} ${name} did not become ${expected}; latest=${latest}`)
}

async function readRuntimeRecord(executorHome, timeoutMs) {
  const path = join(executorHome, 'runtime', RUNTIME_FILE)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const contents = await readFile(path, 'utf8').catch(() => '')
    if (contents) return JSON.parse(contents)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return null
}

async function verifyBridge(record) {
  const response = await fetch(`http://${record.address}/computer`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${record.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ action: 'listTools' }),
  })
  const body = await response.json()
  assert.equal(response.ok, true, `Computer use bridge returned HTTP ${response.status}`)
  assert.equal(body.ok, true, `Computer use bridge failed: ${JSON.stringify(body)}`)
  assert.ok(
    body.data.some(tool => tool.name === 'list_apps'),
    'CUA did not publish the expected desktop application tool'
  )
}

async function waitForRuntimeRecordRemoved(executorHome, timeoutMs) {
  const path = join(executorHome, 'runtime', RUNTIME_FILE)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (
      await access(path)
        .then(() => false)
        .catch(() => true)
    )
      return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail('Disabled computer use left its private bridge record on disk')
}

async function assertBridgeStopped(record) {
  if (!record) return
  await assert.rejects(
    fetch(`http://${record.address}/computer`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${record.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ action: 'listTools' }),
      signal: AbortSignal.timeout(1_000),
    }),
    'Disabled computer use left its private bridge reachable'
  )
}

/** Kill the actual native worker and recover through the existing settings UI. */
export async function verifyDriverCrashRecovery(control, runtime, executorHome, timeoutMs) {
  const snapshot = JSON.parse(await control.command('getOwnedProcessSnapshot', 'body'))
  assert.equal(snapshot.applicationPid, runtime.pid, 'Process diagnostics must belong to this host')
  const workers = snapshot.processes.filter(
    candidate =>
      candidate.parentPid === runtime.pid &&
      candidate.detail?.includes('computer-use-driver-worker.js')
  )
  assert.equal(workers.length, 1, 'Expected one native worker owned by the Wework main process')
  assert.notEqual(workers[0].pid, runtime.pid, 'Native tools must run outside the main process')
  process.kill(workers[0].pid, 'SIGKILL')

  await control.command('waitFor', '[data-testid="computer-use-settings-error"]', { timeoutMs })
  await waitForRuntimeRecordRemoved(executorHome, timeoutMs)
  await assertBridgeStopped(runtime)
  await control.command('waitFor', '[data-testid="app-shell"]', { timeoutMs })

  await control.command('click', TOGGLE_SELECTOR)
  await control.command('waitFor', TOGGLE_SELECTOR, { timeoutMs })
  await waitForAttribute(control, TOGGLE_SELECTOR, 'aria-checked', 'false', timeoutMs)
  await control.command('click', TOGGLE_SELECTOR)
  await control.command('waitFor', TOGGLE_SELECTOR, { timeoutMs })
  await waitForAttribute(control, TOGGLE_SELECTOR, 'aria-checked', 'true', timeoutMs)
  const recovered = await readRuntimeRecord(executorHome, timeoutMs)
  assert.ok(recovered, 'Re-enabling computer use did not restore its private bridge')
  assert.equal(recovered.pid, runtime.pid, 'Native worker failure restarted the main application')
  assert.ok(recovered.token !== runtime.token, 'A recovered bridge reused old authorization')
  await verifyBridge(recovered)
  console.log('[computer-use] Real native worker termination, cleanup, and recovery verified')
  return recovered
}

export function createDesktopScenario({
  captureScreenshot,
  executorHome,
  resultDir,
  workspacePath,
  uiTimeoutMs,
}) {
  let executorBinary
  let lateEnable
  return {
    setExecutorBinary(binary) {
      executorBinary = binary
    },

    async prepareApp({ appEnvironment }) {
      lateEnable = await startComputerUseLateEnable({
        codexBinary: appEnvironment.CODEX_BINARY_PATH,
        executorBinary,
        environment: appEnvironment,
        executorHome,
        resultDir,
        workspacePath,
      })
    },

    async cleanup() {
      await lateEnable?.close()
    },

    async verify(control) {
      await control.command('waitFor', '[data-testid="app-shell"]', {
        timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
      })
      await control.command('navigate', 'body', { value: '/settings/computer-use' })
      await control.command('waitFor', PAGE_SELECTOR, { timeoutMs: uiTimeoutMs })
      await control.command('waitFor', TOGGLE_SELECTOR, { timeoutMs: uiTimeoutMs })
      assert.equal(
        Number(
          await control.command('getElementCount', '[data-testid="computer-use-settings-error"]')
        ),
        0,
        'Computer use failed to load its native driver'
      )

      const nativeState = JSON.parse(await control.command('getNativeWindowState', 'body'))
      if (!['darwin', 'linux', 'win32'].includes(nativeState.platform)) {
        return
      }

      await control.command('click', TOGGLE_SELECTOR)
      await control.command('waitFor', TOGGLE_SELECTOR, { timeoutMs: uiTimeoutMs })
      await waitForAttribute(control, TOGGLE_SELECTOR, 'aria-checked', 'true', uiTimeoutMs)

      await control.command('navigate', 'body', { value: '/' })
      await control.command('navigate', 'body', { value: '/settings/computer-use' })
      await control.command('waitFor', TOGGLE_SELECTOR, { timeoutMs: uiTimeoutMs })
      await waitForAttribute(control, TOGGLE_SELECTOR, 'aria-checked', 'true', uiTimeoutMs)

      let runtime = await readRuntimeRecord(
        executorHome,
        nativeState.platform === 'darwin' ? 1_000 : uiTimeoutMs
      )
      if (runtime) {
        await verifyBridge(runtime)
        await lateEnable.verify()
        runtime = await verifyDriverCrashRecovery(control, runtime, executorHome, uiTimeoutMs)
        await lateEnable.verify()
      }
      if (runtime && nativeState.platform === 'darwin') {
        await verifyComputerUseHostMenu(control, runtime, uiTimeoutMs)
      }
      if (runtime) await verifyComputerUseCancellation(control, runtime, uiTimeoutMs)
      if (nativeState.platform !== 'darwin') {
        assert.ok(runtime, 'Enabled computer use did not publish its private bridge')
      }

      await captureScreenshot(control, 'computer-use-settings.png', PAGE_SELECTOR)
      await control.command('click', TOGGLE_SELECTOR)
      await control.command('waitFor', TOGGLE_SELECTOR, { timeoutMs: uiTimeoutMs })
      await waitForAttribute(control, TOGGLE_SELECTOR, 'aria-checked', 'false', uiTimeoutMs)
      await waitForRuntimeRecordRemoved(executorHome, uiTimeoutMs)
      await assertBridgeStopped(runtime)
      if (runtime) await lateEnable.verifyDisabled()

      await control.command('navigate', 'body', { value: '/' })
      await control.command('navigate', 'body', { value: '/settings/computer-use' })
      await control.command('waitFor', TOGGLE_SELECTOR, { timeoutMs: uiTimeoutMs })
      await waitForAttribute(control, TOGGLE_SELECTOR, 'aria-checked', 'false', uiTimeoutMs)
    },

    diagnostics() {
      return { computerUse: true, lateEnable: lateEnable?.diagnostics() }
    },
  }
}
