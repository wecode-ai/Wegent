import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import JSZip from 'jszip'

const INSTALLATION_ID = 'dsh-e2e-smoke'
const APP_ROUTE = `/app/harness-${INSTALLATION_ID}`

async function createHarnessPackage(resultDir) {
  const packagePath = join(resultDir, 'dsh-e2e-smoke.zip')
  const zip = new JSZip()
  const root = zip.folder('harness-e2e-plugin')
  root.file('PLUGIN.md', '# Harness desktop E2E\n')
  root.file('INSTALL.zh-CN.md', '# 安装\n')
  root.file(
    'plugin-manifest.json',
    JSON.stringify(
      {
        name: INSTALLATION_ID,
        displayName: 'DSH E2E Smoke',
        version: '0.1.0',
        type: 'deepseek-harness-plugin-bundle',
        description: 'Desktop E2E Harness smoke package',
        entry: {
          installPackage: 'packages/bundle/smoke-app',
          profile: 'smoke',
          webUrl: 'http://127.0.0.1:3080/',
        },
        requirements: {
          dsh: '0.1.0-rc.7',
          node: '>=22',
        },
        defaultModel: {
          provider: 'fixture',
          model: 'fixture',
          configPath: '$DSH_HOME/profiles/smoke/cordis.patch.yml',
        },
      },
      null,
      2
    )
  )
  const bundle = root.folder('packages/bundle/smoke-app')
  bundle.file(
    'package.json',
    JSON.stringify(
      {
        name: '@wework/dsh-e2e-smoke',
        version: '0.1.0',
        type: 'module',
        main: 'lib/index.js',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      },
      null,
      2
    )
  )
  bundle.file('lib/index.js', 'export default {}\n')
  bundle.file(
    'cordis.patch.yml',
    '- id: ui-model-selection\n  config:\n    provider: fixture\n    model: fixture\n'
  )
  await writeFile(
    packagePath,
    await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  )
  return packagePath
}

export async function createDesktopScenario({ captureScreenshot, resultDir, uiTimeoutMs }) {
  const packagePath = await createHarnessPackage(resultDir)
  return {
    async verify(control) {
      await control.command('navigate', 'body', { value: '/plugins/manage' })
      await control.command('waitFor', '[data-testid="plugin-management-section-harness"]', {
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(control, 'harness-apps-00-entry.png', 'body')
      await control.command('click', '[data-testid="plugin-management-section-harness"]')
      await control.command('waitFor', '[data-testid="harness-app-drop-zone"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="sidebar-worklists-scroll"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="plugin-management-section-nav"]', {
        text: 'Harness 能力',
        timeoutMs: uiTimeoutMs,
      })
      const harnessManagementSnapshot = JSON.parse(await control.command('snapshot', 'body'))
      assert.ok(
        harnessManagementSnapshot.location.includes('/plugins/manage/harness'),
        `Harness management did not open inside plugin management: ${harnessManagementSnapshot.location}`
      )
      const managementTabId = await control.command(
        'getAttribute',
        '[data-workspace-tab-content][aria-hidden="false"]',
        { value: 'data-workspace-tab-content' }
      )
      assert.ok(managementTabId, 'Harness management page did not expose its workspace tab ID')
      await control.command('dropPaths', '[data-testid="harness-app-drop-zone"]', {
        value: JSON.stringify([
          {
            uri: pathToFileURL(packagePath).href,
            name: 'dsh-e2e-smoke.zip',
            mimeType: 'application/zip',
          },
        ]),
      })
      await control.command('waitFor', '[data-testid="harness-app-preview"]', {
        text: 'DSH E2E Smoke',
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(control, 'harness-apps-01-preview.png', 'body')

      await control.command('clickWhenEnabled', '[data-testid="harness-app-install-confirm"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', `[data-testid="harness-app-start-${INSTALLATION_ID}"]`, {
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(control, 'harness-apps-02-installed.png', 'body')

      await control.command('click', `[data-testid="harness-app-start-${INSTALLATION_ID}"]`)
      await control.command('waitFor', `[data-testid="app-iframe-harness-${INSTALLATION_ID}"]`, {
        timeoutMs: 120_000,
      })
      const snapshot = JSON.parse(await control.command('snapshot', 'body'))
      assert.ok(
        snapshot.location.includes(APP_ROUTE),
        `Harness app did not open in its own tab: ${snapshot.location}`
      )
      const workspaceTabId = await control.command(
        'getAttribute',
        `[data-testid="app-iframe-harness-${INSTALLATION_ID}"]`,
        { value: 'data-workspace-tab-id' }
      )
      assert.ok(workspaceTabId, 'Harness app tab did not expose its workspace tab ID')
      const nativeSnapshot = await control.command('captureEmbeddedBrowser', 'body', {
        value: `app-harness-${INSTALLATION_ID}-${workspaceTabId}`,
        timeoutMs: 30_000,
      })
      assert.ok(
        nativeSnapshot.startsWith('data:image/png;base64,'),
        'Harness native WebView did not produce a screenshot'
      )
      await writeFile(
        join(resultDir, 'harness-apps-03-native-page.png'),
        Buffer.from(nativeSnapshot.slice('data:image/png;base64,'.length), 'base64')
      )

      await control.command('click', `[data-testid="workspace-tab-select-${managementTabId}"]`)
      await control.command('waitFor', `[data-testid="harness-app-stop-${INSTALLATION_ID}"]`, {
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(control, 'harness-apps-04-running.png', 'body')
      await control.command('click', `[data-testid="harness-app-stop-${INSTALLATION_ID}"]`)
      await control.command('waitFor', `[data-testid="harness-app-start-${INSTALLATION_ID}"]`, {
        timeoutMs: 30_000,
      })
      assert.equal(
        Number(
          await control.command(
            'getElementCount',
            `[data-testid="app-iframe-harness-${INSTALLATION_ID}"]`
          )
        ),
        0,
        'Stopping a Harness app left its stale app tab mounted'
      )
      await captureScreenshot(control, 'harness-apps-05-stopped.png', 'body')

      await control.command('click', '[data-testid="plugin-management-section-plugins"]')
      await control.command(
        'waitFor',
        '[data-testid="plugin-management-section-plugins"][aria-current="page"]',
        {
          stableMs: 1000,
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command('waitFor', '[data-testid="plugin-management-page-content"]', {
        stableMs: 1000,
        timeoutMs: uiTimeoutMs,
      })
      const pluginManagementSnapshot = JSON.parse(await control.command('snapshot', 'body'))
      assert.ok(
        pluginManagementSnapshot.location.includes('/plugins/manage'),
        `Harness management did not return to installed plugins: ${pluginManagementSnapshot.location}`
      )
      await captureScreenshot(control, 'harness-apps-06-returned-to-plugins.png', 'body')
    },
  }
}
