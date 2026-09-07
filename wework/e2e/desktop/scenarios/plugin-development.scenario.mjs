import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const STATUS = '[data-testid="wework-plugin-development-sidebar-status"]'
const execFileAsync = promisify(execFile)
const scenarioDirectory = dirname(fileURLToPath(import.meta.url))
const weworkCliPath = resolve(scenarioDirectory, '../../../electron/src/cli/wework-cli.mjs')
const bundledMarketplaceManifestPath = resolve(
  scenarioDirectory,
  '../../../resources/bundled-plugins/wework-personal/.claude-plugin/marketplace.json'
)

async function runWeworkCli(args, projectRoot, registryDirectory) {
  const { stdout } = await execFileAsync(process.execPath, [weworkCliPath, 'desktop', ...args], {
    cwd: projectRoot,
    env: {
      ...process.env,
      WEWORK_DESKTOP_CONTROL_REGISTRY_DIR: registryDirectory,
    },
  })
  return stdout.trim()
}

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

async function readBundledPluginVersion(pluginName) {
  const marketplace = JSON.parse(await readFile(bundledMarketplaceManifestPath, 'utf8'))
  const plugin = marketplace.plugins?.find(candidate => candidate.name === pluginName)
  assert.equal(
    typeof plugin?.version,
    'string',
    `Bundled marketplace is missing a version for ${pluginName}`
  )
  return plugin.version
}

