import assert from 'node:assert/strict'
import {
  refreshPluginInventory,
  verifyPluginTogglePersistence,
} from '../modules/plugin-inventory-state.mjs'
import {
  accountPlugin,
  installFixture,
  inventory,
  openPlugin,
  testId,
  until,
} from '../modules/plugin-regression-fixture.mjs'
import { createPluginSkillHotUpdate } from '../modules/plugin-skill-hot-update.mjs'

async function verifyComponentTogglePersistence(
  control,
  cloud,
  fixture,
  hotUpdate,
  running = false
) {
  const componentKey = `skill:${fixture.slug}`
  const toggle = testId(`plugin-component-toggle-${componentKey}`)
  const checked = enabled => `${toggle}[aria-checked="${enabled}"]`
  const openDetail = async enabled => {
    await openPlugin(control, fixture)
    await control.command('click', testId(`plugin-marketplace-row-${fixture.pluginId}`))
    await control.command('waitFor', checked(enabled))
  }
  await openDetail(true)
  // Assert each edit before navigation so cached package data cannot override it.
  for (const enabled of [false, true]) {
    if (running) {
      await hotUpdate.hold(control, !enabled)
      await openDetail(!enabled)
    }
    const revision = (await inventory(control)).sharedInventory.mutationRevision
    assert.ok(
      Number.isSafeInteger(revision) && revision >= 0,
      'Plugin inventory must expose a non-negative mutation revision'
    )
    await control.command('click', toggle)
    await until(
      () => inventory(control),
      state => {
        const shared = state.sharedInventory
        const plugin = shared.installedPlugins.find(item => item.pluginKey === fixture.slug)
        return (
          shared.mutationRevision > revision && plugin?.componentStates?.[componentKey] === enabled
        )
      },
      `Skill enabled=${enabled} mutation did not finish`
    )
    await until(
      () => accountPlugin(cloud, fixture.slug),
      plugin => plugin?.spec.componentStates?.[componentKey] === enabled,
      `Skill enabled=${enabled} did not persist to the backend`
    )
    await control.command('waitFor', checked(enabled))
    await hotUpdate.verify(control, enabled)
    await openDetail(enabled)
  }
  await control.command('click', testId('plugin-detail-back-button'))
  await refreshPluginInventory(control)
  await openDetail(true)
  await control.command('click', testId('plugin-detail-back-button'))
}

export function createDesktopScenario(options) {
  const { captureScreenshot, workbenchReadyTimeoutMs } = options
  const hotUpdate = createPluginSkillHotUpdate(options)
  let cloud
  let restartDesktopApp
  return {
    requiresCloudEnvironment: true,
    handleHttp: hotUpdate.handleHttp,
    setCloudEnvironment(value) {
      cloud = value
    },
    setRestartDesktopApp(value) {
      restartDesktopApp = value
    },
    async verify(control) {
      const local = await cloud.waitForConnectedAppDevice()
      const fixture = await installFixture(
        cloud,
        control,
        'toggle-persistence-e2e',
        local.device_id,
        workbenchReadyTimeoutMs
      )
      try {
        await hotUpdate.start(control, fixture)
        await verifyComponentTogglePersistence(control, cloud, fixture, hotUpdate)
        await verifyComponentTogglePersistence(control, cloud, fixture, hotUpdate, true)
        await verifyPluginTogglePersistence({
          control,
          cloud,
          fixture,
          restartDesktopApp,
          timeoutMs: workbenchReadyTimeoutMs,
        })
        await captureScreenshot(control, 'plugin-enabled-after-restart.png', 'body')
      } finally {
        hotUpdate.cleanup()
      }
    },
  }
}
