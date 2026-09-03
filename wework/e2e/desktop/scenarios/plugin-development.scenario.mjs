import assert from 'node:assert/strict'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const STATUS = '[data-testid="wework-plugin-development-sidebar-status"]'

async function waitForStatus(control, expected, timeoutMs) {
  await control.commandForWindow('main', 'waitFor', STATUS, {
    text: expected,
    timeoutMs,
    visible: true,
  })
  const status = await control.commandForWindow('main', 'getText', STATUS, { visible: true })
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
      WEWORK_PLUGIN_DEVELOPMENT_E2E: '1',
    },

    async verify(control) {
      await control.command('waitFor', '[data-testid="plugins-button"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await control.command('click', '[data-testid="plugins-button"]')
      await control.command('waitFor', '[data-testid="plugins-manage-button"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await control.command('click', '[data-testid="plugins-manage-button"]')
      await control.command('waitFor', '[data-testid="plugin-management-surface-core-dsh"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await control.command('click', '[data-testid="plugin-management-surface-core-dsh"]')
      await control.command('waitFor', '[data-testid="wework-plugin-developer-create-button"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await captureScreenshot(control, 'plugin-development-01-create-entry.png', 'body')

      const readyCountBeforeStart = control.readyCount
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
        await readFile(join(pluginRoot, 'codex-plugin', '.codex-plugin', 'plugin.json'), 'utf8')
      )
      assert.deepEqual(marker, { schemaVersion: 1, kind: 'wework-core-dsh-plugin' })
      assert.equal(manifest.name, '@wework/plugin-development-project')
      assert.deepEqual(manifest.wework, { codexPlugin: './codex-plugin' })
      assert.equal(codexManifest.name, 'plugin-development-project')
      assert.deepEqual(Object.keys(codexManifest), [
        'name',
        'version',
        'description',
        'author',
        'skills',
        'interface',
      ])
      assert.equal(codexManifest.wework, undefined)
      assert.equal(codexManifest.dsh, undefined)

      await control.command('waitFor', '[data-testid="wework-plugin-development-sidebar"]', {
        timeoutMs: workbenchReadyTimeoutMs,
        visible: true,
      })
      assert.equal(
        await control.command('getValue', '[data-testid="chat-message-input"]'),
        '开发这个 Wework 插件：',
        'The plugin project conversation did not receive its initial development prompt'
      )
      await control.command('waitFor', '[data-testid="wework-plugin-development-debug-target"]', {
        text: 'Wework 调试实例（运行端）',
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
      await control.command('waitFor', '[data-testid="wework-plugin-development-lifecycle"]', {
        text: '项目已注册',
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
      await captureScreenshot(control, 'plugin-development-02-debug-opened.png', 'body')

      await control.command(
        'clickWhenEnabled',
        '[data-testid="wework-plugin-development-sidebar-start"]',
        { timeoutMs: workbenchReadyTimeoutMs, visible: true }
      )
      const isolatedReady = await control.awaitReadyAfter(readyCountBeforeStart)
      assert.ok(
        isolatedReady.windowLabel.startsWith('plugin-development-'),
        `Unexpected plugin development window label: ${isolatedReady.windowLabel}`
      )
      const isolatedWindowLabel = isolatedReady.windowLabel
      const isolatedInstanceId = isolatedWindowLabel.slice('plugin-development-'.length)
      const installedDeveloperManifestPath = join(
        resultDir,
        'electron-user-data',
        'plugin-development',
        isolatedInstanceId,
        'user-data',
        'executor-home',
        'codex',
        'plugins',
        'cache',
        'wework-personal',
        'wework-plugin-developer',
        '0.1.0',
        '.codex-plugin',
        'plugin.json'
      )
      await waitForFile(installedDeveloperManifestPath, workbenchReadyTimeoutMs)
      const installedDeveloperManifest = JSON.parse(
        await readFile(installedDeveloperManifestPath, 'utf8')
      )
      assert.equal(installedDeveloperManifest.name, 'wework-plugin-developer')
      assert.equal(installedDeveloperManifest.wework, undefined)
      assert.equal(installedDeveloperManifest.dsh, undefined)
      control.activateWindow('main')
      await waitForStatus(control, '运行中 · HMR 0', workbenchReadyTimeoutMs)
      const focusSnapshot = JSON.parse(await control.command('getWindowFocusSnapshot', 'body'))
      assert.equal(
        focusSnapshot.mainFocused,
        false,
        'Starting plugin debugging did not focus the isolated Wework instance'
      )
      await control.command('focusMainWindow', 'body')
      await control.command('waitFor', '[data-testid="wework-plugin-development-live-status"]', {
        text: '实时状态',
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
      await control.command('waitFor', '[data-testid="wework-plugin-development-activity"]', {
        text: 'Core DSH 已连接',
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
      await captureScreenshot(control, 'plugin-development-04-debug-ready.png', 'body')
      await control.command('click', '[data-testid="wework-plugin-development-filter-errors"]', {
        visible: true,
      })
      await control.command('waitFor', '[data-testid="wework-plugin-development-events-empty"]', {
        text: '暂无错误',
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
      await control.command('click', '[data-testid="wework-plugin-development-filter-all"]', {
        visible: true,
      })
      await control.command(
        'click',
        '[data-testid="wework-plugin-development-diagnostics-toggle"]',
        { visible: true }
      )
      await control.command(
        'waitFor',
        '[data-testid="wework-plugin-development-sidebar-restart"]',
        {
          text: '重启 Core DSH',
          timeoutMs: uiTimeoutMs,
          visible: true,
        }
      )
      await captureScreenshot(control, 'plugin-development-05-debug-diagnostics.png', 'body')

      const clientPath = join(pluginRoot, 'client.js')
      const client = await readFile(clientPath, 'utf8')
      assert.ok(client.includes('    apply() {},'), 'Generated plugin client apply hook is missing')
      const changedClient = client.replace(
        '    apply() {},',
        [
          '    apply() {',
          "      const marker = document.createElement('div')",
          "      marker.dataset.testid = 'plugin-development-hmr-behavior'",
          "      marker.textContent = 'Plugin HMR behavior loaded'",
          "      marker.style.cssText = 'position:fixed;right:24px;bottom:24px;z-index:2147483647;padding:12px 16px;border-radius:10px;background:#111827;color:#fff;font:600 14px system-ui;box-shadow:0 10px 30px rgba(0,0,0,.3)'",
          '      document.body.appendChild(marker)',
          '    },',
        ].join('\n')
      )
      const readyCountBeforeHmr = control.readyCount
      await writeFile(clientPath, changedClient)
      await waitForStatus(control, '运行中 · HMR 1', workbenchReadyTimeoutMs)
      await control.awaitReadyAfter(readyCountBeforeHmr)
      await control.commandForWindow(
        isolatedWindowLabel,
        'waitFor',
        '[data-testid="plugin-development-hmr-behavior"]',
        {
          text: 'Plugin HMR behavior loaded',
          timeoutMs: workbenchReadyTimeoutMs,
          visible: true,
        }
      )
      control.activateWindow(isolatedWindowLabel)
      await captureScreenshot(control, 'plugin-development-06-hmr-behavior.png', 'body')
      control.activateWindow('main')
      await control.command('click', '[data-testid="wework-plugin-development-filter-hmr"]', {
        visible: true,
      })
      await control.command('waitFor', '[data-testid="wework-plugin-development-event-hmr"]', {
        text: 'HMR 更新已接受',
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
      await captureScreenshot(control, 'plugin-development-07-hmr-applied.png', 'body')

      await control.command('click', '[data-testid="wework-plugin-development-sidebar-more"]', {
        visible: true,
      })
      await control.command(
        'click',
        '[data-testid="wework-plugin-development-sidebar-stop-request"]',
        { visible: true }
      )
      await control.command('waitFor', '[data-testid="wework-plugin-development-sidebar-stop"]', {
        text: '确认停止',
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
      await captureScreenshot(control, 'plugin-development-08-stop-confirmation.png', 'body')
      await control.command(
        'clickWhenEnabled',
        '[data-testid="wework-plugin-development-sidebar-stop"]',
        {
          timeoutMs: workbenchReadyTimeoutMs,
          visible: true,
        }
      )
      await waitForStatus(control, '未运行 · HMR 1', workbenchReadyTimeoutMs)
      await captureScreenshot(control, 'plugin-development-09-debug-stopped-after-hmr.png', 'body')
    },
  }
}
