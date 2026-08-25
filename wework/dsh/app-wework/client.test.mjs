import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

async function loadClient() {
  let factory
  const surface = {
    childNodes: [],
    dataset: {},
    style: {},
    tagName: 'DIV',
    setAttribute() {},
    replaceChildren() {
      this.childNodes = []
    },
  }
  const document = {
    body: {
      children: [],
      style: {},
      append(node) {
        this.children.push(node)
        if (node === surface) document.surfaceAttached = true
      },
    },
    documentElement: { style: {} },
    getElementById() {
      return { style: {} }
    },
    querySelector() {
      return document.surfaceAttached ? surface : null
    },
    createElement() {
      return surface
    },
    surface,
    surfaceAttached: false,
  }
  const window = {
    __WEWORK_DSH_EXTENSION_FRAME_HOST__: {
      show() {},
      hide() {},
    },
    __ModuleLoader__: {
      load(entry) {
        factory = entry.factory
      },
    },
  }
  const source = await readFile(new URL('./client.js', import.meta.url), 'utf8')
  vm.runInNewContext(source, {
    document,
    HTMLElement: Object,
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    queueMicrotask,
    structuredClone,
    window,
  })
  assert.equal(typeof factory, 'function')
  const client = factory(specifier => {
    if (specifier === 'react') {
      class Component {
        constructor(props) {
          this.props = props
          this.state = {}
        }
      }
      return {
        Component,
        createElement(type, props, ...children) {
          return { type, props: { ...props, children } }
        },
        useCallback() {},
        useEffect() {},
        useMemo() {},
        useState() {},
      }
    }
    if (specifier === 'react-dom/client') {
      return {
        createRoot(container) {
          return {
            render(element) {
              container.element = element
              container.childNodes = [element]
            },
            unmount() {
              container.unmounted = true
            },
          }
        },
      }
    }
    throw new Error(`Unexpected module: ${specifier}`)
  })
  client.__testDocument = document
  return client
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

test('publishes Wework extensions independently from the application renderer', async () => {
  const client = await loadClient()
  const effects = []
  const provided = []
  client.apply({
    effect(factory, label) {
      effects.push(label)
      if (label !== 'wework-app: styles') factory()
    },
    provide(name, service) {
      provided.push({ name, service })
      return () => {}
    },
  })
  assert.deepEqual(effects, ['wework-app: extension bridge cleanup', 'wework-app: styles'])
  assert.deepEqual(Array.from(client.inject), [
    'weworkDesktop',
    'sessions',
    'connection',
    'workspaces',
  ])
  assert.equal(provided[0].name, 'wework')
  assert.equal(provided[0].service.protocol, 'wework.host.v1')
  assert.equal(provided[0].service.extensions.protocol, 'wework.extensions.v1')
  assert.deepEqual(Array.from(provided[0].service.extensions.extensionPoints), [
    'wework.workspace.sidebar.tab',
  ])
  assert.equal('sidebar' in provided[0].service.extensions, false)
  assert.equal(provided[1].name, 'betterSidebar')
  assert.equal(provided[1].service.version, '0.15.2-wework.1')
})

test('queues better-sidebar registrations and reattaches them to the Wework host', async () => {
  const client = await loadClient()
  const bridge = client.createBetterSidebarBridge({ sessions: { marker: 'real-context' } })
  const descriptor = {
    id: 'qa:ask',
    title: 'Ask',
    component(props) {
      return { type: 'qa-component', props }
    },
  }
  const dispose = bridge.service.registerTab(descriptor)
  const firstRegistered = []
  const firstDisposed = []
  const firstHost = {
    register(extensionPoint, value) {
      assert.equal(extensionPoint, 'wework.workspace.sidebar.tab')
      firstRegistered.push(value)
      return () => firstDisposed.push(value.id)
    },
  }
  const firstSidebarHost = {
    subscribeState() {
      return () => {}
    },
  }
  bridge.attachHost(firstHost, firstSidebarHost)
  assert.equal(firstRegistered[0].id, descriptor.id)
  assert.equal(firstRegistered[0].component, undefined)
  assert.equal(typeof firstRegistered[0].mount, 'function')
  const container = { dataset: {} }
  const mounted = firstRegistered[0].mount(container, {
    ctx: {},
    store: {},
    scope: { sessionId: 'session-1' },
    tab: { id: 'tab-1', type: descriptor.id, title: 'Ask' },
    visible: true,
  })
  const renderedChild = client.__testDocument.surface.element.props.children[0]
  assert.equal(renderedChild.type, descriptor.component)
  assert.equal(renderedChild.props.ctx.sessions.marker, 'real-context')
  assert.equal(renderedChild.props.store.getSnapshot().state.panelOpen, true)
  mounted.dispose()
  assert.equal(client.__testDocument.surface.unmounted, true)

  const secondRegistered = []
  bridge.attachHost(
    {
      register(extensionPoint, value) {
        assert.equal(extensionPoint, 'wework.workspace.sidebar.tab')
        secondRegistered.push(value)
        return () => {}
      },
    },
    {
      subscribeState() {
        return () => {}
      },
    }
  )
  assert.deepEqual(firstDisposed, ['qa:ask'])
  assert.equal(secondRegistered[0].id, descriptor.id)
  assert.equal(bridge.context.sessions.marker, 'real-context')

  dispose()
  assert.equal(bridge.service.getTabs().length, 0)
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
  assert.throws(() => client.openSmartApp(state, { appId: 'overflow' }), /At most 20 dynamic tabs/)
  const removed = client.removeSmartApp(state, '0')
  assert.equal(
    removed.dynamicTabs.some(tab => tab.id === 'smart-app:0'),
    false
  )
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
