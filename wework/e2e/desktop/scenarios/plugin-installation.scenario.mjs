import assert from 'node:assert/strict'
import { createDesktopScenario as createToggleScenario } from './plugin-toggle-persistence.scenario.mjs'
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
  return {
    ...toggle,
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
        await control.command('click', testId('plugins-refresh-button'))
        const install = testId(`plugin-marketplace-install-${release.pluginId}`)
        await control.command('waitFor', install, {
          timeoutMs: options.workbenchReadyTimeoutMs,
        })
        await control.command('clickWhenEnabled', install)
        await control.command('waitFor', testId('plugin-install-unofficial-warning'))
        assert.equal(await accountPlugin(cloud, slug), undefined)
        await control.command('click', testId('install-plugin-dialog-cancel'))
        await control.command('waitFor', install)
        assert.equal(await accountPlugin(cloud, slug), undefined)
        await control.command('clickWhenEnabled', install)
        await control.command('waitFor', testId('plugin-install-unofficial-warning'))
        await control.command('click', testId('install-plugin-dialog-confirm'))
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
      await toggle.verify(control)
    },
  }
}
