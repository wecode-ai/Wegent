import assert from 'node:assert/strict'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const PLUGIN_ID = 'wework-plugin-developer@wework-personal'
const INSTALL_BUTTON = `[data-testid="plugin-marketplace-install-${PLUGIN_ID}"]`
const ACTIONS_BUTTON = `[data-testid="plugin-marketplace-actions-${PLUGIN_ID}"]`
const DEBUG_OPTION =
  '[data-testid="right-workspace-extension-option-wework-plugin-developer.debug"]'
const STATUS = '[data-testid="wework-plugin-development-sidebar-status"]'

async function waitForSnapshot(control, predicate, message, timeoutMs) {
  const startedAt = Date.now()
  let lastSnapshot = null
  while (Date.now() - startedAt < timeoutMs) {
    lastSnapshot = JSON.parse(await control.command('snapshot', 'body'))
    if (predicate(lastSnapshot)) return lastSnapshot
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`${message}; last snapshot: ${JSON.stringify(lastSnapshot)}`)
}

async function waitForStatus(control, expected, timeoutMs) {
  await control.command('waitFor', STATUS, {
    text: expected,
    timeoutMs,
    visible: true,
  })
  const status = await control.command('getText', STATUS, { visible: true })
  assert.ok(status.includes(expected), `Unexpected plugin development status: ${status}`)
}

async function waitForFile(path, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await access(path)
      return
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for generated plugin file: ${path}`)
}

export async function createDesktopScenario({
  captureScreenshot,
  resultDir,
  uiTimeoutMs,
  workbenchReadyTimeoutMs,
}) {
  const pluginRoot = join(resultDir, 'plugin-development-project')
  await mkdir(pluginRoot, { recursive: true })

  return {
    appEnvironment: {
      WEWORK_E2E_OPEN_DIALOG_PATH: pluginRoot,
    },

    async verify(control) {
      await control.command('waitFor', '[data-testid="plugins-button"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await control.command('click', '[data-testid="plugins-button"]')
      await control.command('waitFor', '[data-testid="plugins-search-input"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await control.command('fill', '[data-testid="plugins-search-input"]', {
        value: 'Wework 插件开发',
      })
      await control.command('waitFor', INSTALL_BUTTON, {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await captureScreenshot(control, 'plugin-development-01-marketplace.png', 'body')

      await control.command('click', INSTALL_BUTTON)
      await control.command('waitFor', '[data-testid="install-plugin-dialog-confirm"]', {
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(control, 'plugin-development-02-install-confirmation.png', 'body')
      await control.command('clickWhenEnabled', '[data-testid="install-plugin-dialog-confirm"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await control.command('waitFor', ACTIONS_BUTTON, {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await captureScreenshot(control, 'plugin-development-03-installed.png', 'body')

      await control.command('click', '[data-testid="plugins-manage-button"]')
      await control.command('waitFor', '[data-testid="plugin-management-surface-core-dsh"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await control.command('click', '[data-testid="plugin-management-surface-core-dsh"]')
      await control.command('waitFor', '[data-testid="wework-plugin-developer-create-button"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await captureScreenshot(control, 'plugin-development-04-create-entry.png', 'body')

      await control.command(
        'clickWhenEnabled',
        '[data-testid="wework-plugin-developer-create-button"]',
        {
          timeoutMs: workbenchReadyTimeoutMs,
        }
      )
      const markerPath = join(pluginRoot, '.wework', 'plugin-development.json')
      await waitForFile(markerPath, workbenchReadyTimeoutMs)
      await control.command('waitFor', '[data-testid="project-work-button"]', {
        text: 'plugin-development-project',
        timeoutMs: workbenchReadyTimeoutMs,
        visible: true,
      })
      const marker = JSON.parse(await readFile(markerPath, 'utf8'))
      const manifest = JSON.parse(await readFile(join(pluginRoot, 'package.json'), 'utf8'))
      const codexManifest = JSON.parse(
        await readFile(join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8')
      )
      assert.deepEqual(marker, { schemaVersion: 1, kind: 'wework-core-dsh-plugin' })
      assert.equal(manifest.name, '@wework/plugin-development-project')
      assert.equal(codexManifest.name, 'plugin-development-project')

      await waitForSnapshot(
        control,
        snapshot => snapshot.testIds.includes('toggle-right-workspace-panel-button'),
        'The plugin project conversation did not expose the right workspace',
        workbenchReadyTimeoutMs
      )
      await control.command('click', '[data-testid="toggle-right-workspace-panel-button"]')
      await control.command('waitFor', DEBUG_OPTION, {
        timeoutMs: workbenchReadyTimeoutMs,
        visible: true,
      })
      await captureScreenshot(control, 'plugin-development-05-debug-option.png', 'body')
      await control.command('click', DEBUG_OPTION, { visible: true })
      await control.command('waitFor', '[data-testid="wework-plugin-development-sidebar"]', {
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
      await captureScreenshot(control, 'plugin-development-06-debug-stopped.png', 'body')

      await control.command(
        'clickWhenEnabled',
        '[data-testid="wework-plugin-development-sidebar-start"]',
        { timeoutMs: workbenchReadyTimeoutMs, visible: true }
      )
      await waitForStatus(control, 'ready · HMR 0', workbenchReadyTimeoutMs)
      const focusSnapshot = JSON.parse(await control.command('getWindowFocusSnapshot', 'body'))
      assert.equal(
        focusSnapshot.mainFocused,
        false,
        'Starting plugin debugging did not focus the isolated Wework instance'
      )
      await control.command('focusMainWindow', 'body')
      await captureScreenshot(control, 'plugin-development-07-debug-ready.png', 'body')

      const clientPath = join(pluginRoot, 'client.js')
      const client = await readFile(clientPath, 'utf8')
      await writeFile(clientPath, `${client}\n// desktop-e2e-hmr-generation-1\n`)
      await waitForStatus(control, 'ready · HMR 1', workbenchReadyTimeoutMs)
      await captureScreenshot(control, 'plugin-development-08-hmr-applied.png', 'body')

      await control.command(
        'clickWhenEnabled',
        '[data-testid="wework-plugin-development-sidebar-stop"]',
        { timeoutMs: workbenchReadyTimeoutMs, visible: true }
      )
      await waitForStatus(control, 'stopped · HMR 1', workbenchReadyTimeoutMs)
      await captureScreenshot(control, 'plugin-development-09-debug-stopped-after-hmr.png', 'body')
    },
  }
}
