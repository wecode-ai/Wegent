import assert from 'node:assert/strict'
import {
  accountPlugin,
  inventory,
  openPlugin,
  testId,
  until,
} from './plugin-regression-fixture.mjs'

export async function refreshPluginInventory(control, timeoutMs = 10_000) {
  const refresh = testId('plugins-refresh-button')
  await control.command('waitFor', `${refresh}:not(:disabled)`, { timeoutMs })
  const value = await control.command('getAttribute', refresh, {
    value: 'data-reconciliation-revision',
  })
  const revision = Number(value)
  assert.ok(
    typeof value === 'string' &&
      /^\d+$/.test(value) &&
      Number.isSafeInteger(revision) &&
      revision >= 0 &&
      Number.isSafeInteger(revision + 1),
    'Plugin refresh must expose a valid non-negative reconciliation revision'
  )
  await control.command('clickWhenEnabled', refresh, { timeoutMs })
  await control.command(
    'waitFor',
    `${refresh}[data-reconciliation-revision="${revision + 1}"]:not(:disabled)`,
    { timeoutMs }
  )
}

export async function verifyPluginEnabledState(control, fixture, enabled, timeoutMs) {
  // A fresh renderer loads the composer catalog only when the real picker is
  // requested, so trigger that path before comparing its projection.
  await control.command('click', testId('new-chat-button'))
  await control.command('click', testId('composer-plugin-picker-button'))
  await control.command('waitFor', testId('composer-plugin-picker'), { timeoutMs })
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
    'Shared membership and composer did not settle to the enabled state',
    timeoutMs
  )
  const app = state.composerApps.find(plugin => plugin.pluginKey === fixture.slug)
  assert.ok(
    state.sharedInventory.installedPlugins.some(plugin => plugin.pluginKey === fixture.slug)
  )
  assert.equal(Boolean(app?.isEnabled), enabled, 'Composer disagrees with shared enabled state')
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
    await verifyPluginEnabledState(control, fixture, false, timeoutMs)
    await restartDesktopApp()
    await control.command('waitFor', testId('new-chat-button'), { timeoutMs })
    await openManager(false)
    await verifyPluginEnabledState(control, fixture, false, timeoutMs)
    // A fresh catalog read must not resurrect the previous enabled state.
    await openPlugin(control, fixture)
    await refreshPluginInventory(control, timeoutMs)
    await verifyPluginEnabledState(control, fixture, false, timeoutMs)
    await openManager(false)
    await control.command('click', toggle)
    await until(
      () => accountPlugin(cloud, fixture.slug),
      plugin => plugin?.spec.enabled === true,
      'Enabling the plugin did not persist to the backend'
    )
    await verifyPluginEnabledState(control, fixture, true, timeoutMs)
    await restartDesktopApp()
    await control.command('waitFor', testId('new-chat-button'), { timeoutMs })
    await openManager(true)
    await verifyPluginEnabledState(control, fixture, true, timeoutMs)
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
