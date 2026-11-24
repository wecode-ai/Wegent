import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createDesktopScenario as createToggleScenario } from './plugin-toggle-persistence.scenario.mjs'
import {
  authorPluginImportPath,
  importPersonalSource,
  verifyPersonalPluginVersionSubmission,
} from '../modules/plugin-personal-version-flow.mjs'
import {
  verifyInstalledPersonalPluginDeletion,
  verifyPersonalPublicationDeletion,
} from '../modules/plugin-personal-uninstall-flow.mjs'
import { resultDir } from '../modules/shared.mjs'
import { TransportFaultProxy } from '../modules/transport-fault-proxy.mjs'
import { signInDesktopCloud } from '../modules/desktop-cloud-login.mjs'
import {
  accountPlugin,
  openPlugin,
  pluginApi,
  testId,
} from '../modules/plugin-regression-fixture.mjs'

// Extend the CI-covered installation checkpoint without changing its existing assertions.
export function createDesktopScenario(options) {
  const toggle = createToggleScenario(options)
  let cloud
  let apiProxy
  const publicationDeletion = {}
  const installedDeletion = {}
  return {
    ...toggle,
    appEnvironment: {
      ...toggle.appEnvironment,
      WEWORK_E2E_OPEN_DIALOG_PATH: authorPluginImportPath,
    },
    setCloudEnvironment(value) {
      cloud = value
      toggle.setCloudEnvironment(value)
    },
    async verify(control) {
      await cloud.waitForConnectedAppDevice()
      const slug = 'unofficial-install-warning-e2e'
      const release = await cloud.publishPluginRelease({
        slug,
        version: '1.0.0',
        skills: { [slug]: 'Verify unofficial plugin installation confirmation' },
      })
      const fixture = { ...release, slug }
      try {
        await openPlugin(control, fixture)
        await control.command('clickWhenEnabled', testId('plugins-refresh-button'), {
          timeoutMs: options.workbenchReadyTimeoutMs,
        })
        const install = testId(`plugin-marketplace-install-${release.pluginId}`)
        await control.command('waitFor', install, {
          timeoutMs: options.workbenchReadyTimeoutMs,
        })
        // Refresh keeps the catalog visible while reconciliation blocks installs.
        await control.command('clickWhenEnabled', install)
        await control.command('waitFor', testId('plugin-install-unofficial-warning'))
        assert.equal(await accountPlugin(cloud, slug), undefined)
        await control.command('click', testId('install-plugin-dialog-cancel'))
        await control.command('waitFor', install)
        assert.equal(await accountPlugin(cloud, slug), undefined)
        await control.command('clickWhenEnabled', install)
        await control.command('waitFor', testId('plugin-install-unofficial-warning'))
        await control.command('clickWhenEnabled', testId('install-plugin-dialog-confirm'), {
          timeoutMs: options.workbenchReadyTimeoutMs,
        })
        await control.command('waitFor', testId(`plugin-marketplace-actions-${release.pluginId}`), {
          timeoutMs: options.workbenchReadyTimeoutMs,
        })
        assert.ok(await accountPlugin(cloud, slug), 'Confirmation must install the real plugin')
      } finally {
        const installed = await accountPlugin(cloud, slug)
        if (installed) {
          await pluginApi(cloud, `/plugins/installed/${installed.metadata.labels.id}`, 'DELETE')
        }
      }
      await verifyPersonalPluginVersionSubmission({
        cloudEnvironment: cloud,
        control,
        executorHome: options.executorHome,
        codexHome: join(options.executorHome, 'codex'),
        userDataDirectory: options.electronUserDataDirectory,
        restartDesktopApp: options.restartDesktopApp,
        verifySharedLifecycle: async restartDesktopApp => {
          toggle.setRestartDesktopApp(restartDesktopApp)
          await toggle.verify(control)
        },
      })
      apiProxy = await new TransportFaultProxy(cloud.backendUrl).start()
      await signInDesktopCloud(control, cloud, { backendUrl: apiProxy.url })
      const prepareSource = async name => {
        const root = join(resultDir, 'personal-publication-delete-fixture')
        await mkdir(root, { recursive: true })
        await importPersonalSource(control, root, '1.0.0', false, name, name)
      }
      await verifyPersonalPublicationDeletion({
        cloud,
        control,
        apiProxy,
        report: publicationDeletion,
        prepareSource,
      })
      await verifyInstalledPersonalPluginDeletion({
        cloud,
        control,
        prepareSource,
        report: installedDeletion,
      })
    },
    diagnostics: () => ({ publicationDeletion, installedDeletion, requests: apiProxy?.requests }),
    async cleanup() {
      await apiProxy?.stop()
    },
  }
}
