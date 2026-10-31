import assert from 'node:assert/strict'
import { test, vi } from 'vitest'
import {
  assertSurfaces,
  installFixture,
  openPlugin,
  requestPluginExecutor,
} from '../e2e/desktop/modules/plugin-regression-fixture.mjs'
import { verifyPluginEnabledState } from '../e2e/desktop/modules/plugin-inventory-state.mjs'
import { assertRecoveredPluginInventory } from '../e2e/desktop/modules/plugin-partial-inventory-resilience.mjs'

const plugin = { slug: 'uninstall-e2e-restart-pending', installedId: 71 }

test.each([200, 401, 403, 500])(
  'uses the Electron session for plugin RPC and preserves HTTP %s',
  async status => {
    const origin = 'http://127.0.0.1:3000'
    const payload =
      status === 200 ? { ok: true, result: [] } : { ok: false, error: { code: 'probe' } }
    const command = vi.fn(async (action, selector, options) => {
      assert.equal(selector, 'body')
      if (action === 'getLocationOrigin') return origin
      assert.equal(action, 'fetchLocalRuntime')
      assert.equal(options.timeoutMs, 10_000)
      assert.deepEqual(JSON.parse(options.value), {
        url: `${origin}/wework/executor/v1/rpc`,
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'plugin-regression',
          method: 'executor.plugins.store.list',
          params: {},
        }),
        timeoutMs: 10_000,
      })
      return JSON.stringify({ status, headers: {}, body: JSON.stringify(payload) })
    })
    const fetch = vi.fn(() => {
      throw new Error('Plugin RPC must use the authenticated session')
    })
    vi.stubGlobal('fetch', fetch)
    try {
      assert.deepEqual(await requestPluginExecutor({ command }, 'executor.plugins.store.list'), {
        status,
        payload,
      })
      assert.equal(command.mock.calls.length, 2)
      assert.equal(fetch.mock.calls.length, 0)
    } finally {
      vi.unstubAllGlobals()
    }
  }
)

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
  const pickerButton = '[data-testid="composer-plugin-picker-button"]'
  let pickerExpanded = false
  return {
    calls,
    async command(action, selector, options) {
      calls.push({ action, selector })
      if (action === 'getAttribute') {
        assert.equal(selector, pickerButton)
        assert.equal(options?.value, 'aria-expanded')
        return String(pickerExpanded)
      }
      if (action === 'click' && selector === pickerButton) pickerExpanded = !pickerExpanded
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

function recoveredInventoryFixture() {
  const expected = {
    installedId: 71,
    slug: 'partial-inventory-resilience',
    deviceId: 'current-device',
    releaseId: 8,
    version: '2.0.0',
  }
  const completed = path => ({
    method: 'POST',
    path,
    status: 200,
    responseCompleted: true,
  })
  return {
    expected,
    recoveryStartIndex: 1,
    requests: [
      completed('/api/plugins/installed/auto-update-batch'),
      completed('/api/plugins/installed/auto-update-batch'),
      completed('/api/plugins/installed/sync-device'),
      completed('/api/plugins/installed/71/sync-device'),
    ],
    store: {
      ok: true,
      result: {
        supportsPluginReconciliation: true,
        plugins: [
          { installedPluginId: 70, name: 'unrelated-retained', version: '2.0.0' },
          {
            installedPluginId: 71,
            name: expected.slug,
            version: '2.0.0',
            runtimeRecoveryError: null,
          },
        ],
      },
    },
    installed: {
      metadata: { labels: { id: '71' } },
      spec: { source: { pluginKey: expected.slug }, releaseId: 8, version: '2.0.0' },
      status: {
        devices: [
          { deviceId: 'other-device', state: 'installed', desiredReleaseId: 6, actualReleaseId: 6 },
          {
            deviceId: expected.deviceId,
            state: 'installed',
            desiredReleaseId: 8,
            actualReleaseId: 8,
            errorCode: null,
          },
        ],
      },
    },
  }
}

test('complete live recovery succeeds without repopulating a cleared durable catalog', () => {
  const fixture = recoveredInventoryFixture()

  const recovered = assertRecoveredPluginInventory(fixture)

  assert.equal(recovered.completeStoreRead, true)
  assert.equal(recovered.installedId, 71)
  assert.equal(recovered.deviceId, 'current-device')
  assert.equal(recovered.version, '2.0.0')
  assert.equal(recovered.releaseId, 8)
  assert.deepEqual(recovered.completedRequests, fixture.requests.slice(fixture.recoveryStartIndex))
})

for (const [name, damage, message] of [
  [
    'failed live source',
    input => {
      input.store.ok = false
    },
    /live local inventory read failed/,
  ],
  [
    'unsupported complete source',
    input => {
      input.store.result.supportsPluginReconciliation = false
    },
    /does not support complete reconciliation/,
  ],
  [
    'incomplete live source',
    input => {
      delete input.store.result.plugins
    },
    /inventory is incomplete/,
  ],
  [
    'missing target among healthy plugins',
    input => {
      input.store.result.plugins.pop()
    },
    /missing or duplicated/,
  ],
  [
    'duplicate target',
    input => {
      input.store.result.plugins.push({ ...input.store.result.plugins[1] })
    },
    /missing or duplicated/,
  ],
  [
    'stale live package',
    input => {
      input.store.result.plugins[1].version = '1.0.0'
    },
    /old package/,
  ],
  [
    'unrecovered local package',
    input => {
      input.store.result.plugins[1].runtimeRecoveryError = 'Package unavailable'
    },
    /runtime recovery error/,
  ],
  [
    'stale account release',
    input => {
      input.installed.spec.releaseId = 6
    },
    /account release is stale/,
  ],
  [
    'another healthy device',
    input => {
      input.installed.status.devices.pop()
    },
    /no unique current-device state/,
  ],
  [
    'stale desired release',
    input => {
      input.installed.status.devices[1].desiredReleaseId = 6
    },
    /desired device release is stale/,
  ],
  [
    'stale actual release',
    input => {
      input.installed.status.devices[1].actualReleaseId = 6
    },
    /actual device release is stale/,
  ],
  [
    'device synchronization failure',
    input => {
      input.installed.status.devices[1].errorCode = 'sync_failed'
    },
    /synchronization error/,
  ],
  [
    'only earlier successful mutations',
    input => {
      input.recoveryStartIndex = input.requests.length
    },
    /complete fresh automatic-update/,
  ],
  [
    'missing request baseline',
    input => {
      delete input.recoveryStartIndex
    },
    /explicit request baseline/,
  ],
]) {
  test(`recovery rejects ${name} even when other evidence is healthy`, () => {
    const fixture = recoveredInventoryFixture()
    damage(fixture)

    assert.throws(() => assertRecoveredPluginInventory(fixture), message)
  })
}

for (const requestIndex of [1, 2, 3]) {
  test(`recovery rejects an unfinished mutation ${requestIndex} with HTTP 200 headers`, () => {
    const fixture = recoveredInventoryFixture()
    fixture.requests[requestIndex].responseCompleted = false

    assert.throws(() => assertRecoveredPluginInventory(fixture), /complete fresh automatic-update/)
  })

  test(`recovery rejects failed mutation ${requestIndex} despite old successful requests`, () => {
    const fixture = recoveredInventoryFixture()
    fixture.requests.unshift({ ...fixture.requests[requestIndex] })
    fixture.recoveryStartIndex += 1
    fixture.requests[requestIndex + 1].status = 500

    assert.throws(() => assertRecoveredPluginInventory(fixture), /complete fresh automatic-update/)
  })
}
