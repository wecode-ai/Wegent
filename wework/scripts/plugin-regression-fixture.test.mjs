import assert from 'node:assert/strict'
import { test } from 'vitest'
import { assertSurfaces } from '../e2e/desktop/modules/plugin-regression-fixture.mjs'

const plugin = { slug: 'uninstall-e2e-restart-pending', installedId: 71 }

function controlFixture({ present, managerIds }) {
  const calls = []
  return {
    calls,
    async command(action, selector) {
      calls.push({ action, selector })
      if (action === 'getComposerPluginInventoryDiagnostics') {
        const plugins = present ? [{ pluginKey: plugin.slug }] : []
        return JSON.stringify({
          sharedInventory: { installedPlugins: plugins },
          composerApps: plugins,
        })
      }
      if (action === 'snapshot') {
        return JSON.stringify({
          testIds: selector.includes('plugin-management-page-content')
            ? managerIds.map(id => `installed-plugin-row-${id}`)
            : present
              ? [`composer-plugin-picker-item-plugin:${plugin.slug}`]
              : [],
        })
      }
      if (action === 'getText') return `${plugin.slug}-retained`
      if (['click', 'waitFor', 'fill'].includes(action)) return ''
      throw new Error(`Unexpected control command: ${action}`)
    },
  }
}

test('an unrelated retained plugin does not count as the uninstalled target', async () => {
  const control = controlFixture({ present: false, managerIds: [70] })

  await assertSurfaces(control, plugin, false)

  assert.ok(control.calls.some(call => call.selector.includes('composer-plugin-picker-search')))
})

test('a target that remains in the manager still fails the uninstall assertion', async () => {
  const control = controlFixture({ present: false, managerIds: [70, plugin.installedId] })

  await assert.rejects(assertSurfaces(control, plugin, false), {
    name: 'AssertionError',
    message: /^Manager disagrees with account membership/,
  })
})

test('an unrelated retained plugin cannot satisfy target presence', async () => {
  const control = controlFixture({ present: true, managerIds: [70] })

  await assert.rejects(assertSurfaces(control, plugin, true), {
    name: 'AssertionError',
    message: /^Manager disagrees with account membership/,
  })
})

test('the manager is checked against the current installation after reinstall', async () => {
  const current = { ...plugin, installedId: 72 }
  const control = controlFixture({ present: true, managerIds: [70, current.installedId] })

  await assertSurfaces(control, current, true)

  const stale = controlFixture({ present: true, managerIds: [70, plugin.installedId] })
  await assert.rejects(assertSurfaces(stale, current, true), {
    name: 'AssertionError',
    message: /^Manager disagrees with account membership/,
  })
})

test('missing installation identity cannot silently pass an absence assertion', async () => {
  const control = controlFixture({ present: false, managerIds: [70] })

  await assert.rejects(assertSurfaces(control, { slug: plugin.slug }, false), {
    name: 'AssertionError',
    message: 'Fixture installedId must be a positive safe integer',
  })

  assert.equal(control.calls.length, 0)
})