export async function createDesktopScenario({
  captureScreenshot,
  resultDir,
  uiTimeoutMs,
  workbenchReadyTimeoutMs,
}) {
  const developerPluginVersion = await readBundledPluginVersion('wework-plugin-developer')
  const pluginRoot = join(resultDir, 'plugin-development-project')
  const controlRegistry = join(resultDir, 'desktop-control-instances')
  await mkdir(pluginRoot, { recursive: true })
  const website = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end('<!doctype html><title>Plugin website</title><h1>Plugin website loaded</h1>')
  })
  await new Promise((resolvePromise, reject) => {
    website.once('error', reject)
    website.listen(0, '127.0.0.1', resolvePromise)
  })
  const websiteAddress = website.address()
  assert.ok(websiteAddress && typeof websiteAddress !== 'string')
  const websiteUrl = `http://127.0.0.1:${websiteAddress.port}/`

  return {
    appEnvironment: {
      WEWORK_E2E_OPEN_DIALOG_PATH: pluginRoot,
      WEWORK_PLUGIN_DEVELOPMENT_E2E: '1',
      WEWORK_DESKTOP_CONTROL_REGISTRY_DIR: controlRegistry,
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
      assert.deepEqual(marker, { schemaVersion: 1, kind: 'wework-core-dsh-plugin' })
      assert.equal(manifest.name, '@wework/plugin-development-project')
      assert.equal(manifest.wework, undefined)
      assert.deepEqual(manifest.files, ['client.js', 'cordis.patch.yml', 'index.js'])

      await control.command('waitFor', '[data-testid="wework-plugin-development-sidebar"]', {
        timeoutMs: workbenchReadyTimeoutMs,
        visible: true,
      })
      const developerPluginChip = '[data-testid="composer-plugin-chip-wework-plugin-developer"]'
      await control.command('waitFor', developerPluginChip, {
        text: 'Wework 插件开发',
        timeoutMs: workbenchReadyTimeoutMs,
        visible: true,
      })
      assert.equal(
        await control.command('getAttribute', developerPluginChip, {
          value: 'data-composer-plugin-name',
        }),
        'wework-plugin-developer',
        'The initial development prompt did not activate the Wework plugin developer plugin'
      )
      assert.equal(
        await control.command('getAttribute', developerPluginChip, {
          value: 'data-composer-plugin-marketplace',
        }),
        'wework-personal',
        'The initial development prompt activated the plugin from the wrong marketplace'
      )
      assert.equal(
        Number(await control.command('getElementCount', '[data-testid^="composer-skill-chip-"]')),
        0,
        'The initial development prompt activated a Skill instead of only activating the plugin'
      )
      assert.equal(
        await control.command('getValue', '[data-testid="chat-message-input"]'),
        'Wework 插件开发 开发这个 Wework 插件：',
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
      control.setScenario('plugin_development')
      await control.command('clickWhenEnabled', '[data-testid="send-message-button"]', {
        timeoutMs: workbenchReadyTimeoutMs,
        visible: true,
      })
      await control.command('waitFor', '[data-testid="message-user"]', {
        text: '开发这个 Wework 插件',
        timeoutMs: workbenchReadyTimeoutMs,
        visible: true,
      })
      await control.command('waitFor', '[data-testid="wework-plugin-development-sidebar"]', {
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
      await control.command('waitFor', '[data-testid="wework-plugin-development-debug-target"]', {
        text: 'Wework 调试实例（运行端）',
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
      await captureScreenshot(
        control,
        'plugin-development-03-message-sent-panel-retained.png',
        'body'
      )

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
        developerPluginVersion,
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
      const instances = JSON.parse(await runWeworkCli(['instances'], pluginRoot, controlRegistry))
      assert.ok(
        instances.some(
          instance =>
            instance.instanceId === `plugin-development-${isolatedInstanceId}` &&
            instance.projectRoot === pluginRoot &&
            instance.token === undefined
        ),
        'The general Wework CLI did not discover the isolated plugin development instance'
      )
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
        'scrollIntoView',
        '[data-testid="wework-plugin-development-diagnostics-toggle"]'
      )
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
          '    apply(ctx) {',
          "      ctx.slots.inject('wework.workspace.sidebar.tab', () =>",
          "        ctx.wework.contributions.register(ctx, 'wework.workspace.sidebar.tab', {",
          "          id: 'plugin-development-browser',",
          "          label: 'Plugin website',",
          "          mode: 'iframe',",
          `          url: ${JSON.stringify(websiteUrl)},`,
          '        })',
          '      )',
          "      ctx.slots.inject('wework.sidebar.navigation', () =>",
          "        ctx.wework.contributions.register(ctx, 'wework.sidebar.navigation', {",
          "          id: 'plugin-development-browser.navigation',",
          "          icon: 'globe',",
          "          label: 'Plugin website',",
          "          testId: 'plugin-development-browser-navigation',",
          "          workspaceSidebarTab: 'plugin-development-browser',",
          '        })',
          '      )',
          "      const marker = document.createElement('button')",
          "      marker.dataset.testid = 'plugin-development-hmr-behavior'",
          "      marker.textContent = 'Plugin HMR behavior loaded'",
          "      marker.addEventListener('click', () => { marker.textContent = 'Plugin controlled by Wework CLI' })",
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
      await control.commandForWindow(
        isolatedWindowLabel,
        'waitFor',
        '[data-testid="plugin-development-browser-navigation"]',
        {
          visible: true,
        }
      )
      const dshSlots = JSON.parse(
        await control.commandForWindow(
          isolatedWindowLabel,
          'getAttribute',
          '[data-testid="wework-dsh-root"]',
          { value: 'data-wework-dsh-slots' }
        )
      )
      assert.ok(
        dshSlots['wework.sidebar.navigation']?.includes('plugin-development-browser.navigation'),
        'The reloaded Wework shell did not expose the plugin navigation contribution'
      )
      assert.ok(
        dshSlots['wework.workspace.sidebar.tab']?.includes('plugin-development-browser'),
        'The reloaded Wework shell did not expose the plugin workspace sidebar contribution'
      )
      const routeBeforeSidebarOpen = await control.commandForWindow(isolatedWindowLabel, 'getRoute')
      await control.commandForWindow(
        isolatedWindowLabel,
        'click',
        '[data-testid="plugin-development-browser-navigation"]',
        { visible: true }
      )
      await control.commandForWindow(
        isolatedWindowLabel,
        'waitFor',
        '[data-testid="right-workspace-extension-panel-plugin-development-browser"]',
        {
          visible: true,
        }
      )
      await control.commandForWindow(
        isolatedWindowLabel,
        'waitFor',
        '[data-testid="app-iframe-workspace-sidebar-plugin-development-browser"]',
        {
          visible: true,
        }
      )
      assert.equal(
        await control.commandForWindow(isolatedWindowLabel, 'getRoute'),
        routeBeforeSidebarOpen,
        'Opening a workspace sidebar iframe changed the active workspace route'
      )
      assert.equal(
        await control.commandForWindow(
          isolatedWindowLabel,
          'getAttribute',
          '[data-testid="app-iframe-workspace-sidebar-plugin-development-browser"]',
          { value: 'data-src' }
        ),
        websiteUrl,
        'The workspace sidebar iframe did not use the contributed URL'
      )
      control.activateWindow(isolatedWindowLabel)
      await captureScreenshot(control, 'plugin-development-06-hmr-behavior.png', 'body')
      const cliInspect = JSON.parse(
        await runWeworkCli(
          ['inspect', '--project', pluginRoot, '--interactive', 'true'],
          pluginRoot,
          controlRegistry
        )
      )
      assert.equal(
        cliInspect.kind,
        'browser.inspect',
        'The general Wework CLI returned an unexpected inspect payload'
      )
      assert.match(
        cliInspect.inspectId,
        /^wk-inspect-/,
        'The general Wework CLI did not register inspect targets for the child UI'
      )
      assert.ok(
        cliInspect.nodes.some(
          node =>
            node.name === 'Plugin HMR behavior loaded' &&
            node.role === 'button' &&
            node.actionable === true
        ),
        'The general Wework CLI did not inspect the HMR control in the child UI'
      )
      await runWeworkCli(
        [
          'click',
          '--project',
          pluginRoot,
          '--selector',
          '[data-testid="plugin-development-hmr-behavior"]',
        ],
        pluginRoot,
        controlRegistry
      )
      await runWeworkCli(
        [
          'wait',
          '--project',
          pluginRoot,
          '--selector',
          '[data-testid="plugin-development-hmr-behavior"]',
          '--text',
          'Plugin controlled by Wework CLI',
        ],
        pluginRoot,
        controlRegistry
      )
      await runWeworkCli(
        [
          'screenshot',
          '--project',
          pluginRoot,
          '--output',
          join(resultDir, 'plugin-development-07-cli-controlled-instance.png'),
        ],
        pluginRoot,
        controlRegistry
      )
      control.activateWindow('main')
      await control.command('click', '[data-testid="wework-plugin-development-filter-hmr"]', {
        visible: true,
      })
      await control.command('waitFor', '[data-testid="wework-plugin-development-event-hmr"]', {
        text: 'HMR 更新已接受',
        timeoutMs: uiTimeoutMs,
        visible: true,
      })
      await captureScreenshot(control, 'plugin-development-08-hmr-applied.png', 'body')

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
      await captureScreenshot(control, 'plugin-development-09-stop-confirmation.png', 'body')
      await control.command(
        'clickWhenEnabled',
        '[data-testid="wework-plugin-development-sidebar-stop"]',
        {
          timeoutMs: workbenchReadyTimeoutMs,
          visible: true,
        }
      )
      await waitForStatus(control, '未运行 · HMR 1', workbenchReadyTimeoutMs)
      await captureScreenshot(control, 'plugin-development-10-debug-stopped-after-hmr.png', 'body')
    },

    async cleanup() {
      await new Promise(resolvePromise => website.close(resolvePromise))
    },
  }
}
