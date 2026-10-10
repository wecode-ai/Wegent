import assert from 'node:assert/strict'
import {
  accountPlugin,
  inventory,
  openPlugin,
  testId,
  until,
} from './plugin-regression-fixture.mjs'

export async function verifyPluginEnabledState(control, fixture, enabled) {
  const state = await until(
    () => inventory(control),
    value => {
      const member = value.sharedInventory.installedPlugins.find(
        plugin => plugin.pluginKey === fixture.slug
      )
      const app = value.composerApps.find(plugin => plugin.pluginKey === fixture.slug)
      return (
        member?.enabled === enabled && (enabled ? app?.isEnabled === true : !app || !app.isEnabled)
      )
    },
    'Shared membership and composer did not settle to the enabled state'
  )
  const app = state.composerApps.find(plugin => plugin.pluginKey === fixture.slug)
  assert.ok(
    state.sharedInventory.installedPlugins.some(plugin => plugin.pluginKey === fixture.slug)
  )
  assert.equal(Boolean(app?.isEnabled), enabled, 'Composer disagrees with shared enabled state')
  await control.command('click', testId('new-chat-button'))
  await control.command('click', testId('composer-plugin-picker-button'))
  await control.command('fill', testId('composer-plugin-picker-search'), { value: fixture.slug })
  const picker = JSON.parse(await control.command('snapshot', testId('composer-plugin-picker')))
  assert.equal(
    picker.testIds.includes('composer-plugin-picker-item-plugin:' + fixture.slug),
    enabled,
    'Picker disagrees with shared enabled state'
  )
  await control.command('click', testId('composer-plugin-picker-button'))
}

export async function verifyPluginTogglePersistence({
  control,
  cloud,
  fixture,
  restartDesktopApp,
  timeoutMs,
}) {
  assert.equal(typeof restartDesktopApp, 'function', 'Checkpoint has no restart hook')
  const installed = await accountPlugin(cloud, fixture.slug)
  assert.ok(installed, 'Toggle fixture is not installed in the real account')
  const toggle = testId('installed-plugin-toggle-' + installed.metadata.labels.id)
  const openManager = async enabled => {
    await openPlugin(control, fixture)
    await control.command('click', testId('plugins-manage-button'))
    await control.command('waitFor', toggle + '[aria-checked="' + enabled + '"]')
  }
  try {
    await openManager(true)
    await control.command('click', toggle)
    await until(
      () => accountPlugin(cloud, fixture.slug),
      plugin => plugin?.spec.enabled === false,
      'Disabling the plugin did not persist to the backend'
    )
    await verifyPluginEnabledState(control, fixture, false)
    await restartDesktopApp()
    await control.command('waitFor', testId('new-chat-button'), { timeoutMs })
    await openManager(false)
    await verifyPluginEnabledState(control, fixture, false)
    // A fresh catalog read must not resurrect the previous enabled state.
    await openPlugin(control, fixture)
    await control.command('click', testId('plugins-refresh-button'))
    await control.command('waitFor', testId('plugins-refresh-button') + ':not(:disabled)', {
      timeoutMs,
    })
    await verifyPluginEnabledState(control, fixture, false)
    await openManager(false)
    await control.command('click', toggle)
    await until(
      () => accountPlugin(cloud, fixture.slug),
      plugin => plugin?.spec.enabled === true,
      'Enabling the plugin did not persist to the backend'
    )
    await verifyPluginEnabledState(control, fixture, true)
    await restartDesktopApp()
    await control.command('waitFor', testId('new-chat-button'), { timeoutMs })
    await openManager(true)
    await verifyPluginEnabledState(control, fixture, true)
  } finally {
    // Cleanup changes only the isolated test account, never personal plugins.
    const current = await accountPlugin(cloud, fixture.slug)
    if (current?.spec.enabled === false) {
      await openManager(false)
      await control.command('click', toggle)
      await until(
        () => accountPlugin(cloud, fixture.slug),
        plugin => plugin?.spec.enabled === true,
        'Failed to restore the fixture enabled state'
      )
    }
  }
}
