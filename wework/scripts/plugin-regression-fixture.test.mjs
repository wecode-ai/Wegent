import assert from 'node:assert/strict'
import { test, vi } from 'vitest'
import {
  assertSurfaces,
  installFixture,
  openPlugin,
} from '../e2e/desktop/modules/plugin-regression-fixture.mjs'
import { verifyPluginEnabledState } from '../e2e/desktop/modules/plugin-inventory-state.mjs'

const plugin = { slug: 'uninstall-e2e-restart-pending', installedId: 71 }

test.each(['home', 'marketplace', 'detail'])(
  'opens the requested marketplace row from %s without retaining an earlier detail',
  async initialPage => {
    let page = initialPage
    let filter
    let search
    const control = {
      async command(action, selector, options) {
        if (action === 'click' && selector === '[data-testid="plugins-button"]') {
          // The sidebar keeps an already-mounted plugin detail selected.
          if (page === 'home') page = 'marketplace'
        } else if (
          action === 'clickIfPresent' &&
          selector === '[data-testid="plugin-detail-back-button"]'
        ) {
          if (page === 'detail') page = 'marketplace'
        } else {
          assert.equal(page, 'marketplace', 'Plugin search is absent while a detail is selected')
          if (action === 'waitFor') assert.equal(selector, '[data-testid="plugins-search-input"]')
          else if (action === 'click') filter = selector
          else if (action === 'fill') search = options.value
          else throw new Error(`Unexpected control command: ${action}`)
        }
      },
    }

    await openPlugin(control, plugin)

    assert.equal(page, 'marketplace')
    assert.equal(filter, '[data-testid="plugins-distribution-tab-all"]')
    assert.equal(search, plugin.slug)
  }
)

function controlFixture({ present, managerIds }) {
  const calls = []
  return {
    calls,
    async command(action, selector) {
      calls.push({ action, selector })
      if (action === 'getComposerPluginInventoryDiagnostics') {
        const plugins = present ? [{ pluginKey: plugin.slug, enabled: true, isEnabled: true }] : []
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
      if (['click', 'clickWhenEnabled', 'clickIfPresent', 'waitFor', 'fill'].includes(action))
        return ''
      throw new Error(`Unexpected control command: ${action}`)
    },
  }
}

test.each(['installation', 'surfaces', 'enabled state'])(
  '%s waits for the new chat composer to mount before opening its plugin picker',
  async entry => {
    const control = controlFixture({ present: true, managerIds: [plugin.installedId] })
    const command = control.command.bind(control)
    const mounted = Promise.withResolvers()
    let mounting = false
    let finished = false
    control.command = async (action, selector, options) => {
      if (action === 'click' && selector === '[data-testid="new-chat-button"]') mounting = true
      if (mounting && selector === '[data-testid="composer-plugin-picker-button"]') {
        if (action === 'waitFor' || action === 'clickWhenEnabled') {
          await mounted.promise
          mounting = false
        }
        assert.equal(mounting, false, 'The new composer is not mounted yet')
      }
      return command(action, selector, options)
    }
    const cloud = {
      backendUrl: 'https://cloud.example',
      authToken: 'fixture-token',
      publishPluginRelease: async () => ({ pluginId: 5 }),
    }
    vi.stubGlobal('fetch', async () =>
      Response.json({
        items: [
          {
            metadata: { labels: { id: String(plugin.installedId) } },
            spec: { source: { pluginKey: plugin.slug } },
          },
        ],
      })
    )
    const verify =
      entry === 'installation'
        ? installFixture(cloud, control, plugin.slug, 'device-id', 1000)
        : entry === 'surfaces'
          ? assertSurfaces(control, plugin, true)
          : verifyPluginEnabledState(control, plugin, true, 1000)
    let failure
    const result = verify.then(
      () => {
        finished = true
      },
      error => {
        finished = true
        failure = error
      }
    )
    try {
      await vi.waitFor(() => assert.ok(mounting))
      assert.equal(finished, false, 'The picker must wait for the delayed composer')
      mounted.resolve()
      await result
      if (failure) throw failure
      assert.equal(finished, true)
    } finally {
      mounted.resolve()
      await result
      vi.unstubAllGlobals()
    }
  }
)

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
