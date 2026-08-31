import { app, BrowserWindow } from 'electron'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { HostCapabilityRouter } from '../dist/host/capability-router.js'
import { HostPipeServer } from '../dist/host/host-pipe.js'
import { DesktopRuntime } from '../dist/runtime/desktop-runtime.js'

const runtimeRoot = process.argv[2]
const executorPath = process.argv[3]
if (!runtimeRoot || !executorPath) {
  await exitBeforeReady(
    new Error('Usage: pnpm verify:core-ui <materialized-core-runtime-root> <executor-binary>')
  )
}

const root = await mkdtemp(join(tmpdir(), 'wework-workbench-ui-'))
app.setPath('userData', join(root, 'electron-user-data'))
try {
  await Promise.race([
    app.whenReady(),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error('Electron did not become ready in the current desktop session')),
        15_000
      )
    ),
  ])
} catch (error) {
  await rm(root, { recursive: true, force: true })
  await exitBeforeReady(error)
}

const router = new HostCapabilityRouter()
router.register('app.getVersion', () => ({ version: 'workbench-ui-smoke' }))
router.grant('@wegent/dsh-app-wework', ['app.getVersion'])
const runtime = new DesktopRuntime({
  environment: {
    ...process.env,
    DSH_TELEMETRY_DISABLED: '1',
    WEWORK_EXECUTOR_PATH: resolve(executorPath),
    WEWORK_HARNESS_RUNTIME_ROOT: resolve(runtimeRoot),
    WEGENT_EXECUTOR_HOME: join(root, 'executor-home'),
  },
  dataDirectory: join(root, 'user-data'),
  logDirectory: join(root, 'logs'),
  hostPipe: new HostPipeServer(router),
})
let window = null

try {
  await runtime.start()
  const before = runtime.diagnostics()
  if (!before.coreDshPid || !before.executorPid) {
    throw new Error(`Managed process IDs are unavailable: ${JSON.stringify(before)}`)
  }
  window = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })
  await window.loadURL(runtime.coreDshUrl())
  await waitFor(window, `Boolean(document.querySelector('[data-testid="workspace-tab-strip"]'))`)
  const initial = await snapshot(window)
  assertEqual(initial.fixedTabs, 3, 'fixed tab count')
  assertEqual(initial.closeButtons, 0, 'fixed tab close button count')
  assertEqual(initial.activeTab, 'fixed-task', 'initial active tab')

  await click(window, 'workspace-tab-select-fixed-board')
  await waitFor(
    window,
    `document.querySelector('[data-testid="workspace-tab-select-fixed-board"]')?.getAttribute('aria-selected') === 'true'`
  )
  const afterFixedSwitch = runtime.diagnostics()
  assertDeepEqual(afterFixedSwitch, before, 'process IDs after fixed tab switch')

  await click(window, 'workspace-tab-select-fixed-task')
  await click(window, 'workspace-tab-select-fixed-board')
  await window.webContents.reload()
  await waitFor(
    window,
    `document.querySelector('[data-testid="workspace-tab-select-fixed-board"]')?.getAttribute('aria-selected') === 'true'`
  )
  const afterReload = runtime.diagnostics()
  assertDeepEqual(afterReload, before, 'process IDs after renderer reload')

  await click(window, 'workspace-tab-select-fixed-agent')
  const afterAgentSwitch = runtime.diagnostics()
  assertDeepEqual(afterAgentSwitch, before, 'process IDs after agent tab switch')

  console.log(
    JSON.stringify(
      {
        version: 'core',
        coreDshUrl: runtime.coreDshUrl(),
        processes: before,
        initial,
        restoredActiveTab: 'fixed-board',
        agentTabAvailable: await window.webContents.executeJavaScript(
          `document.querySelector('[data-testid="workspace-tab-select-fixed-agent"]')?.getAttribute('data-unavailable') !== 'true'`
        ),
      },
      null,
      2
    )
  )
} catch (error) {
  for (const name of ['executor.log', 'dsh-core-runtime.log']) {
    try {
      console.error(await readFile(join(root, 'logs', name), 'utf8'))
    } catch {
      // The failed runtime may not have created its log yet.
    }
  }
  throw error
} finally {
  window?.destroy()
  await runtime.stop()
  await rm(root, { recursive: true, force: true })
  app.quit()
}

async function click(targetWindow, testId) {
  const clicked = await targetWindow.webContents.executeJavaScript(
    `(() => {
      const target = document.querySelector(${JSON.stringify(`[data-testid="${testId}"]`)})
      if (!(target instanceof HTMLElement)) return false
      target.click()
      return true
    })()`
  )
  if (!clicked) throw new Error(`Unable to click ${testId}`)
}

async function snapshot(targetWindow) {
  return targetWindow.webContents.executeJavaScript(`(() => {
    const tabs = [...document.querySelectorAll('[role="tab"]')]
    return {
      totalTabs: tabs.length,
      fixedTabs: tabs.filter(tab => tab.getAttribute('data-testid')?.startsWith('workspace-tab-select-fixed-')).length,
      closeButtons: document.querySelectorAll('[data-testid^="workspace-tab-close-"]').length,
      activeTab: tabs.find(tab => tab.getAttribute('aria-selected') === 'true')
        ?.getAttribute('data-testid')?.replace('workspace-tab-select-', '') || null,
    }
  })()`)
}

async function waitFor(targetWindow, expression) {
  let lastValue
  for (let attempt = 0; attempt < 120; attempt += 1) {
    lastValue = await targetWindow.webContents.executeJavaScript(`Boolean(${expression})`)
    if (lastValue) return
    await new Promise(resolvePromise => setTimeout(resolvePromise, 250))
  }
  throw new Error(`Timed out waiting for renderer expression: ${expression}`)
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(
      `${label} mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    )
  }
}

function assertDeepEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${label} mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    )
  }
}

async function exitBeforeReady(error) {
  console.error(error)
  setImmediate(() => app.exit(1))
  await new Promise(() => {})
}
