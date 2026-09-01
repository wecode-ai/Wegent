import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

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

export function createDesktopScenario({ captureScreenshot, executorHome, uiTimeoutMs }) {
  return {
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

      const runtime = await readRuntimeRecord(
        executorHome,
        nativeState.platform === 'darwin' ? 1_000 : uiTimeoutMs
      )
      if (runtime) await verifyBridge(runtime)
      if (nativeState.platform !== 'darwin') {
        assert.ok(runtime, 'Enabled computer use did not publish its private bridge')
      }

      await captureScreenshot(control, 'computer-use-settings.png', PAGE_SELECTOR)
      await control.command('click', TOGGLE_SELECTOR)
      await control.command('waitFor', TOGGLE_SELECTOR, { timeoutMs: uiTimeoutMs })
      await waitForAttribute(control, TOGGLE_SELECTOR, 'aria-checked', 'false', uiTimeoutMs)
    },

    diagnostics() {
      return { computerUse: true }
    },
  }
}
