import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

async function loadClient() {
  let factory
  const source = await readFile(new URL('./client.js', import.meta.url), 'utf8')
  vm.runInNewContext(source, {
    window: {
      __ModuleLoader__: {
        load(entry) {
          factory = entry.factory
        },
      },
    },
  })
  assert.equal(typeof factory, 'function')
  return factory(specifier => {
    if (specifier === 'react') {
      return {
        createElement() {},
        useCallback() {},
        useEffect() {},
        useMemo() {},
        useState() {},
      }
    }
    throw new Error(`Unexpected module: ${specifier}`)
  })
}

function storage(value = null) {
  let current = value
  return {
    getItem() {
      return current
    },
    setItem(_key, next) {
      current = next
    },
    value() {
      return current
    },
  }
}

test('registers three immutable fixed tabs in one client plugin', async () => {
  const client = await loadClient()
  assert.deepEqual(
    Array.from(client.FIXED_TABS, tab => [tab.id, tab.appKind, tab.fixed]),
    [
      ['wework:tasks', 'tasks', true],
      ['wework:project-space', 'project-space', true],
      ['wework:agents', 'agents', true],
    ]
  )
  const state = client.defaultState()
  assert.equal(client.closeDynamicTab(state, 'wework:tasks'), state)
  assert.equal(client.tabsOf(state).length, 3)
})

test('shadows the stock DSH root with one Wework app registration', async () => {
  const client = await loadClient()
  const effects = []
  const registrations = []
  client.apply({
    effect(factory, label) {
      effects.push(label)
      if (label === 'wework-app: root registration') factory()
    },
    slots: {
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
  })
  assert.deepEqual(effects, ['wework-app: styles', 'wework-app: root registration'])
  assert.deepEqual(Array.from(client.inject), ['slots', 'weworkDesktop'])
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].options.name, 'root')
  assert.equal(registrations[0].options.priority, -100)
  assert.equal(typeof registrations[0].component, 'function')
})

test('restores active route and valid smart app bindings without execution state', async () => {
  const client = await loadClient()
  const now = new Date('2026-08-22T00:00:00.000Z')
  const opened = client.openSmartApp(
    client.defaultState(),
    { appId: 'review', title: '评审', route: '/smart-apps/review' },
    now
  )
  const persisted = storage()
  client.persistState(persisted, opened)
  const restored = client.restoreState(persisted)
  assert.equal(restored.activeTabId, 'smart-app:review')
  assert.deepEqual(
    {
      appKind: restored.dynamicTabs[0].binding.appKind,
      route: restored.dynamicTabs[0].binding.route,
      lastOpenedAt: restored.dynamicTabs[0].binding.lastOpenedAt,
    },
    {
      appKind: 'smart-app',
      route: '/smart-apps/review',
      lastOpenedAt: now.toISOString(),
    }
  )
  assert.equal('executionCommand' in restored.dynamicTabs[0].binding, false)
})

test('limits dynamic tabs and removes an uninstalled app', async () => {
  const client = await loadClient()
  let state = client.defaultState()
  for (let index = 0; index < client.MAX_DYNAMIC_TABS; index += 1) {
    state = client.openSmartApp(state, { appId: String(index) })
  }
  assert.throws(
    () => client.openSmartApp(state, { appId: 'overflow' }),
    /At most 20 dynamic tabs/
  )
  const removed = client.removeSmartApp(state, '0')
  assert.equal(removed.dynamicTabs.some(tab => tab.id === 'smart-app:0'), false)
})

test('drops corrupted and duplicate persisted bindings', async () => {
  const client = await loadClient()
  const value = JSON.stringify({
    version: 1,
    activeTabId: 'missing',
    dynamicTabs: [
      {
        id: 'smart-app:valid',
        title: 'Valid',
        binding: {
          version: 1,
          tabId: 'smart-app:valid',
          appKind: 'smart-app',
          route: '/valid',
          lastOpenedAt: '2026-08-22T00:00:00.000Z',
        },
      },
      {
        id: 'smart-app:valid',
        title: 'Duplicate',
        binding: {
          version: 1,
          tabId: 'smart-app:valid',
          appKind: 'smart-app',
          route: '/duplicate',
          lastOpenedAt: '2026-08-22T00:00:00.000Z',
        },
      },
      {
        id: 'wework:tasks',
        title: 'Invalid fixed shadow',
        binding: {
          version: 1,
          tabId: 'wework:tasks',
          appKind: 'smart-app',
          route: '/invalid',
          lastOpenedAt: 'invalid',
        },
      },
    ],
  })
  const restored = client.restoreState(storage(value))
  assert.equal(restored.activeTabId, 'wework:tasks')
  assert.equal(Array.from(restored.dynamicTabs, tab => tab.title).join(','), 'Valid')
})

test('allows only one writer tab for a Codex thread and releases the lease on close', async () => {
  const client = await loadClient()
  let state = client.openSmartApp(client.defaultState(), {
    appId: 'thread-primary',
    codexThreadId: 'thread-1',
  })
  state = client.openSmartApp(state, {
    appId: 'thread-secondary',
    codexThreadId: 'thread-1',
  })

  const primary = client.claimThreadWrite(state, 'smart-app:thread-primary')
  assert.equal(primary.writable, true)
  const denied = client.claimThreadWrite(primary.state, 'smart-app:thread-secondary')
  assert.deepEqual(
    {
      writable: denied.writable,
      ownerTabId: denied.ownerTabId,
      reason: denied.reason,
    },
    {
      writable: false,
      ownerTabId: 'smart-app:thread-primary',
      reason: 'thread_write_leased',
    }
  )

  const closed = client.closeDynamicTab(primary.state, 'smart-app:thread-primary')
  const secondary = client.claimThreadWrite(closed, 'smart-app:thread-secondary')
  assert.equal(secondary.writable, true)
  assert.equal(secondary.ownerTabId, 'smart-app:thread-secondary')
})
